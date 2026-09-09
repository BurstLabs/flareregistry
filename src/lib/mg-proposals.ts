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
  { type: "function", name: "getProposalInfo", stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "address" }, { type: "bool" },
              { type: "uint256" }, { type: "uint256" }] },
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
}

export interface MgProposalView extends MgProposal {
  open: boolean;
  /** Votes needed for the turnout floor, given the group size when read. */
  quorumNeeded: number;
  quorumMet: boolean;
  majorityMet: boolean;
  outcome: "open" | "pending" | "accepted" | "rejected" | "noQuorum";
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
  const empty = { name: null, subject: null, summary: null, url: null };
  const attempt = (s: string) => {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
      return { name: str("name"), subject: str("address"), summary: str("description"), url: str("url") };
    } catch {
      return null;
    }
  };
  const direct = attempt(raw.trim());
  if (direct) return direct;
  // Single-quoted variant. Only quotes sitting against a structural character are rewritten, so an
  // apostrophe inside a sentence is left alone: "DevOp's identities" must not become a parse error
  // or, worse, a silently truncated value.
  const coerced = raw
    .trim()
    .replace(/\{\s*'/g, '{"')
    .replace(/'\s*\}/g, '"}')
    .replace(/'\s*:/g, '":')
    .replace(/:\s*'/g, ':"')
    .replace(/'\s*,/g, '",')
    .replace(/,\s*'/g, ',"');
  return attempt(coerced) ?? empty;
}

let cache: { at: number; data: MgProposal[] } | null = null;
const TTL_MS = 120_000;

/** Every proposal on chain, newest first. Cached briefly so a page render is not 50 RPC calls. */
export async function fetchMgProposals(): Promise<MgProposal[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const client = createPublicClient({ transport: http(FLARE_RPC) });
  const address = (await client.readContract({
    address: CONTRACT_REGISTRY, abi: registryAbi,
    functionName: "getContractAddressByName", args: ["PollingManagementGroup"],
  })) as Address;

  // No enumeration function exists on the contract, so ids are walked from 1 until one is missing.
  // Cheap: there are 13 of them after a year, and the whole walk is cached.
  const out: MgProposal[] = [];
  for (let id = 1; id < 500; id++) {
    let info: readonly [bigint, string, boolean, bigint, bigint];
    try {
      info = (await client.readContract({
        address, abi: pollingAbi, functionName: "getProposalInfo", args: [BigInt(id)],
      })) as readonly [bigint, string, boolean, bigint, bigint];
    } catch {
      break; // reverted: walked past the last one
    }
    const [, proposer, , startTs, endTs] = info;
    // getProposalInfo does NOT revert for an id that was never used, it returns zeros, so the walk
    // ran to the loop bound and invented a hundred empty proposals. An unset vote window is the
    // reliable end marker.
    if (startTs === 0n && endTs === 0n) break;
    const [raw, votes, chainState] = await Promise.all([
      client.readContract({ address, abi: pollingAbi, functionName: "getProposalDescription", args: [BigInt(id)] }) as Promise<string>,
      client.readContract({ address, abi: pollingAbi, functionName: "getProposalVotes", args: [BigInt(id)] }) as Promise<readonly [bigint, bigint]>,
      client.readContract({ address, abi: pollingAbi, functionName: "state", args: [BigInt(id)] }).catch(() => 0) as Promise<number>,
    ]);
    const parsed = parseProposalDescription(raw);
    out.push({
      id, ...parsed, raw,
      proposer: proposer.toLowerCase(),
      voteStartAt: new Date(Number(startTs) * 1000).toISOString(),
      voteEndAt: new Date(Number(endTs) * 1000).toISOString(),
      votesFor: Number(votes[0]),
      votesAgainst: Number(votes[1]),
      chainState: Number(chainState),
    });
  }
  out.reverse();
  cache = { at: Date.now(), data: out };
  return out;
}

/**
 * Label a proposal from its clock and its votes, never from the contract's state enum.
 *
 * The enum's values are not documented anywhere we control and only two of them have been observed
 * in the wild, so mapping the rest would be guesswork printed as fact. Times and vote counts are
 * unambiguous and are what the thresholds are actually applied to.
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
  const outcome: MgProposalView["outcome"] =
    now < start ? "pending"
      : open ? "open"
        : !quorumMet ? "noQuorum"
          : majorityMet ? "accepted" : "rejected";
  return {
    ...p, open, quorumNeeded, quorumMet, majorityMet, outcome,
    portalUrl: `${PORTAL_BASE}/${p.id}-0x1e91a59aac440d7eca5ebf58d85903cdb0021812`,
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
