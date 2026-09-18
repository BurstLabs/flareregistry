// WHO voted on a Management Group proposal, and WHEN.
//
// The tally on a proposal card answers "how many", which is the least useful of the three questions
// a member actually has while a vote is running. A proposal opens with no delay, runs 48 hours and
// dies without quorum, so the operative question is "who has not voted yet", and the answer to that
// has never been published anywhere: Flare's own portal shows the counts and nothing else.
//
// Two events carry the whole answer, and both exist on EVERY deployment we read:
//
//   VoteCast(indexed voter, indexed proposalId, support, forVotePower, againstVotePower)
//   ManagementGroupProposalCreated(indexed proposalId, proposer, description, voteStart, voteEnd,
//                                 thresholdConditionBIPS, majorityConditionBIPS, eligibleMembers[], accept)
//
// The creation event settles something the rest of this module used to have to guess at. src/lib/
// mg-proposals.ts says "the contract does not record how many were eligible when a given proposal
// ran, so for anything already decided we have no honest denominator", and therefore refuses to
// print a quorum bar on a decided proposal. That was true of the contract's FUNCTIONS and false of
// its LOGS: eligibleMembers is the exact roster at creation, thresholdConditionBIPS the exact bar.
// So a proposal from April can now be shown against April's group instead of against today's.
//
// SOURCED FROM THE BLOCK EXPLORER, not from the RPC, and that is not a shortcut. Flare's public RPC
// caps eth_getLogs at THIRTY blocks, so reading a 48-hour vote window (about 96,000 blocks) would
// take some 3,200 sequential requests. The explorer's log endpoint serves the same logs over a
// 100,000-block range in one call and returns the block timestamp inline, which is the field the
// timeline is built from and which eth_getLogs does not carry at all. Our own archive node has no
// such cap, but it is on the LAN and production is not, so it cannot be the production source.

import { getAddress, decodeAbiParameters, createPublicClient, http, type Address } from "viem";
import { prisma } from "@/lib/db";
import { fetchMgProposals, outcomeOf, type MgProposalView } from "./mg-proposals";

const EXPLORER_API = process.env.FLARE_EXPLORER_API ?? "https://flare-explorer.flare.network/api";
const FLARE_RPC = process.env.FLARE_RPC_URL ?? "https://flare-api.flare.network/ext/C/rpc";

// keccak256 of each signature. Pinned as constants rather than derived at runtime so a rename in a
// future deployment fails loudly here instead of silently returning an empty roster.
const TOPIC_VOTE_CAST =
  "0x5272ea0ffb2aa83ab5b7fcaa2d8a959323e41f6ece4cced28718d18793843b66";
const TOPIC_MG_CREATED =
  "0x923005bb5ef14dba42b1107183c9bfda810961232be2193dabf917a6f1797c8a";
// The retired PollingFtso names its creation event differently AND drops the trailing `accept`
// bool. Same seven leading fields, so one decoder handles both once the tail is optional.
// Verified against the live contract: this topic returns exactly 23 logs from
// 0x461c4219d5fcAF0fEA304F57a4b0f8061f08064A, which is exactly the 23 proposals it holds.
const TOPIC_FTSO_CREATED =
  "0x1986b4feedb3f25a75bf9c91113b849b8d51d82294b3129bb2dc1ec49f377208";

/** One member's vote, as the chain recorded it. */
export interface MgVote {
  /** Lowercased address that cast it. */
  voter: string;
  /** True for a vote in favour. The contract encodes support as 1 for and 0 against. */
  inFavour: boolean;
  /** Unix seconds, from the block the vote landed in. */
  at: number;
  txHash: string;
}

/** The group as it stood when a proposal was created, which is the group that had to turn out. */
export interface MgRoster {
  /** Lowercased eligible member addresses, snapshotted at creation. */
  eligible: string[];
  thresholdBips: number;
  majorityBips: number;
}

export interface ProposalParticipation {
  roster: MgRoster | null;
  votes: MgVote[];
}

/** Key a proposal by deployment AND id: ids restart at 1 on every contract. */
export function participationKey(contract: string, id: number): string {
  return `${contract.toLowerCase()}:${id}`;
}

interface ExplorerLog {
  address: string;
  topics: (string | null)[];
  data: string;
  blockNumber: string;
  timeStamp: string;
  transactionHash: string;
}

/**
 * Every log of one topic from one contract since a given block, paged BY BLOCK RANGE.
 *
 * THE `page` PARAMETER DOES NOTHING ON THIS ENDPOINT. It is accepted and ignored: page 1, page 2 and
 * page 20 of the retired PollingFtso's VoteCast logs are byte for byte the same 1,000 rows, checked
 * against the live explorer. The loop that used to live here asked for twenty of them, so it
 *
 *   - pulled the same 1,000 rows twenty times, 14 MB per sweep of pure duplication,
 *   - never saw a short page, so it always ran all twenty rounds,
 *   - inserted every one of those votes twenty times, which is why /proposals showed "1080 in
 *     favour" on proposals where 54 members voted, every inflated tally an exact multiple of 20,
 *   - and still MISSED 41 votes, because the real total is 1,041 and it never got past the first
 *     thousand.
 *
 * The cap is on rows per response, so the way past it is to move the window: take the highest block
 * the response reached and ask again from there. That block is re-read, deliberately, because a
 * block can hold several of these and stopping one past it would drop the rest; the merge is
 * idempotent, so reading it twice costs nothing. If the window cannot advance at all, one block
 * holds a full page by itself and we stop rather than spin.
 */
async function fetchLogs(address: string, topic0: string, fromBlock: number): Promise<ExplorerLog[]> {
  const out: ExplorerLog[] = [];
  const OFFSET = 1000;
  let cursor = fromBlock;
  for (let round = 1; round <= 40; round++) {
    const url =
      `${EXPLORER_API}?module=logs&action=getLogs&fromBlock=${cursor}&toBlock=latest` +
      `&address=${address}&topic0=${topic0}&page=1&offset=${OFFSET}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const json = (await res.json()) as { status: string; result?: ExplorerLog[] };
    const rows = Array.isArray(json.result) ? json.result : [];
    out.push(...rows);
    if (rows.length < OFFSET) break;
    let furthest = cursor;
    for (const r of rows) {
      const b = Number(BigInt(r.blockNumber));
      if (b > furthest) furthest = b;
    }
    if (furthest <= cursor) break;
    cursor = furthest;
  }
  return out;
}

/** topics[1] and topics[2] are the indexed voter and proposal id. */
function decodeVoteCast(log: ExplorerLog): { id: number; vote: MgVote } | null {
  const voterTopic = log.topics[1];
  const idTopic = log.topics[2];
  if (!voterTopic || !idTopic) return null;
  try {
    const [support] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }],
      log.data as `0x${string}`
    );
    return {
      id: Number(BigInt(idTopic)),
      vote: {
        voter: getAddress(`0x${voterTopic.slice(26)}`).toLowerCase(),
        // 1 is in favour, 0 against. Cross-checked against getProposalVotes on the two live
        // proposals: 28 logs with support 1, and the contract reports 28 for and 0 against.
        inFavour: Number(support) === 1,
        at: Number(BigInt(log.timeStamp)),
        txHash: log.transactionHash,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Decode a creation event of either shape.
 *
 * PollingManagementGroup appends a `bool accept` that PollingFtso does not have. Decoding the seven
 * leading fields alone would throw on the longer payload, so the nine-field shape is tried first
 * and the eight-field one is the fallback. Both carry eligibleMembers in the same position.
 */
function decodeCreated(log: ExplorerLog): { id: number; roster: MgRoster } | null {
  const idTopic = log.topics[1];
  if (!idTopic) return null;
  const head = [
    { type: "address" }, { type: "string" }, { type: "uint256" }, { type: "uint256" },
    { type: "uint256" }, { type: "uint256" }, { type: "address[]" },
  ] as const;
  for (const shape of [[...head, { type: "bool" }] as const, head]) {
    try {
      const d = decodeAbiParameters(shape as never, log.data as `0x${string}`) as unknown[];
      const eligible = (d[6] as string[]).map((a) => a.toLowerCase());
      return {
        id: Number(BigInt(idTopic)),
        roster: {
          eligible,
          thresholdBips: Number(d[4] as bigint),
          majorityBips: Number(d[5] as bigint),
        },
      };
    } catch {
      // try the shorter shape
    }
  }
  return null;
}

/**
 * WHAT HAS ALREADY BEEN READ, per deployment, so a refresh only has to ask for what is new.
 *
 * Re-reading from block 1 every time cost 28 paged requests and 20,828 rows, 15 MB decoded, per
 * sweep, and 95% of it was one scan: VoteCast on the retired PollingFtso, twenty full pages of
 * history that has not changed since 2025. Asking for the tail instead collapses that to nine
 * requests, most of them a 52-byte "no logs found" in about 0.2s, all measured against the live
 * explorer before this was written.
 *
 * Held per process rather than in Postgres. A restart pays for one full read, which is the same
 * thing it paid for before on every single sweep.
 */
const scanned = new Map<string, { upTo: number; data: Map<number, ProposalParticipation> }>();

/**
 * How far back before the high-water mark each refresh re-reads.
 *
 * Not paranoia: the explorer indexes a block some time after the chain has it, so a scan that
 * started exactly where the last one stopped would step over anything indexed in between and never
 * look again. Flare blocks are about 1.8 seconds, so 300 blocks is roughly nine minutes of slack
 * against a 60-second refresh. Re-reading it is free because merging is idempotent: a proposal's
 * roster is set from its creation log, and a member can vote at most once per proposal, which the
 * contract enforces with `!hasVoted[voter]`.
 */
const OVERLAP_BLOCKS = 300;

/** Participation for every proposal on one deployment, keyed by id. */
async function loadContract(address: string): Promise<Map<number, ProposalParticipation>> {
  const prev = scanned.get(address);
  const from = prev ? Math.max(1, prev.upTo - OVERLAP_BLOCKS) : 1;

  const [voteLogs, mgCreated, ftsoCreated] = await Promise.all([
    fetchLogs(address, TOPIC_VOTE_CAST, from),
    fetchLogs(address, TOPIC_MG_CREATED, from),
    fetchLogs(address, TOPIC_FTSO_CREATED, from),
  ]);

  // COPIED, NOT MUTATED. The previous map is what /proposals is rendering from while this runs in
  // the background, and a render that iterated a votes array mid-merge would paint a roster nobody
  // ever voted into. Copy, merge, then publish the copy.
  const out = new Map<number, ProposalParticipation>();
  for (const [id, e] of prev?.data ?? []) out.set(id, { roster: e.roster, votes: [...e.votes] });

  const entry = (id: number) => {
    let e = out.get(id);
    if (!e) { e = { roster: null, votes: [] }; out.set(id, e); }
    return e;
  };
  // Who is already recorded, per proposal. A Set rather than scanning the array per vote: the first
  // read of a process merges 20,000 of them, and `votes.some()` inside that loop is quadratic.
  const voted = new Map<number, Set<string>>();
  for (const [id, e] of out) voted.set(id, new Set(e.votes.map((v) => v.voter)));

  for (const log of [...mgCreated, ...ftsoCreated]) {
    const d = decodeCreated(log);
    if (d) entry(d.id).roster = d.roster;
  }
  const touched = new Set<number>();
  for (const log of voteLogs) {
    const d = decodeVoteCast(log);
    if (!d) continue;
    let seen = voted.get(d.id);
    if (!seen) { seen = new Set(); voted.set(d.id, seen); }
    if (seen.has(d.vote.voter)) continue;
    seen.add(d.vote.voter);
    entry(d.id).votes.push(d.vote);
    touched.add(d.id);
  }
  for (const id of touched) out.get(id)!.votes.sort((a, b) => a.at - b.at);

  // The furthest block this deployment has been read to. Only ever forwards, and only over logs
  // that actually arrived: a refresh that returns nothing leaves the mark where it was, so the
  // next one asks the same question rather than skipping the gap.
  let upTo = prev?.upTo ?? 0;
  for (const log of [...voteLogs, ...mgCreated, ...ftsoCreated]) {
    const b = Number(BigInt(log.blockNumber));
    if (Number.isFinite(b) && b > upTo) upTo = b;
  }
  scanned.set(address, { upTo, data: out });
  return out;
}


// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
//
// Same shape as fetchMgProposals: a short TTL plus in-flight dedupe. /proposals is force-dynamic
// and linked from the nav, so without the dedupe a cold cache hit by three visitors at once fires
// three full sweeps of four deployments. 60 seconds rather than the proposal list's 120, because
// the only thing here that moves is a vote arriving during an open window, and being a minute stale
// about the very number a member is watching is the one staleness this page cannot afford.
//
// SERVED STALE WHILE IT REVALIDATES, because the sweep is expensive and somebody was paying for it.
// Measured on the box: the sweep is 28 paged explorer requests carrying 20,828 log rows and takes
// 5.6 seconds, while the rest of the page takes about 0.2. Under a plain TTL the first request to
// arrive after each expiry waited for all of it, so /proposals served 0.15s to everyone except one
// visitor a minute, who got 5 to 8 seconds. Sampled at 4-second intervals it is unmistakable:
// 0.15, 0.15, 0.20, 4.96, 0.14, ... 0.13, 7.61, 0.15.
//
// Nobody waits now. An expired cache is returned as it stands and the sweep runs behind it, so the
// worst case is a roster one cycle older than it might have been. That is safe by this page's own
// design: /proposals reconciles every tally with the contract's own numbers, which are read on the
// RPC in 0.17s and are NOT served stale, and it takes the higher count per side, so a lagging log
// sweep can only ever under-report WHO voted, never the count. A vote is final once cast, so the
// roster catches up on the next cycle and never has to walk anything back.
const TTL_MS = 60_000;
/** After a failed sweep, wait this long before the next request may start another. */
const FAIL_COOLDOWN_MS = 15_000;
let cache: { at: number; data: Map<string, ProposalParticipation> } | null = null;
let inFlight: Promise<Map<string, ProposalParticipation>> | null = null;
let cooldownUntil = 0;

async function loadAll(contracts: string[]): Promise<Map<string, ProposalParticipation>> {
  const merged = new Map<string, ProposalParticipation>();
  const perContract = await Promise.all(
    // One failing deployment must not blank the other three. An empty map for that contract
    // degrades to "no participation data for these proposals", which the UI renders as a hidden
    // section rather than as a wrong roster.
    // A failure keeps whatever that deployment was last read to rather than dropping to empty: the
    // rosters we already have are still true, and blanking them would hide a section over one bad
    // response. With nothing read yet it is empty, which the UI renders as no roster at all.
    contracts.map((c) =>
      loadContract(c).catch(
        () => scanned.get(c)?.data ?? new Map<number, ProposalParticipation>()
      )
    )
  );
  contracts.forEach((c, i) => {
    for (const [id, p] of perContract[i]) merged.set(participationKey(c, id), p);
  });
  return merged;
}

function startSweep(contracts: string[]): Promise<Map<string, ProposalParticipation>> {
  const p = loadAll(contracts)
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .catch((err) => {
      // A failure must not turn into a sweep per request against an explorer already in trouble.
      cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
      // Keep serving what we have. With nothing to serve, the caller has to hear about it: the
      // page catches this and renders the proposals without their rosters.
      if (cache) return cache.data;
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = p;
  return p;
}

/** Participation for every proposal on every deployment, keyed `${contract}:${id}`. */
export async function fetchParticipation(
  contracts: string[]
): Promise<Map<string, ProposalParticipation>> {
  if (cache) {
    // Expired only means "start the next sweep", never "make this visitor wait for it".
    if (Date.now() - cache.at >= TTL_MS && !inFlight && Date.now() >= cooldownUntil) {
      void startSweep(contracts);
    }
    return cache.data;
  }
  // Cold, which is once per process rather than once a minute. There is nothing to serve, so this
  // request does have to wait for the sweep.
  return inFlight ?? startSweep(contracts);
}

// ---------------------------------------------------------------------------
// Putting a name to an address
// ---------------------------------------------------------------------------

/** A member as the page shows them: a name and a logo where we have one, an address always. */
export interface MemberRef {
  /** Lowercased. Always present; everything else may be null. */
  addr: string;
  name: string | null;
  logoURI: string | null;
  /** The address to link to on our own directory, when this member is listed with us. */
  href: string | null;
}

/**
 * Resolve member addresses to registry listings.
 *
 * This is the whole reason the feature is worth building here rather than read off Flare's portal,
 * which shows these as bare hex. Two paths, and BOTH are needed:
 *
 *   1. Via the entity. A member votes with their entity's IDENTITY address, but their listing with
 *      us may be held under any of the entity's five role addresses, so the join goes voter ->
 *      ProviderOnchain -> any of its five addresses -> ProviderAddress -> Provider. Same path
 *      managementGroupByProvider walks, for the same reason.
 *   2. Direct. The voter address IS the listed address. This catches members whose ProviderOnchain
 *      row no longer exists, which is most of the historical group: the entity deregistered and
 *      the snapshot went with it, but the listing and its name are still here.
 *
 * Measured over the union of every roster we read, 159 addresses across 44 proposals: path 1 alone
 * resolves 73, path 2 alone resolves 78, and the two sets turn out to be DISJOINT, so together they
 * name 151. Running only the entity path, as the first version of this did, left 93 members
 * rendering as hex.
 *
 * ARCHIVED PROVIDERS ARE INCLUDED, deliberately. A member of the 2024 group who has since departed
 * is exactly the case the historical rosters are full of, and their name is what makes an old vote
 * readable. They keep the name and lose the link, since the directory has no page for them.
 */
export async function resolveMembers(addresses: string[]): Promise<Map<string, MemberRef>> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, MemberRef>(
    wanted.map((a) => [a, { addr: a, name: null, logoURI: null, href: null }])
  );
  if (!wanted.length) return out;

  const select = {
    address: true,
    provider: { select: { name: true, logoURI: true, logoPath: true, archivedAt: true } },
  } as const;
  type Row = { address: string; provider: { name: string; logoURI: string | null; logoPath: string | null; archivedAt: Date | null } };

  const apply = (ref: MemberRef | undefined, r: Row) => {
    // First listing wins, except that a LIVE listing always displaces an archived one.
    if (!ref) return;
    if (ref.name && !(ref.href === null && !r.provider.archivedAt)) return;
    ref.name = r.provider.name;
    ref.logoURI = r.provider.logoURI ?? r.provider.logoPath ?? null;
    ref.href = r.provider.archivedAt ? null : r.address.toLowerCase();
  };

  // PHASE 1, and it must come first. The member's own address is a listed address. Resolving this
  // before anything else is not a preference: the two phases DISAGREE, because an address can be
  // both a member's identity and some other entity's registered role address, and the earlier
  // single-map version of this let phase 2 overwrite phase 1 for 57 of 159 members. Their own
  // listing is the right answer for a member every time.
  const directRows = (await prisma.providerAddress.findMany({
    where: { address: { in: wanted } },
    select,
  })) as Row[];
  for (const r of directRows) apply(out.get(r.address.toLowerCase()), r);

  // PHASE 2, for whoever is left. The member's listing is held under one of their entity's OTHER
  // role addresses, so go voter -> ProviderOnchain -> its five addresses -> ProviderAddress.
  const unresolved = wanted.filter((a) => !out.get(a)?.name);
  if (!unresolved.length) return out;

  const entities = await prisma.providerOnchain.findMany({
    where: { voter: { in: unresolved } },
    select: {
      voter: true, delegationAddress: true, submitAddress: true,
      submitSignaturesAddress: true, signingPolicyAddress: true,
    },
  });
  // Many-to-many on purpose: one role address can belong to more than one unresolved member here,
  // and dropping either of them is how phase 1's bug happened in the first place.
  const votersByRole = new Map<string, string[]>();
  for (const e of entities) {
    for (const a of [
      e.delegationAddress, e.submitAddress,
      e.submitSignaturesAddress, e.signingPolicyAddress,
    ]) {
      if (!a) continue;
      const key = a.toLowerCase();
      const list = votersByRole.get(key);
      if (list) list.push(e.voter.toLowerCase());
      else votersByRole.set(key, [e.voter.toLowerCase()]);
    }
  }
  if (!votersByRole.size) return out;

  const roleRows = (await prisma.providerAddress.findMany({
    where: { address: { in: [...votersByRole.keys()] } },
    select,
  })) as Row[];
  for (const r of roleRows) {
    for (const voter of votersByRole.get(r.address.toLowerCase()) ?? []) apply(out.get(voter), r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Members the group may currently evict
// ---------------------------------------------------------------------------

/**
 * A current member whom `PollingManagementGroup.removeMember` would accept today.
 *
 * Removal is PERMISSIONLESS. Read from the contract source rather than assumed: removeMember takes
 * one address, requires only that it is a current member, and then removes it if any one of three
 * grounds holds. It never looks at msg.sender, which is why anyone can call it for anyone, and why
 * the batch in mg-remove-all-button can route the same calls through Multicall3.
 *
 * The flags come from `scripts/ingest-mg-eligibility.mjs`, which SIMULATES the call rather than
 * reimplementing the three grounds, and stores the contract's verbatim verdict in mgRemoveVerdict.
 * The cron runs every six hours, so this is a candidate list and not an authority: every button
 * built on it simulates again immediately before sending.
 */
export interface RemovableMember {
  addr: string;
  /** chilled | no-rewards | non-participation, as classified by the ingest. */
  reason: string | null;
  missedVotes: number | null;
  relevantProposals: number | null;
  missedVotesLimit: number | null;
  epochsSinceReward: number | null;
}

export async function fetchRemovableMembers(): Promise<RemovableMember[]> {
  const rows = await prisma.providerOnchain.findMany({
    // managementGroup TRUE is load-bearing, not belt and braces: removeMember reverts for anyone
    // who is not a current member, and a stale mgRemovable on a departed entity would otherwise
    // offer a button that can only fail.
    where: { network: "flare", managementGroup: true, mgRemovable: true },
    select: {
      voter: true, mgRemoveReason: true, mgMissedVotes: true,
      mgRelevantProposals: true, mgMissedVotesLimit: true, mgEpochsSinceReward: true,
    },
  });
  // Deduplicated by voter. One entity can hold more than one row here, and offering the same
  // member twice in a batch would send a second call that reverts on the first one's success.
  const seen = new Set<string>();
  const out: RemovableMember[] = [];
  for (const r of rows) {
    const addr = r.voter.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push({
      addr,
      reason: r.mgRemoveReason,
      missedVotes: r.mgMissedVotes,
      relevantProposals: r.mgRelevantProposals,
      missedVotesLimit: r.mgMissedVotesLimit,
      epochsSinceReward: r.mgEpochsSinceReward,
    });
  }
  return out;
}

/** A removable member with their listing attached, ready for MgRemovablePanel. */
export interface RemovableMemberView extends RemovableMember {
  name: string | null;
  logoURI: string | null;
  href: string | null;
}

/**
 * The removable set, named. Both /proposals and the provider page show the same panel, so the join
 * lives here rather than being done twice slightly differently.
 */
export async function fetchRemovableMemberViews(): Promise<RemovableMemberView[]> {
  const removable = await fetchRemovableMembers();
  if (!removable.length) return [];
  const refs = await resolveMembers(removable.map((m) => m.addr));
  return removable
    .map((m) => {
      const ref = refs.get(m.addr);
      return { ...m, name: ref?.name ?? null, logoURI: ref?.logoURI ?? null, href: ref?.href ?? null };
    })
    // Named first and alphabetical, so the list reads as businesses rather than as a hex dump.
    .sort((a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿"));
}


// ---------------------------------------------------------------------------
// One provider's voting record
// ---------------------------------------------------------------------------
//
// PER ENTITY, NEVER PER ADDRESS, and that is the whole difficulty. The two polling generations
// identify a member by DIFFERENT ROLE ADDRESSES: PollingManagementGroup lists identity addresses
// and PollingFtso listed delegation addresses. Their rosters therefore share not one address in
// common (checked: 62 and 58 members, zero overlap), and a record matched on the identity address
// alone would report that every provider sat out the entire FTSO era. They are the same providers.
//
// So the caller passes every address the entity holds and a proposal counts as theirs if ANY of
// them is in its snapshot. The same set catches a vote cast through a proxy, which would otherwise
// read as an absence.
//
// A proposal with no creation event gives no snapshot, and without a snapshot there is no way to
// say whether this provider was entitled to vote. Those are skipped rather than counted as either
// attendance or absence.


export interface VotingRecordRow {
  /** `${contract}:${id}`, which is also the fragment /proposals uses. */
  key: string;
  contract: string;
  id: number;
  name: string | null;
  voteStartAt: string;
  voteEndAt: string;
  outcome: MgProposalView["outcome"];
  /** null where they did not vote at all. */
  inFavour: boolean | null;
  /** Hours after the window opened, when the vote was cast. */
  hoursIn: number | null;
}

export interface VotingRecord {
  /** Newest first, which is how the page reads it. */
  rows: VotingRecordRow[];
  eligible: number;
  voted: number;
}

export async function fetchVotingRecord(addresses: string[]): Promise<VotingRecord> {
  const mine = new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()));
  if (!mine.size) return { rows: [], eligible: 0, voted: 0 };

  const proposals = await fetchMgProposals();
  const participation = await fetchParticipation([
    ...new Set(proposals.map((p) => p.contract)),
  ]);
  const now = new Date();

  const rows: VotingRecordRow[] = [];
  for (const p of proposals) {
    const part = participation.get(participationKey(p.contract, p.id));
    if (!part?.roster) continue;
    if (!part.roster.eligible.some((a) => mine.has(a))) continue;
    const vote = part.votes.find((v) => mine.has(v.voter)) ?? null;
    const startMs = new Date(p.voteStartAt).getTime();
    rows.push({
      key: participationKey(p.contract, p.id),
      contract: p.contract,
      id: p.id,
      name: p.name,
      voteStartAt: p.voteStartAt,
      voteEndAt: p.voteEndAt,
      outcome: outcomeOf(p, now),
      inFavour: vote ? vote.inFavour : null,
      hoursIn: vote ? Math.max(0, (vote.at * 1000 - startMs) / 3_600_000) : null,
    });
  }
  rows.sort((a, b) => b.voteEndAt.localeCompare(a.voteEndAt));
  return {
    rows,
    eligible: rows.length,
    voted: rows.filter((r) => r.inFavour !== null).length,
  };
}
