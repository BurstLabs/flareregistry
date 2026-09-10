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
 * Every log of one topic from one contract, paged.
 *
 * The explorer caps a response at 1,000 entries and PollingFtso alone has more VoteCast logs than
 * that, so a single unpaged call silently truncates the oldest deployment's votes. Paging stops at
 * the first short page, and hard-stops at 20 pages so a misbehaving endpoint cannot spin forever.
 */
async function fetchLogs(address: string, topic0: string): Promise<ExplorerLog[]> {
  const out: ExplorerLog[] = [];
  const OFFSET = 1000;
  for (let page = 1; page <= 20; page++) {
    const url =
      `${EXPLORER_API}?module=logs&action=getLogs&fromBlock=1&toBlock=latest` +
      `&address=${address}&topic0=${topic0}&page=${page}&offset=${OFFSET}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const json = (await res.json()) as { status: string; result?: ExplorerLog[] };
    const rows = Array.isArray(json.result) ? json.result : [];
    out.push(...rows);
    if (rows.length < OFFSET) break;
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

/** Participation for every proposal on one deployment, keyed by id. */
async function loadContract(address: string): Promise<Map<number, ProposalParticipation>> {
  const [voteLogs, mgCreated, ftsoCreated] = await Promise.all([
    fetchLogs(address, TOPIC_VOTE_CAST),
    fetchLogs(address, TOPIC_MG_CREATED),
    fetchLogs(address, TOPIC_FTSO_CREATED),
  ]);

  const out = new Map<number, ProposalParticipation>();
  const entry = (id: number) => {
    let e = out.get(id);
    if (!e) { e = { roster: null, votes: [] }; out.set(id, e); }
    return e;
  };
  for (const log of [...mgCreated, ...ftsoCreated]) {
    const d = decodeCreated(log);
    if (d) entry(d.id).roster = d.roster;
  }
  for (const log of voteLogs) {
    const d = decodeVoteCast(log);
    if (d) entry(d.id).votes.push(d.vote);
  }
  for (const e of out.values()) e.votes.sort((a, b) => a.at - b.at);
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

const TTL_MS = 60_000;
let cache: { at: number; data: Map<string, ProposalParticipation> } | null = null;
let inFlight: Promise<Map<string, ProposalParticipation>> | null = null;

async function loadAll(contracts: string[]): Promise<Map<string, ProposalParticipation>> {
  const merged = new Map<string, ProposalParticipation>();
  const perContract = await Promise.all(
    // One failing deployment must not blank the other three. An empty map for that contract
    // degrades to "no participation data for these proposals", which the UI renders as a hidden
    // section rather than as a wrong roster.
    contracts.map((c) => loadContract(c).catch(() => new Map<number, ProposalParticipation>()))
  );
  contracts.forEach((c, i) => {
    for (const [id, p] of perContract[i]) merged.set(participationKey(c, id), p);
  });
  return merged;
}

/** Participation for every proposal on every deployment, keyed `${contract}:${id}`. */
export async function fetchParticipation(
  contracts: string[]
): Promise<Map<string, ProposalParticipation>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inFlight) return inFlight;
  inFlight = loadAll(contracts)
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
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
