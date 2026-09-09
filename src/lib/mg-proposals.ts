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
  /** Which deployment this id belongs to. Ids restart per contract, so this is half the key. */
  contract: string;
}

export interface MgProposalView extends MgProposal {
  open: boolean;
  /** Votes needed for the turnout floor, given the group size when read. */
  quorumNeeded: number;
  quorumMet: boolean;
  majorityMet: boolean;
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
 * Pull proposer and vote window out of getProposalInfo WITHOUT pinning a tuple.
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
 */
function readProposalInfo(words: readonly bigint[]): {
  proposer: string; startTs: bigint; endTs: bigint;
} | null {
  const LOW = 1_400_000_000n; // 2014, before any of this existed
  const HIGH = 4_000_000_000n; // 2096
  let startTs = 0n, endTs = 0n;
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (a >= LOW && a <= HIGH && b > a && b <= HIGH) { startTs = a; endTs = b; break; }
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
  return { proposer, startTs, endTs };
}

let cache: { at: number; data: MgProposal[] } | null = null;
// SHARED so concurrent cold requests do not each walk the chain. The page is force-dynamic and
// linked from the nav, so a cache miss can be hit by several visitors at once; without this each
// one fired its own ~180 RPC calls at the public Flare endpoint. Measured cold: 10.7 seconds.
let inFlight: Promise<MgProposal[]> | null = null;
const TTL_MS = 120_000;

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
  const client = createPublicClient({ transport: http(FLARE_RPC) });

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

  for (let base = 1; base <= MAX_ID; base += BATCH) {
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
        const [raw, votes, chainState] = await Promise.all([
          client.readContract({ address, abi: pollingAbi, functionName: "getProposalDescription", args: [BigInt(id)] }).catch(() => "") as Promise<string>,
          client.readContract({ address, abi: pollingAbi, functionName: "getProposalVotes", args: [BigInt(id)] }).catch(() => [0n, 0n] as const) as Promise<readonly [bigint, bigint]>,
          client.readContract({ address, abi: pollingAbi, functionName: "state", args: [BigInt(id)] }).catch(() => 0) as Promise<number>,
        ]);
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
      });
    }
    // A gap inside the batch means the end: ids are assigned sequentially and never reused.
    if (live.length < ids.length) break;
  }
  out.sort((a, b) => b.id - a.id);
  return out;
}


/**
 * Label a proposal, and refuse to apply TODAY's quorum to a vote held months ago.
 *
 * The quorum is a share of the group, and the group changes size: it was 48 members three weeks ago
 * and is 49 now. The contract does not record how many were eligible when a given proposal ran, so
 * for anything already decided we have no honest denominator. Printing "47 of the 33 votes needed"
 * against an April vote is both bad arithmetic and bad English.
 *
 * So the quorum bar is computed only while a proposal is OPEN, where today's group is the group
 * that has to turn out. A decided proposal is labelled ACCEPTED only on the contract's own state
 * value 4, which has been cross-checked against the portal for all eleven of them, and otherwise
 * just CLOSED. Vague and true beats precise and wrong, and the portal is one click away.
 */
export function deriveOutcome(
  p: MgProposal, memberCount: number, now: Date,
  thresholdBips: number, majorityBips: number
): MgProposalView {
  const start = new Date(p.voteStartAt), end = new Date(p.voteEndAt);
  const quorumNeeded = Math.ceil((thresholdBips / 10000) * memberCount);
  const cast = p.votesFor + p.votesAgainst;
  const quorumMet = cast >= quorumNeeded;
  const majorityMet = cast > 0 && p.votesFor * 10000 >= majorityBips * cast;
  const open = now >= start && now < end;
  // 4 is the only decided value observed on chain, and it matched "Accepted" on the portal for
  // every proposal carrying it. Anything else decided is reported without a claim about why.
  const outcome: MgProposalView["outcome"] =
    now < start ? "pending" : open ? "open" : p.chainState === 4 ? "accepted" : "closed";
  return {
    ...p, open, quorumNeeded, quorumMet, majorityMet, outcome,
    // Keyed by id AND contract, because ids restart on each deployment.
    portalUrl: `${PORTAL_BASE}/${p.id}-${p.contract}`,
  };
}

/** The live thresholds and fee, read from the contract rather than hardcoded. */
export async function fetchMgProposalSettings(): Promise<{
  thresholdBips: number; majorityBips: number; feeWei: string;
}> {
  const client = createPublicClient({ transport: http(FLARE_RPC) });
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
    const client = createPublicClient({ transport: http(FLARE_RPC) });
    const a = (await client.readContract({
      address: CONTRACT_REGISTRY, abi: registryAbi,
      functionName: "getContractAddressByName", args: ["PollingManagementGroup"],
    })) as Address;
    return a && a !== "0x0000000000000000000000000000000000000000" ? a : null;
  } catch {
    return null;
  }
}
