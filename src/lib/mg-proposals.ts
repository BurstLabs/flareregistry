// Flare's on-chain Management Group PROPOSALS, read for display.
//
// The MG votes on protocol changes and on reports about providers through PollingManagementGroup,
// resolved from the same fixed ContractRegistry we use for membership. Everything here is READ
// ONLY: this module never builds a transaction and never asks anyone to sign one.
//
// WHY THE SITE CARRIES THIS AT ALL. A proposal opens with ZERO voting delay, runs for exactly 48
// hours, and needs 66% of the group to turn out. Miss the window and you did not abstain, you were
// absent, and the proposal fails for want of quorum whatever the members thought of it. Today the
// only notice is somebody pasting a portal link into Telegram and hoping the right people are
// awake. Reading the chain and showing what is open, with the clock and the turnout against the
// bar it has to clear, is the whole point.

import { createPublicClient, http, type Address } from "viem";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as Address;
const FLARE_RPC = process.env.FLARE_RPC_URL ?? "https://flare-api.flare.network/ext/C/rpc";

/** Flare's portal, where a member actually casts the vote. We link out; we do not proxy it. */
export const PORTAL_BASE = "https://portal.flare.network/managementProposal/view";

const registryAbi = [
  { type: "function", name: "getContractAddressByName", stateMutability: "view",
    inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
] as const;

// Verified against the live contract at 0x1e91A59aaC440D7ecA5EBf58d85903CdB0021812 rather than
// taken from an interface file: getProposalInfo returns five static words and the two that matter
// are the vote window, which is how the countdown is derived.
const pollingAbi = [
  { type: "function", name: "getProposalDescription", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "getProposalVotes", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  // Decoded as a bag of words on purpose: see readProposalInfo. The two contract generations
  // return DIFFERENT tuples from this name, and pinning either one loses the other's proposals.
  { type: "function", name: "getProposalInfo", stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" },
              { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
              { type: "uint256" }] },
  { type: "function", name: "state", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "hasVoted", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "canPropose", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "proposalFeeValueWei", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "thresholdConditionBIPS", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "majorityConditionBIPS", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface MgProposal {
  id: number;
  /** Parsed from the description when it is well formed; nulls when it is not. */
  name: string | null;
  subject: string | null;
  summary: string | null;
  url: string | null;
  /** The description exactly as it sits on chain, for anything we could not parse. */
  raw: string;
  proposer: string;
  voteStartAt: string;
  voteEndAt: string;
  votesFor: number;
  votesAgainst: number;
  /** Raw contract state, carried but never used to label anything. See deriveOutcome. */
  chainState: number;
  /**
   * TRUE for an ordinary proposal, FALSE for a REJECTION vote, which inverts everything.
   *
   * `_proposalSucceeded` returns `!_proposal.accept` when a condition fails and takes its majority
   * from `accept ? forVotePower : againstVotePower`. So on a rejection vote the proposal stands
   * unless the group both turns out AND votes against: missing quorum is how it PASSES, and the
   * side that has to clear 50% is the votes against. Ten of the twenty-one Management Group
   * proposals are this kind, including one that passed with no votes at all.
   */
  accept: boolean;
  /** Which deployment this id belongs to. Ids restart per contract, so this is half the key. */
  contract: string;
}

export interface MgProposalView extends MgProposal {
  open: boolean;
  /** Votes needed for the turnout floor, against eligibleCount. */
  quorumNeeded: number;
  /** How many members were entitled to vote: the creation snapshot where we have one. */
  eligibleCount: number;
  /** Whether quorumNeeded rests on the right denominator and may therefore be shown. */
  quorumKnown: boolean;
  quorumMet: boolean;
  /**
   * Votes needed on the DECIDING side to clear the majority bar, given the votes cast so far.
   * That is votes in favour on an ordinary proposal and votes against on a rejection vote.
   */
  majorityNeeded: number;
  majorityMet: boolean;
  /** The proposal's OWN conditions, snapshotted at creation, not today's settings. */
  thresholdBips: number;
  majorityBips: number;
  outcome: "open" | "pending" | "accepted" | "closed";
  portalUrl: string;
}

/**
 * Parse the JSON blob members put in a proposal description.
 *
 * PROPER JSON, and it is not merely a preference: proposals 9, 10 and 11 carry valid JSON with
 * double quotes, and only the two typed by hand into the portal textarea use single quotes. So the
 * established convention IS valid JSON and the odd ones out are the recent manual entries.
 *
 * We still read the single-quoted form, because refusing to display two live proposals over a
 * quoting slip would be absurd. Reading it is not the same as producing it: anything this site
 * ever emits will be strict JSON.
 */
export function parseProposalDescription(raw: string): {
  name: string | null; subject: string | null; summary: string | null; url: string | null;
} {
  const text = raw.trim();
  // 1. The correct form. Proposals 1 to 11 on the current contract are valid JSON, and anything
  //    this site ever emits will be too.
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
    if (str("name") || str("description")) {
      return { name: str("name"), subject: str("address"), summary: str("description"), url: str("url") };
    }
  } catch {
    // fall through
  }
  // 2. Everything else. The historical descriptions were typed by hand into a textarea over two
  //    years and it shows: straight single quotes, curly quotes from a word processor, a
  //    capitalised Name key, keys with no quotes at all, and combinations of those inside one
  //    string. Rather than try to repair such a thing into valid JSON, pull each field out
  //    directly. Reading junk tolerantly is not the same as producing it.
  const norm = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const field = (key: string): string | null => {
    const re = new RegExp(
      `["']?${key}["']?\\s*:\\s*["']([^"']*)["']`,
      "i"
    );
    const m = norm.match(re);
    return m ? m[1].trim() || null : null;
  };
  // 3. No quotes at all, on either keys or values: {name:Best FTSO,address:0x..,url:https://..}.
  //    Three of the oldest proposals look like this, one of them with backslashes where the quotes
  //    should be. Read each value up to the next known key or the closing brace, which is the only
  //    delimiter these strings actually have, and which a url full of colons and slashes survives.
  const KEYS = ["name", "address", "description", "url"];
  const loose = (key: string): string | null => {
    const next = KEYS.join("|");
    const re = new RegExp(
      `[\\\\"']?${key}[\\\\"']?\\s*:\\s*[\\\\"']?(.*?)[\\\\"']?\\s*(?=,\\s*[\\\\"']?(?:${next})[\\\\"']?\\s*:|\\}\\s*$)`,
      "is"
    );
    const m = norm.match(re);
    return m ? m[1].trim() || null : null;
  };
  return {
    name: field("name") ?? loose("name"),
    subject: field("address") ?? loose("address"),
    summary: field("description") ?? loose("description"),
    url: field("url") ?? loose("url"),
  };
}

/**
 * Every contract that has held Management Group proposals.
 *
 * Proposal ids RESTART AT 1 on each deployment, and Flare's portal keys a proposal by id AND
 * contract, which is why its URLs look like /view/13-0x1e91a5... Reading only the contract the
 * registry currently points at therefore shows the newest 13 and silently drops the other 31.
 *
 * The registry resolves a NAME to ONE address, the live one, and keeps no history, so the retired
 * deployments cannot be discovered from it. These two were found through the block explorer's
 * contract-name search and confirmed by reading their proposals. They are pinned rather than
 * discovered because a retired contract never changes again; a NEW deployment, by contrast, is
 * picked up automatically through the registry.
 */
const HISTORIC_POLLING_CONTRACTS: Address[] = [
  "0x55233A9Ed066621e02b166C416f804b04ee4a03a", // PollingManagementGroup, retired: 7 proposals
  "0x461c4219d5fcAF0fEA304F57a4b0f8061f08064A", // PollingFtso, retired: 23 proposals
];

/** Registry names to resolve for CURRENT deployments. Both have carried proposals. */
const REGISTRY_NAMES = ["PollingManagementGroup", "PollingFtso"];

/**
 * Pull proposer, vote window and the ACCEPT FLAG out of getProposalInfo WITHOUT pinning a tuple.
 *
 * The two generations of this contract return different things from the same function name. The
 * current one gives (uint256, address, bool, start, end); the retired PollingFtso gives
 * (uint256, address, start, end, thresholdBips, majorityBips, eligibleMembers). Pinning either
 * shape silently drops every proposal held by the other, which is how 24 of the 44 went missing.
 *
 * So the return is decoded as plain words and the fields are recognised by what they look like: a
 * unix timestamp in a plausible range followed by a larger one is the vote window, and the first
 * word that fits in 20 bytes without being a timestamp is the proposer. Ugly, and much harder to
 * break than a guessed ABI: a third generation with yet another layout still reads correctly as
 * long as it returns these values at all.
 *
 * `accept` is read the same way. In the Management Group shape it is the word immediately before
 * the vote window, and a bool is 0 or 1, which nothing else in either layout looks like: PollingFtso
 * has the PROPOSER there, a 20-byte number. The guard is that a proposer was found elsewhere, so a
 * hypothetical zero-address proposer cannot be mistaken for `accept = false`. PollingFtso has no
 * such field at all (its source does not contain the word), and its success test is the plain form,
 * so defaulting to true is correct there rather than merely safe.
 */
function readProposalInfo(words: readonly bigint[]): {
  proposer: string; startTs: bigint; endTs: bigint; accept: boolean;
} | null {
  const LOW = 1_400_000_000n; // 2014, before any of this existed
  const HIGH = 4_000_000_000n; // 2096
  let startTs = 0n, endTs = 0n, startAt = -1;
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (a >= LOW && a <= HIGH && b > a && b <= HIGH) { startTs = a; endTs = b; startAt = i; break; }
  }
  if (startTs === 0n) return null;
  const MAX_ADDR = (1n << 160n) - 1n;
  let proposer = "0x0000000000000000000000000000000000000000";
  for (const w of words) {
    if (w > HIGH && w <= MAX_ADDR) {
      proposer = "0x" + w.toString(16).padStart(40, "0");
      break;
    }
  }
  const flag = startAt > 0 ? words[startAt - 1] : null;
  const accept =
    proposer !== "0x0000000000000000000000000000000000000000" && (flag === 0n || flag === 1n)
      ? flag === 1n
      : true;
  return { proposer, startTs, endTs, accept };
}

let cache: { at: number; data: MgProposal[] } | null = null;
// SHARED so concurrent cold requests do not each walk the chain. The page is force-dynamic and
// linked from the nav, so a cache miss can be hit by several visitors at once; without this each
// one fired its own ~180 RPC calls at the public Flare endpoint. Measured cold: 10.7 seconds.
let inFlight: Promise<MgProposal[]> | null = null;
// Matched to mg-votes' TTL. These two modules describe the same votes and are rendered side by
// side, so different lifetimes guarantee they disagree for part of every cycle. The reconciliation
// in /proposals covers the remaining skew; this keeps the window small rather than relying on it.
const TTL_MS = 60_000;

/** Every proposal across every deployment, newest first. Cached briefly; this is ~44 reads. */
export async function fetchMgProposals(): Promise<MgProposal[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inFlight) return inFlight;
  inFlight = loadAllProposals()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function loadAllProposals(): Promise<MgProposal[]> {
  const client = createPublicClient({ transport: http(FLARE_RPC, { batch: true }) });

  const current = await Promise.all(
    REGISTRY_NAMES.map((name) =>
      client
        .readContract({
          address: CONTRACT_REGISTRY, abi: registryAbi,
          functionName: "getContractAddressByName", args: [name],
        })
        .catch(() => null)
    )
  );
  const contracts = [
    ...current.filter((a): a is Address => !!a && a !== "0x0000000000000000000000000000000000000000"),
    ...HISTORIC_POLLING_CONTRACTS,
  ];

  const perContract = await Promise.all(contracts.map((address) => readContract(client, address)));
  const out = perContract.flat();
  // Newest first ACROSS deployments. Ids are only meaningful within one contract, so the vote
  // window is the only ordering that means anything here.
  out.sort((a, b) => b.voteStartAt.localeCompare(a.voteStartAt));
  return out;
}

/**
 * A PROPOSAL THAT HAS CLOSED CANNOT CHANGE, so it is read once and kept.
 *
 * The walk was re-reading all 45 of them every 60 seconds: 207 RPC calls and 3.6 seconds, paid by
 * whichever visitor arrived first after the cache expired. Nothing in a closed proposal can move.
 * Its description is set at creation; `_storeVote` only accepts a vote inside the window, so the
 * tallies are final; and `state()` is computed from those tallies against thresholds snapshotted
 * into the proposal, so it settles when the window does. Ids are sequential and never reused, so
 * the only reads a refresh actually needs are the proposals still open and a probe past the highest
 * id seen.
 *
 * Keyed `${address}:${id}` because ids restart on every deployment.
 */
const settled = new Map<string, MgProposal>();
/** The highest id seen per deployment, so probing starts past it instead of at 1. */
const highestId = new Map<string, number>();

/**
 * A read that REPORTS its failure while still returning something usable.
 *
 * Every read in this walk swallows its own error and substitutes a fallback, which keeps the page
 * up when the RPC is unhappy and is the right call for rendering. It is the wrong call for deciding
 * a proposal is final: the public endpoint answers 429 under load, and a proposal whose
 * getProposalVotes came back as the fallback [0, 0] looks exactly like a proposal nobody voted on.
 * Freezing that into the settled store would make a moment's throttling permanent. Measured while
 * verifying this change: one run took 102 failures out of 292 requests and still returned all 45
 * proposals, 8 of them with the wrong contents.
 */
async function guarded<T>(p: Promise<T>, fallback: T, fail: { any: boolean }): Promise<T> {
  try {
    return await p;
  } catch {
    fail.any = true;
    return fallback;
  }
}

/** One deployment's proposals. Ids are probed in batches; a gap ends the walk. */
async function readContract(
  client: ReturnType<typeof createPublicClient>,
  address: Address
): Promise<MgProposal[]> {
  // BATCHED. No enumeration function exists, so ids are walked from 1, but walking them ONE AT A
  // TIME cost 10.7 seconds cold across the four deployments: roughly 180 sequential round trips to
  // a public RPC. Ids are dense and start at 1, so a batch can be probed at once and the walk stops
  // at the first gap. getProposalInfo does NOT revert for an unused id, it returns zeros, so an
  // unset vote window is the end marker rather than a thrown error.
  const BATCH = 10;
  const MAX_ID = 500; // a guard against an infinite walk, not an expected limit
  const out: MgProposal[] = [];
  const key = (id: number) => `${address.toLowerCase()}:${id}`;
  const now = Date.now();
  /** Whether every read behind a proposal actually answered. Only a complete one may be frozen. */
  const complete = new Map<number, boolean>();

  // What is already final. Everything below the highest id seen is either in here or is still open,
  // and the open ones fall through to the reads below.
  const known = highestId.get(address.toLowerCase()) ?? 0;
  const reread: number[] = [];
  for (let id = 1; id <= known; id++) {
    const done = settled.get(key(id));
    if (done) out.push(done);
    else reread.push(id);
  }

  for (let base = known + 1; base <= MAX_ID; base += BATCH) {
    const ids = Array.from({ length: BATCH }, (_, k) => base + k);
    const infos = await Promise.all(
      ids.map((id) =>
        client
          .readContract({ address, abi: pollingAbi, functionName: "getProposalInfo", args: [BigInt(id)] })
          .then((w) => readProposalInfo(w as readonly bigint[]))
          .catch(() => null)
      )
    );
    const live = ids.filter((_, i) => infos[i] !== null);
    const details = await Promise.all(
      live.map(async (id) => {
        const fail = { any: false };
        const [raw, votes, chainState] = await Promise.all([
          guarded(client.readContract({ address, abi: pollingAbi, functionName: "getProposalDescription", args: [BigInt(id)] }) as Promise<string>, "", fail),
          guarded(client.readContract({ address, abi: pollingAbi, functionName: "getProposalVotes", args: [BigInt(id)] }) as Promise<readonly [bigint, bigint]>, [0n, 0n] as const, fail),
          guarded(client.readContract({ address, abi: pollingAbi, functionName: "state", args: [BigInt(id)] }) as Promise<number>, 0, fail),
        ]);
        complete.set(id, !fail.any);
        return { id, raw, votes, chainState };
      })
    );
    for (const d of details) {
      const info = infos[ids.indexOf(d.id)]!;
      out.push({
        id: d.id,
        ...parseProposalDescription(d.raw),
        raw: d.raw,
        contract: address.toLowerCase(),
        proposer: info.proposer,
        voteStartAt: new Date(Number(info.startTs) * 1000).toISOString(),
        voteEndAt: new Date(Number(info.endTs) * 1000).toISOString(),
        votesFor: Number(d.votes[0]),
        votesAgainst: Number(d.votes[1]),
        chainState: Number(d.chainState),
        accept: info.accept,
      });
    }
    // A gap inside the batch means the end: ids are assigned sequentially and never reused.
    if (live.length < ids.length) break;
  }

  // The ones already known to exist but not yet final. No id probing, no gap logic: they are read
  // straight, all of them at once, because there are never many.
  if (reread.length) {
    const rows = await Promise.all(reread.map((id) => readOne(client, address, id)));
    for (const r of rows) {
      if (!r) continue;
      complete.set(r.p.id, r.complete);
      out.push(r.p);
    }
  }

  for (const p of out) {
    const id = `${address.toLowerCase()}:${p.id}`;
    if (!highestId.has(address.toLowerCase()) || p.id > (highestId.get(address.toLowerCase()) ?? 0)) {
      highestId.set(address.toLowerCase(), p.id);
    }
    // Settled only once the window has CLOSED, so the final read is the one taken after the close:
    // state() flips at that moment, and a proposal frozen a second early would keep "Open" forever.
    //
    // AND ONLY IF THE READ CAME BACK WHOLE. Every read here swallows its own failure (`.catch`
    // returning "" for the description and 0 for the state), which was harmless while the walk
    // re-read everything every 60 seconds and self-healed. Freezing such a row would make one
    // transient RPC hiccup permanent for the life of the process: a proposal stuck with a blank
    // description or no outcome, and no way back. A test run caught exactly that, one proposal in
    // 45 differing from the full walk on a re-read, so it is not hypothetical.
    if (!settled.has(id) && complete.get(p.id) === true && new Date(p.voteEndAt).getTime() <= now) {
      settled.set(id, p);
    }
  }

  out.sort((a, b) => b.id - a.id);
  return out;
}

/** One proposal, read whole. The same four reads the batch walk does, for an id already known. */
async function readOne(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  id: number
): Promise<{ p: MgProposal; complete: boolean } | null> {
  const fail = { any: false };
  const info = await client
    .readContract({ address, abi: pollingAbi, functionName: "getProposalInfo", args: [BigInt(id)] })
    .then((w) => readProposalInfo(w as readonly bigint[]))
    .catch(() => null);
  if (!info) return null;
  const [raw, votes, chainState] = await Promise.all([
    guarded(client.readContract({ address, abi: pollingAbi, functionName: "getProposalDescription", args: [BigInt(id)] }) as Promise<string>, "", fail),
    guarded(client.readContract({ address, abi: pollingAbi, functionName: "getProposalVotes", args: [BigInt(id)] }) as Promise<readonly [bigint, bigint]>, [0n, 0n] as const, fail),
    guarded(client.readContract({ address, abi: pollingAbi, functionName: "state", args: [BigInt(id)] }) as Promise<number>, 0, fail),
  ]);
  const p: MgProposal = {
    id,
    ...parseProposalDescription(raw),
    raw,
    contract: address.toLowerCase(),
    proposer: info.proposer,
    voteStartAt: new Date(Number(info.startTs) * 1000).toISOString(),
    voteEndAt: new Date(Number(info.endTs) * 1000).toISOString(),
    votesFor: Number(votes[0]),
    votesAgainst: Number(votes[1]),
    chainState: Number(chainState),
    accept: info.accept,
  };
  return { p, complete: !fail.any };
}


/**
 * Label a proposal against the group that actually had to turn out for it.
 *
 * This function used to say the contract "does not record how many were eligible when a given
 * proposal ran, so for anything already decided we have no honest denominator", and it therefore
 * printed no quorum bar on a decided proposal. That was true of the contract's FUNCTIONS and false
 * of its LOGS. Every deployment emits its creation event with the full `eligibleMembers` array and
 * the `thresholdConditionBIPS` and `majorityConditionBIPS` in force at the time, so the honest
 * denominator was on chain all along. src/lib/mg-votes.ts reads it.
 *
 * So `snapshot`, when supplied, is the group as it stood at creation and takes precedence over
 * every live figure. It is not a refinement: the two differ TODAY. The group has 50 members as this
 * is written and the two open proposals were created with 49, because someone joined after they
 * opened and cannot vote on them. Counting them in the denominator would understate turnout against
 * a bar they can never help clear.
 *
 * Without a snapshot the behaviour is unchanged and deliberately conservative: today's group for an
 * open vote, and no bar at all for a decided one, because applying today's quorum to an April vote
 * is arithmetic about the wrong denominator. A decided proposal is labelled ACCEPTED only on the
 * contract's own state value 4, cross-checked against the portal, and otherwise just CLOSED.
 */
export function deriveOutcome(
  p: MgProposal, memberCount: number, now: Date,
  thresholdBips: number, majorityBips: number,
  snapshot?: { eligible: number; thresholdBips: number; majorityBips: number } | null
): MgProposalView {
  const start = new Date(p.voteStartAt), end = new Date(p.voteEndAt);
  const eligibleCount = snapshot?.eligible ?? memberCount;
  const threshold = snapshot?.thresholdBips ?? thresholdBips;
  const majority = snapshot?.majorityBips ?? majorityBips;
  const quorumNeeded = Math.ceil((threshold / 10000) * eligibleCount);
  const cast = p.votesFor + p.votesAgainst;
  const quorumMet = cast >= quorumNeeded;
  // WHICH SIDE HAS TO CLEAR THE BAR depends on the kind of proposal. _proposalSucceeded reads
  //     (_proposal.accept ? forVotePower : againstVotePower)
  //         <= majorityConditionBIPS.mulDiv(forVotePower + againstVotePower, MAX_BIPS)
  // so an ordinary proposal needs votes FOR and a rejection vote is defeated by votes AGAINST.
  // Measuring the for side on a rejection vote was wrong on half the Management Group's proposals.
  const decidingVotes = p.accept ? p.votesFor : p.votesAgainst;
  // STRICTLY more than the share, and the share is FLOORED: `<=` is a defeat and mulDiv rounds
  // down, so the votes needed are floor(majority * cast / 10000) + 1. This test once read
  // `votesFor * 10000 >= majority * cast`, which is "at least half" and differs from the contract
  // at exactly the tie: 20 for and 20 against passed it and is a defeat on chain.
  const majorityNeeded = Math.floor((majority * cast) / 10000) + 1;
  const majorityMet = cast > 0 && decidingVotes >= majorityNeeded;
  const open = now >= start && now < end;
  // 4 is the only decided value observed on chain, and it matched "Accepted" on the portal for
  // every proposal carrying it. Anything else decided is reported without a claim about why.
  const outcome: MgProposalView["outcome"] =
    now < start ? "pending" : open ? "open" : p.chainState === 4 ? "accepted" : "closed";
  return {
    ...p, open, quorumNeeded, quorumMet, majorityNeeded, majorityMet, outcome,
    eligibleCount,
    thresholdBips: threshold,
    majorityBips: majority,
    // Only a snapshot lets a DECIDED proposal be measured honestly. Without one the card shows no
    // bar rather than one built on today's group.
    quorumKnown: !!snapshot || open,
    // Keyed by id AND contract, because ids restart on each deployment.
    portalUrl: `${PORTAL_BASE}/${p.id}-${p.contract}`,
  };
}

/** The live thresholds and fee, read from the contract rather than hardcoded. */
export async function fetchMgProposalSettings(): Promise<{
  thresholdBips: number; majorityBips: number; feeWei: string;
}> {
  const client = createPublicClient({ transport: http(FLARE_RPC, { batch: true }) });
  const address = (await client.readContract({
    address: CONTRACT_REGISTRY, abi: registryAbi,
    functionName: "getContractAddressByName", args: ["PollingManagementGroup"],
  })) as Address;
  const [t, m, f] = await Promise.all([
    client.readContract({ address, abi: pollingAbi, functionName: "thresholdConditionBIPS" }) as Promise<bigint>,
    client.readContract({ address, abi: pollingAbi, functionName: "majorityConditionBIPS" }) as Promise<bigint>,
    client.readContract({ address, abi: pollingAbi, functionName: "proposalFeeValueWei" }) as Promise<bigint>,
  ]);
  return { thresholdBips: Number(t), majorityBips: Number(m), feeWei: f.toString() };
}

/**
 * The deployment a NEW proposal goes to.
 *
 * Always resolved from the registry rather than pinned: the retired contracts are read-only history
 * and nothing should ever be submitted to one.
 */
export async function currentPollingContract(): Promise<string | null> {
  try {
    const client = createPublicClient({ transport: http(FLARE_RPC, { batch: true }) });
    const a = (await client.readContract({
      address: CONTRACT_REGISTRY, abi: registryAbi,
      functionName: "getContractAddressByName", args: ["PollingManagementGroup"],
    })) as Address;
    return a && a !== "0x0000000000000000000000000000000000000000" ? a : null;
  } catch {
    return null;
  }
}

/**
 * What the SIGNED-IN viewer may do, resolved on the server so the page paints its final state.
 *
 * Without this the client rendered optimistically and then corrected itself: vote buttons appeared
 * for a moment and vanished once the eligibility read landed, and the proposal form sat grey saying
 * it was still checking. A control that appears and then withdraws is worse than one that arrives a
 * moment late, because the reader has already started moving towards it.
 *
 * Keyed to the session address. The client only trusts this when the wallet actually connected
 * matches, so a stale or mismatched session cannot grant anyone a button they should not have.
 */
export async function viewerProposalState(
  viewer: string | null,
  openProposals: { id: number; contract: string }[]
): Promise<{ address: string; canPropose: boolean; votedIds: string[] } | null> {
  if (!viewer) return null;
  try {
    const client = createPublicClient({ transport: http(FLARE_RPC, { batch: true }) });
    const current = await currentPollingContract();
    const canPropose = current
      ? ((await client.readContract({
          address: current as Address, abi: pollingAbi, functionName: "canPropose", args: [viewer as Address],
        })) as boolean)
      : false;
    const voted = await Promise.all(
      openProposals.map(async (p) => {
        try {
          const has = (await client.readContract({
            address: p.contract as Address, abi: pollingAbi, functionName: "hasVoted",
            args: [BigInt(p.id), viewer as Address],
          })) as boolean;
          return has ? `${p.contract}:${p.id}` : null;
        } catch {
          return null;
        }
      })
    );
    return {
      address: viewer.toLowerCase(),
      canPropose,
      votedIds: voted.filter((v): v is string => v !== null),
    };
  } catch {
    return null;
  }
}
