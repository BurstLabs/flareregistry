// Governance: the new-provider flag and Management Group vote mechanism.
// Full spec: docs/governance-flag-mechanism.md. This module holds the constants, the quorum math,
// Management Group membership resolution, and the case lifecycle helpers. Everything here is the
// authoritative source of the rules so the UI, endpoints, and tally cron agree.

import { prisma } from "./db";
import { fetchManagementGroupMembers } from "./management-group";

// Timing (days).
export const NEW_PROVIDER_WINDOW_DAYS = 30; // a provider is flaggable only inside this window

// New-provider listing hold: a qualifying provider is NOT listed until it has been claimed for
// NEW_PROVIDER_WINDOW_DAYS, so a pre-warmed on-chain entity cannot register and instantly appear
// in wallets before the Management Group can react. Providers claimed on/before this cutoff are
// grandfathered (never held): the initial launch base was seeded in one bulk event on 2026-06-22
// (+ Burst FTSO 2026-06-25), so their createdAt is an artifact of that import, not real onboarding.
// The cutoff sits after that batch and before the first genuine post-launch claims.
export const NEW_PROVIDER_HOLD_CUTOFF = new Date("2026-07-01T00:00:00Z");
export const FLAG_PAUSE_DAYS = 14; // total added pause once a case opens
export const DISCUSSION_DAYS = 3; // discussion-only portion at the start
export const VOTING_DAYS = FLAG_PAUSE_DAYS - DISCUSSION_DAYS; // 11 days of voting
export const CO_INITIATORS_REQUIRED = 2; // distinct members needed to open a case
export const PENDING_EXPIRY_DAYS = 7; // a single-member pending flag auto-expires after this
export const APPEAL_COOLDOWN_DAYS = 30; // earliest an appeal may open after a denial
export const APPEAL_DEADLINE_DAYS = 365; // latest an appeal may open; then suspension is final

// Quorum (basis points of the current member count / of votes cast).
export const QUORUM_TURNOUT_BIPS = 3300; // >=33% of members must vote
export const DENY_MAJORITY_BIPS = 6667; // >=2/3 of votes cast must be DENY
// For context only: Flare's own management-group standard, surfaced in the UI.
export const FLARE_QUORUM_TURNOUT_BIPS = 6600; // 66%
export const FLARE_MAJORITY_BIPS = 5000; // >50%

export type FlagState =
  | "OPEN_DISCUSSION"
  | "OPEN_VOTING"
  | "DENIED"
  | "CLEARED"
  | "FAILED_QUORUM";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quorum evaluation for a tally. memberCount is the LIVE Management Group size at tally time. */
// Quorum is measured against ALL votes cast (DENY + KEEP + ABSTAIN): an abstention is a present
// member, so it counts toward turnout. The majority is measured only against the DECISIVE votes
// (DENY + KEEP); an abstention is "present but not voting on the question", so it neither helps nor
// hinders. This is what makes ABSTAIN a true neutral that cannot game quorum.
//
// The two processes have OPPOSITE defaults, so each needs an AFFIRMATIVE majority to change its
// status quo, and an all-abstain (or split) quorate vote changes nothing:
//   Flag  (status quo = listed)   - a DENY supermajority is required to suspend. Otherwise CLEARED.
//   Appeal(status quo = suspended)- a KEEP supermajority is required to lift the suspension. Otherwise
//                                   the appeal is rejected (DENIED), so an all-abstain appeal does NOT
//                                   lift the suspension.
export function evaluateOutcome(
  memberCount: number,
  votesCast: number,
  denyVotes: number,
  decisiveVotes: number = votesCast,
  opts: { isReVote?: boolean; keepVotes?: number } = {}
): { decided: FlagState; turnoutFloor: number; denyNeeded: number; keepNeeded: number } {
  const turnoutFloor = Math.ceil((QUORUM_TURNOUT_BIPS / 10000) * memberCount);
  // Symmetric supermajority bar applied to whichever side must affirmatively win.
  const denyNeeded = Math.ceil((DENY_MAJORITY_BIPS / 10000) * decisiveVotes);
  const keepNeeded = Math.ceil((DENY_MAJORITY_BIPS / 10000) * decisiveVotes);
  if (votesCast < turnoutFloor) {
    return { decided: "FAILED_QUORUM", turnoutFloor, denyNeeded, keepNeeded };
  }
  if (opts.isReVote) {
    // Appeal: only an affirmative KEEP supermajority overturns the denial. With zero decisive votes
    // (all abstain) keepNeeded is 0, but a non-vote is not a win, so require at least one keep.
    const keepVotes = opts.keepVotes ?? 0;
    if (keepVotes >= keepNeeded && keepVotes > 0) {
      return { decided: "CLEARED", turnoutFloor, denyNeeded, keepNeeded };
    }
    // Anything else with quorum (deny majority, a split, or all-abstain) rejects the appeal.
    return { decided: "DENIED", turnoutFloor, denyNeeded, keepNeeded };
  }
  // Flag: a DENY supermajority suspends. With zero decisive votes denyNeeded is 0, so require at
  // least one deny; otherwise the provider stays listed.
  if (denyVotes >= denyNeeded && denyVotes > 0) {
    return { decided: "DENIED", turnoutFloor, denyNeeded, keepNeeded };
  }
  return { decided: "CLEARED", turnoutFloor, denyNeeded, keepNeeded };
}

/**
 * Resolve the Management Group member set to (a) the set of all member addresses (every role) and
 * (b) a map from any member address to that member's canonical entity voter, so we can dedupe a
 * member's five addresses to one vote. Returns null pieces if the chain is unreachable.
 */
export async function loadMembers(): Promise<{
  memberAddresses: Set<string>;
  voterByAddress: Map<string, string>;
  memberCount: number;
}> {
  // Member list is the entities' identity (voter) addresses.
  const voters = await fetchManagementGroupMembers(); // lowercased
  const voterSet = new Set(voters);

  // Expand to all five role addresses so a member can sign with any of them, and map each back
  // to the canonical voter for dedupe.
  const entities = await prisma.providerOnchain.findMany({
    where: { voter: { in: voters } },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  const memberAddresses = new Set<string>();
  const voterByAddress = new Map<string, string>();
  for (const v of voters) {
    memberAddresses.add(v);
    voterByAddress.set(v, v);
  }

  // The GOVERNANCE_TEST_* knobs below can inject members and shrink the quorum denominator (down to a
  // single vote), so they are a governance-takeover lever if ever set by accident. They are honored
  // ONLY when the explicit master switch GOVERNANCE_TEST_MODE=1 is set (S10); any of the individual
  // vars on their own do nothing. Set the switch deliberately for a sim, and unset it after teardown.
  const testMode = process.env.GOVERNANCE_TEST_MODE === "1";

  // Test-only: GOVERNANCE_TEST_MEMBERS (comma-separated lowercased addresses) are treated as
  // additional members so an end-to-end test can sign with controllable keys. Unset in normal
  // operation; each test address counts as its own distinct member entity.
  const testMembers = (testMode ? process.env.GOVERNANCE_TEST_MEMBERS ?? "" : "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  for (const a of testMembers) {
    memberAddresses.add(a);
    voterByAddress.set(a, a);
  }
  // Test-only: override the effective member count so an end-to-end test can reach the turnout
  // floor with a handful of votes. Unset in normal operation.
  const countOverride = testMode
    ? Number(process.env.GOVERNANCE_TEST_MEMBER_COUNT_OVERRIDE ?? "")
    : NaN;
  const totalMemberCount =
    Number.isFinite(countOverride) && countOverride > 0
      ? countOverride
      : voterSet.size + testMembers.length;
  for (const e of entities) {
    for (const a of [
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]) {
      if (a) {
        const la = a.toLowerCase();
        memberAddresses.add(la);
        voterByAddress.set(la, e.voter.toLowerCase());
      }
    }
  }

  // Test-only: GOVERNANCE_TEST_EXCLUDE (comma-separated lowercased voter addresses) removes those
  // members entirely, so an address that is BOTH an on-chain member and the flagged provider can be
  // tested in the provider role (otherwise the member branch wins). Applied last so it strips the
  // voter and all of its role addresses regardless of insertion order. Unset in normal operation.
  const excluded = (testMode ? process.env.GOVERNANCE_TEST_EXCLUDE ?? "" : "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (excluded.length) {
    const excludedSet = new Set(excluded);
    for (const [addr, voter] of [...voterByAddress.entries()]) {
      if (excludedSet.has(voter)) {
        voterByAddress.delete(addr);
        memberAddresses.delete(addr);
      }
    }
  }
  return { memberAddresses, voterByAddress, memberCount: totalMemberCount };
}

/** The member entity (voter) for a signer address, or null if the address is not a current member. */
export function memberVoterFor(
  address: string,
  voterByAddress: Map<string, string>
): string | null {
  return voterByAddress.get(address.toLowerCase()) ?? null;
}

/** Is this provider currently inside the new-provider window (created, not yet qualified, <30d)? */
export function inNewProviderWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < NEW_PROVIDER_WINDOW_DAYS * DAY_MS;
}

/**
 * Is this provider currently HELD from listing? A provider claimed after NEW_PROVIDER_HOLD_CUTOFF
 * is withheld from the listed feed (and shown as not-yet-Qualified) for its first
 * NEW_PROVIDER_WINDOW_DAYS even if it already meets every qualification criterion, so a pre-warmed
 * on-chain entity cannot register and immediately appear in wallets before the Management Group
 * has a chance to notice and flag it. The clock is anchored on `createdAt` (the signed-claim
 * moment), the same anchor the flag window uses. This is NOT MG-gated: after the window it lists
 * automatically. Providers claimed on/before the cutoff (the seeded launch base) are grandfathered.
 */
export function isHeldNewProvider(createdAt: Date, now: Date): boolean {
  if (createdAt <= NEW_PROVIDER_HOLD_CUTOFF) return false; // grandfathered launch base
  return inNewProviderWindow(createdAt, now);
}

/** Compute the case deadlines from an open time. */
export function caseDeadlines(openedAt: Date): {
  discussionEndsAt: Date;
  votingEndsAt: Date;
} {
  return {
    discussionEndsAt: new Date(openedAt.getTime() + DISCUSSION_DAYS * DAY_MS),
    votingEndsAt: new Date(openedAt.getTime() + FLAG_PAUSE_DAYS * DAY_MS),
  };
}

/** The window in which an appeal of a denied case may be opened. */
export function appealWindow(decidedAt: Date): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: new Date(decidedAt.getTime() + APPEAL_COOLDOWN_DAYS * DAY_MS),
    closesAt: new Date(decidedAt.getTime() + APPEAL_DEADLINE_DAYS * DAY_MS),
  };
}

/** Whether a case is currently in its voting phase (used to gate vote casting). */
export function isVotingOpen(c: { state: string; discussionEndsAt: Date; votingEndsAt: Date }, now: Date): boolean {
  return (
    (c.state === "OPEN_VOTING" || c.state === "OPEN_DISCUSSION") &&
    now >= c.discussionEndsAt &&
    now < c.votingEndsAt
  );
}

export interface ProviderGovernance {
  pending: boolean; // a single-member flag exists; not yet an open case (needs a 2nd member)
  underReview: boolean; // an open case exists
  isAppeal: boolean; // the headline open case is a provider-initiated appeal (re-vote)
  suspended: boolean;
  // The provider can request an appeal right now: suspended, cooldown elapsed, within the deadline,
  // and no appeal already used or in progress. Drives the "appeal ready" banner on the provider page.
  appealReady: boolean;
  caseId: string | null;
  state: string | null;
}

export interface PastFlagCase {
  caseId: string;
  state: string; // WITHDRAWN | DENIED | CLEARED | FAILED_QUORUM
  at: string; // ISO of when it concluded (decidedAt), or opened if missing
}

/**
 * Concluded flag cases per provider (archived withdrawn flags + decided cases), newest first, so the
 * provider detail page can link to the readable record. Excludes still-live cases (PENDING/open),
 * which are surfaced separately by governanceByProvider().
 */
export async function pastCasesByProvider(): Promise<Map<string, PastFlagCase[]>> {
  const cases = await prisma.providerFlagCase.findMany({
    where: { state: { in: ["WITHDRAWN", "DENIED", "CLEARED", "FAILED_QUORUM"] } },
    orderBy: { decidedAt: "desc" },
    select: { id: true, providerId: true, state: true, decidedAt: true, openedAt: true },
  });
  const map = new Map<string, PastFlagCase[]>();
  for (const c of cases) {
    const list = map.get(c.providerId) ?? [];
    list.push({ caseId: c.id, state: c.state, at: (c.decidedAt ?? c.openedAt).toISOString() });
    map.set(c.providerId, list);
  }
  return map;
}

/**
 * Governance status per provider for the feed/UI: whether it has an open case (under review),
 * whether it is suspended, and the most relevant case id. Only providers with any case or a
 * suspension appear in the returned map.
 */
export async function governanceByProvider(): Promise<Map<string, ProviderGovernance>> {
  const cases = await prisma.providerFlagCase.findMany({
    orderBy: { openedAt: "desc" },
    select: {
      id: true,
      providerId: true,
      state: true,
      isReVote: true,
      decidedAt: true,
      provider: { select: { suspended: true } },
    },
  });

  // First pass: per provider, find the latest denial's decision time, whether any appeal has been
  // used (a decided re-vote) and whether one is in progress (an open re-vote). Used to decide if the
  // provider may request an appeal right now.
  const now = Date.now();
  const denialDecidedAt = new Map<string, Date>();
  const appealUsed = new Set<string>();
  const appealInProgress = new Set<string>();
  for (const c of cases) {
    if (c.state === "DENIED" && c.decidedAt && !denialDecidedAt.has(c.providerId)) {
      denialDecidedAt.set(c.providerId, c.decidedAt); // cases are openedAt desc, so first = latest
    }
    if (c.isReVote && ["DENIED", "CLEARED", "FAILED_QUORUM"].includes(c.state)) {
      appealUsed.add(c.providerId);
    }
    if (c.isReVote && (c.state === "OPEN_DISCUSSION" || c.state === "OPEN_VOTING")) {
      appealInProgress.add(c.providerId);
    }
  }

  const map = new Map<string, ProviderGovernance>();
  for (const c of cases) {
    const open = c.state === "OPEN_DISCUSSION" || c.state === "OPEN_VOTING";
    const pending = c.state === "PENDING";
    const existing = map.get(c.providerId);
    // Headline priority: an open case beats a pending one beats anything older.
    const better = open || (pending && !existing?.underReview);
    if (!existing || better) {
      const decided = denialDecidedAt.get(c.providerId);
      const win = decided ? appealWindow(decided) : null;
      const appealReady =
        c.provider.suspended &&
        !!win &&
        now >= win.opensAt.getTime() &&
        now <= win.closesAt.getTime() &&
        !appealUsed.has(c.providerId) &&
        !appealInProgress.has(c.providerId);
      map.set(c.providerId, {
        pending,
        underReview: open,
        isAppeal: open && c.isReVote,
        suspended: c.provider.suspended,
        appealReady,
        caseId: c.id,
        state: c.state,
      });
    }
  }
  return map;
}

/**
 * True if a reply target ref ("<type>:<id>") refers to a row that belongs to the given case.
 * Used to validate `replyToRef` so a reply/entry can't point at another case's content (S18).
 */
export async function targetBelongsToCase(
  refType: string,
  refId: string,
  caseId: string
): Promise<boolean> {
  if (!refType || !refId) return false;
  if (refType === "initiation") {
    return !!(await prisma.providerFlagInitiation.findFirst({ where: { id: refId, caseId } }));
  }
  if (refType === "groundsEntry") {
    return !!(await prisma.providerFlagGroundsEntry.findFirst({
      where: { id: refId, initiation: { caseId } },
    }));
  }
  if (refType === "defense") {
    return !!(await prisma.providerFlagDefense.findFirst({ where: { id: refId, caseId } }));
  }
  if (refType === "defenseEntry") {
    return !!(await prisma.providerFlagDefenseEntry.findFirst({
      where: { id: refId, defense: { caseId } },
    }));
  }
  return false;
}
