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

/**
 * Days a CONDUCT case may sit short of its four signatures before it lapses.
 *
 * Without this a case with one signature sat PENDING forever. Nothing published it, nothing decided
 * it, and the subject was never told, so it could not be answered either: an accusation readable by
 * all 48 members, against a named competitor, with no route to a verdict and no expiry. A process
 * that can be started but never finished is not a process, it is a standing allegation, and the seal
 * that protects the subject from publicity also denied them any way to clear it.
 *
 * 14 days, matching the notice period. Long enough to gather three more signatures from a group of
 * that size, short enough that a case nobody would co-sign does not persist on the strength of one
 * member's word.
 */
export const CONDUCT_PENDING_EXPIRY_DAYS = 14;
export const APPEAL_COOLDOWN_DAYS = 30; // earliest an appeal may open after a denial
export const APPEAL_DEADLINE_DAYS = 365; // latest an appeal may open; then suspension is final

// Quorum (basis points of the current member count / of votes cast).
export const QUORUM_TURNOUT_BIPS = 3300; // >=33% of members must vote
export const DENY_MAJORITY_BIPS = 6667; // >=2/3 of votes cast must be DENY
// For context only: Flare's own management-group standard, surfaced in the UI.
export const FLARE_QUORUM_TURNOUT_BIPS = 6600; // 66%
export const FLARE_MAJORITY_BIPS = 5000; // >50%

/**
 * Case kinds. FLAG is the original new-provider review; CONDUCT is an evidenced record against an
 * established provider.
 */
export type CaseKind = "FLAG" | "CONDUCT";

// ---------------------------------------------------------------------------------------------
// CONDUCT case parameters.
//
// Every number here differs from the FLAG equivalent, and each difference has one reason: the
// subject. A FLAG subject is inside its 30-day hold, unlisted in every wallet, with no delegators.
// A CONDUCT subject is listed, earning, and has delegators who move on a headline. The FLAG numbers
// are calibrated to delay an unknown newcomer by 14 days; they are not calibrated to attach a
// permanent public finding to an established business.
// ---------------------------------------------------------------------------------------------

/**
 * Distinct member entities required to open a conduct case, against 2 for a flag.
 *
 * 2-of-45 is a pair of rivals and one phone call. 4 is not collusion-proof either, but it is the
 * point at which a case needs members who do not all share an interest, and it is the only barrier
 * standing between an accusation and the private process, since nothing is published before a vote.
 */
export const CONDUCT_CO_INITIATORS_REQUIRED = 4;

/**
 * Days between the 4th signature and the start of discussion, during which the subject is served
 * and may prepare.
 *
 * This is the merit gate every professional body has and this registry did not: a period in which
 * the subject learns of the case before anyone else can act on it. Nothing about a conduct case is
 * public during it, or at any point before substantiation.
 */
export const CONDUCT_NOTICE_DAYS = 7;
/** Discussion, after notice. Longer than the flag's 3 days: the subject is answering a track record. */
export const CONDUCT_DISCUSSION_DAYS = 7;
/** Voting, after discussion. */
export const CONDUCT_VOTING_DAYS = 7;

/**
 * Whether the subject could be told, and what they did about it. A PUBLISHED FIELD, not a gate.
 *
 * Silence from a provider who was asked and declined, and silence from one who was never reachable
 * because the listing has never been claimed, are different facts. Rendering them alike would let a
 * reader infer a refusal to answer where none happened.
 */
export type ServiceStatus =
  | "SERVED_DEFENDED"
  | "SERVED_NO_DEFENCE"
  /** Claimed, but nothing in the audit shows the notice reached them. Not the same as declining. */
  | "NOTICE_UNDELIVERED"
  | "UNCLAIMED_NOT_SERVED";

/** Conduct case deadlines, measured from the moment the 4th signature lands. */
export function conductDeadlines(openedAt: Date): {
  noticeEndsAt: Date;
  discussionEndsAt: Date;
  votingEndsAt: Date;
} {
  const noticeEndsAt = new Date(openedAt.getTime() + CONDUCT_NOTICE_DAYS * DAY_MS);
  const discussionEndsAt = new Date(
    noticeEndsAt.getTime() + CONDUCT_DISCUSSION_DAYS * DAY_MS
  );
  return {
    noticeEndsAt,
    discussionEndsAt,
    votingEndsAt: new Date(discussionEndsAt.getTime() + CONDUCT_VOTING_DAYS * DAY_MS),
  };
}

/**
 * May this case be shown to the public?
 *
 * FLAG cases are public from the moment they are raised, and that is DELIBERATE, not an oversight:
 * docs/governance-flag-mechanism.md §7 requires "no privileged view", and the subject is inside its
 * 30-day hold, unlisted in every wallet, with no delegators to alarm. Scrutiny before listing is the
 * entire purpose. Nothing about that behaviour changes here.
 *
 * CONDUCT is the mirror image. Its subject IS listed, with delegators and revenue, so publication is
 * itself the injury and arrives long before any vote. Four rivals could otherwise attach a named,
 * dated accusation to a competitor and never need to win the vote at all. So a CONDUCT case is
 * invisible until `publishedAt` is set, which happens only on a substantiated outcome.
 *
 * Expressed as a kind check rather than "publishedAt is not null" for FLAG too, so preserving the
 * existing behaviour needs no backfill and cannot be broken by a migration that misses rows.
 */
export function isCasePublic(c: { kind: string; publishedAt: Date | null }): boolean {
  return c.kind === "FLAG" || c.publishedAt !== null;
}

/**
 * The same rule as a Prisma filter, for list queries.
 *
 * Every PUBLIC read path must spread this. The authoritative list of those paths, and the test that
 * enforces it, is in src/lib/__tests__/case-visibility.test.ts. Admin routes and authenticated
 * action routes (vote, defend, edit-grounds and so on) deliberately do NOT use it: an operator needs
 * to see everything, and a member acting on their own sealed case must still be able to.
 */
export const PUBLIC_CASE_WHERE = {
  OR: [{ kind: "FLAG" }, { publishedAt: { not: null } }],
};

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
  // A CASE IN OPEN_VOTING IS IN VOTING. The date test used to apply to both branches, so a case
  // whose state said OPEN_VOTING but whose discussion deadline was still in the future counted as
  // closed: the panel hid the buttons and told a member voting had not opened, on a case the rest
  // of the system was describing as being in it. That happens whenever the state is moved by hand
  // from the admin surface, which is a supported thing to do.
  if (c.state === "OPEN_VOTING") return now < c.votingEndsAt;
  // Still nominally in discussion, but the deadline has passed and the sweep has not caught up yet.
  // Voting is open by the clock, which is what the schedule promised, so a member is not made to
  // wait on a cron tick.
  return c.state === "OPEN_DISCUSSION" && now >= c.discussionEndsAt && now < c.votingEndsAt;
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
    // Sealed CONDUCT cases never reach a provider page or the feed. Spread, not a second `where`
    // key: two keys silently drops the first.
    // FLAG only: this is the new-provider case record shown on a provider page. Conduct findings
    // are rendered separately so the two can never be confused for one another.
    where: {
      kind: "FLAG",
      state: { in: ["WITHDRAWN", "DENIED", "CLEARED", "FAILED_QUORUM"] },
    },
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
    // FLAG ONLY, and this is load-bearing rather than defensive. This function's output feeds
    // `liveCase` -> `held` -> `listed:false` in feed.ts and on the provider page. A conduct case
    // reaching it would let an accusation against an established provider pull them out of every
    // wallet. Conduct findings get their own display surface and never touch listing.
    where: { kind: "FLAG" },
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


/**
 * A member changed the substance of a pending conduct case. Drop the endorsements it had collected.
 *
 * AN ENDORSEMENT IS OF A SPECIFIC ACCUSATION. Members who signed "as it stands" put their names to
 * the grounds and evidence they read; if the author then rewrites the grounds or swaps a
 * transaction hash, those signatures now sit under something nobody agreed to. Left alone, a case
 * could reach four signatures where three endorsed a version that no longer exists, and the subject
 * would be served with an accusation three of its four accusers had never seen.
 *
 * So a material edit costs the author their borrowed signatures. It cannot be used to gain one, only
 * to lose the ones already given, which is why this is safe to let any co-initiator trigger: the
 * only person slowed down is the person doing the editing.
 *
 * Authored points are untouched. Each of those members wrote their own grounds, and another
 * member's edit does not change what they said.
 *
 * Returns how many endorsements were removed.
 */
export async function invalidateEndorsements(
  tx: Pick<typeof prisma, "providerFlagInitiation" | "providerCaseAudit">,
  caseId: string,
  editorVoter: string,
  what: string
): Promise<number> {
  const stale = await tx.providerFlagInitiation.findMany({
    where: { caseId, endorsement: true, withdrawnAt: null },
    select: { id: true, memberEntityVoter: true },
  });
  if (!stale.length) return 0;
  await tx.providerFlagInitiation.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  await tx.providerCaseAudit.create({
    data: {
      caseId,
      action: "CONDUCT_ENDORSEMENTS_INVALIDATED",
      actor: editorVoter,
      detail: JSON.stringify({
        what,
        cleared: stale.map((s) => s.memberEntityVoter),
        reason: "the case was edited after these members endorsed it; they must sign again",
      }),
    },
  });
  return stale.length;
}

/**
 * WHAT A MEMBER NEEDS TO SEE ON A DIRECTORY CARD, for every conduct case at once.
 *
 * ONE LOADER, shared by /api/governance/conduct/pending-all and the home page, which is the third
 * time this exact shape was about to exist in two places. The first two times they drifted and the
 * copy the page actually rendered was the one missing the new fields.
 *
 * COUNTS, STAGE AND DATES ONLY. No grounds and no evidence, because nothing here is a place to READ
 * a case: it exists so a member can see where one is and go to that provider's page to read it. The
 * narrower payload also means a directory response never carries the text of a sealed accusation.
 *
 * The caller must have PROVEN control of `memberVoter`; this function authenticates nothing.
 */
export interface ConductDirectoryView {
  pending: { providerId: string; signatures: number; remaining: number; alreadySigned: boolean }[];
  /** Cases past their fourth signature: served, running, and heading for a vote. */
  open: { providerId: string; state: string; nextDeadline: string | null; hasVoted: boolean }[];
}

export async function conductDirectoryForMember(memberVoter: string): Promise<ConductDirectoryView> {
  const [pendingRows, openRows] = await Promise.all([
    prisma.providerFlagCase.findMany({
      where: { kind: "CONDUCT", state: "PENDING" },
      select: {
        providerId: true,
        initiations: { where: { withdrawnAt: null }, select: { memberEntityVoter: true } },
      },
    }),
    // A card stopped saying anything the moment a case reached four signatures, which is exactly
    // when it starts to matter: the provider has been served, the clock is running, and the member
    // reading the directory is one of the people who will have to vote. The badge disappeared at
    // the point it became actionable.
    prisma.providerFlagCase.findMany({
      where: { kind: "CONDUCT", state: { in: ["NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] } },
      select: {
        providerId: true,
        state: true,
        noticeEndsAt: true,
        discussionEndsAt: true,
        votingEndsAt: true,
        votes: { where: { memberEntityVoter: memberVoter }, select: { id: true } },
      },
    }),
  ]);

  return {
    pending: pendingRows.map((c) => ({
      providerId: c.providerId,
      signatures: c.initiations.length,
      remaining: Math.max(0, CONDUCT_CO_INITIATORS_REQUIRED - c.initiations.length),
      /** So a card can say "you have signed this" rather than inviting a signature that would 409. */
      alreadySigned: c.initiations.some((i) => i.memberEntityVoter === memberVoter),
    })),
    open: openRows.map((c) => {
      const next =
        c.state === "NOTICE"
          ? c.noticeEndsAt
          : c.state === "OPEN_DISCUSSION"
            ? c.discussionEndsAt
            : c.votingEndsAt;
      return {
        providerId: c.providerId,
        state: c.state,
        nextDeadline: next ? next.toISOString() : null,
        /** So a card asks for a vote once, rather than nagging a member who has already cast one. */
        hasVoted: c.votes.length > 0,
      };
    }),
  };
}

/**
 * THE SUBJECT'S VIEW of the sealed cases they have been served with.
 *
 * ONE LOADER, shared by /api/governance/my-case and the provider page, for the same reason the
 * member view has one: this payload was about to be produced in two places, and the last time that
 * happened the copy the page actually rendered was the one missing the new fields.
 *
 * The caller is responsible for having PROVEN control of `signer`. This function does no
 * authentication and must never be handed an address a client merely claimed.
 *
 * THE ACCUSERS ARE NAMED. This deliberately reverses an earlier rule that withheld them until a
 * case was substantiated, on the reasoning that naming rivals to the accused before anything is
 * decided invites retaliation.
 *
 * That protected the wrong party. A provider is being asked to answer an accusation and decide
 * whether to contest it, and who is making it is frequently the substance of the answer: that a
 * competitor filed it, that a signatory has a stake in the outcome, that two of the four are the
 * same operator. Withholding it left them arguing with the air. The same names become public the
 * moment the case is substantiated, so the seal was buying a few days of anonymity for the accuser
 * at the cost of the accused being able to reply properly at all.
 */
export interface SubjectCase {
  caseId: string;
  state: string;
  openedAt: string;
  noticeEndsAt: string | null;
  discussionEndsAt: string | null;
  votingEndsAt: string | null;
  hasDefence: boolean;
  /**
   * The subject's own response, in full.
   *
   * Returned rather than reduced to a boolean because the panel is the only place they can see this
   * case: a flag said one had been filed and showed nothing, so the edit form opened empty and
   * "editing" meant retyping from memory or overwriting the reply with a blank one.
   */
  defence: { title: string | null; body: string; at: string } | null;
  points: {
    /** The signatory's on-chain identity (voter) address. */
    member: string;
    /** Their listed provider name, where one resolves. Null for a member with no listing. */
    memberName: string | null;
    /** An address that resolves at /provider/<link>, so the subject can look them up. */
    memberLink: string | null;
    at: string;
    title: string | null;
    grounds: string;
    endorsement: boolean;
    evidence: { kind: string; chain: string | null; ref: string; claim: string }[];
  }[];
}

export async function subjectCasesFor(providerId: string, signer: string): Promise<SubjectCase[] | null> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { addresses: true },
  });
  if (!provider) return null;
  // The seal lifts ONLY for a signer controlling a VERIFIED address on the listing, the same bar
  // that makes someone the owner anywhere else in this system.
  const owns = provider.addresses.some(
    (a) => a.verified && a.address.toLowerCase() === signer.toLowerCase()
  );
  if (!owns) return null;

  const cases = await prisma.providerFlagCase.findMany({
    where: { providerId, kind: "CONDUCT", state: { in: ["NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] } },
    orderBy: { openedAt: "desc" },
    include: {
      defense: { select: { id: true, title: true, body: true, createdAt: true, editedAt: true } },
      initiations: {
        where: { withdrawnAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          memberEntityVoter: true,
          createdAt: true,
          title: true,
          grounds: true,
          endorsement: true,
          evidence: { select: { kind: true, chain: true, ref: true, claim: true } },
        },
      },
    },
  });

  // Record that the subject actually looked. This is what makes "served" a fact rather than an
  // assertion: a case decided SERVED_NO_DEFENCE against a provider who never once opened it is
  // reporting a silence that may only mean they never knew.
  for (const c of cases) {
    const seen = await prisma.providerCaseAudit.findFirst({
      where: { caseId: c.id, action: "SUBJECT_VIEWED" },
    });
    if (!seen) {
      await prisma.providerCaseAudit.create({
        data: { caseId: c.id, action: "SUBJECT_VIEWED", actor: signer.toLowerCase() },
      });
    }
  }

  // Names and links for the signatories, through the five-role join, so the subject reads who is
  // accusing them rather than a column of hex.
  const voters = cases.flatMap((c) => c.initiations.map((i) => i.memberEntityVoter));
  const names = await namesForMemberVoters(voters);
  const links = await linksForMemberVoters(voters);

  return cases.map((c) => ({
    caseId: c.id,
    state: c.state,
    openedAt: c.openedAt.toISOString(),
    noticeEndsAt: c.noticeEndsAt ? c.noticeEndsAt.toISOString() : null,
    discussionEndsAt: c.discussionEndsAt ? c.discussionEndsAt.toISOString() : null,
    votingEndsAt: c.votingEndsAt ? c.votingEndsAt.toISOString() : null,
    hasDefence: !!c.defense,
    defence: c.defense
      ? {
          title: c.defense.title,
          body: c.defense.body,
          at: (c.defense.editedAt ?? c.defense.createdAt).toISOString(),
        }
      : null,
    points: c.initiations.map((i) => ({
      member: i.memberEntityVoter,
      memberName: names.get(i.memberEntityVoter.toLowerCase()) ?? null,
      memberLink: links.get(i.memberEntityVoter.toLowerCase()) ?? null,
      at: i.createdAt.toISOString(),
      title: i.title,
      grounds: i.grounds,
      endorsement: i.endorsement,
      evidence: i.evidence,
    })),
  }));
}

/**
 * What a Management Group member sees of a PENDING conduct case before deciding to sign it.
 *
 * ONE BUILDER, used by both the API route and the provider page, because this payload is produced
 * in two places and they must agree. They did not: the page renders the panel from a server-built
 * copy of this shape, so when `endorsement` and `mine` were added to the API route only, the panel
 * on first paint showed endorsements as blank grounds and offered no withdraw control at all. The
 * fetch path had the fields and the path everybody actually hits did not.
 *
 * Sealed either way. The caller is responsible for having PROVEN control of `memberVoter`; this
 * function does no authentication and must never be called with an address a client merely claimed.
 */
export interface LiveConductView {
  caseId: string;
  network: string;
  /** PENDING | NOTICE | OPEN_DISCUSSION | OPEN_VOTING. */
  state: string;
  openedAt: string;
  noticeEndsAt: string | null;
  discussionEndsAt: string;
  votingEndsAt: string;
  votingOpen: boolean;
  defence: { title: string | null; body: string; at: string } | null;
  votes: { deny: number; keep: number; abstain: number; total: number };
  myVote: string | null;
  signatures: number;
  required: number;
  remaining: number;
  /** This member has already signed, so the form can say so instead of 409ing later. */
  alreadySigned: boolean;
  points: {
    member: string;
    memberName: string | null;
    title: string | null;
    grounds: string;
    /** Signed the case as it stood, adding no ground of their own. `grounds` is empty. */
    endorsement: boolean;
    /**
     * This point is the asking member's own, so the withdraw control can sit on it.
     *
     * Resolved HERE, not compared in the browser: a member signs with any of their five on-chain
     * role addresses, so the address a wallet holds is usually not the voter address stored on the
     * point, and a client-side comparison would leave most members unable to find their own.
     */
    mine: boolean;
    at: string;
    /**
     * Evidence ids are included so the owning member can correct a reference in place.
     *
     * They identify a row, not a case: an id is worthless without a signature proving control of the
     * member entity the row hangs off, which the evidence route re-checks. And this view is only
     * ever served to a member who has already proven exactly that.
     */
    evidence: { id: string; kind: string; chain: string | null; ref: string; claim: string }[];
  }[];
  /**
   * EVERYTHING THAT HAS HAPPENED TO THIS CASE, for the members deciding whether to join it.
   *
   * The panel shows the case as it stands now, which is not enough to judge it. A case at three
   * signatures reads the same whether it has sat unchanged since it was filed or whether the grounds
   * were rewritten twice and two endorsements were cleared along the way. The second is a materially
   * different thing to put your name to, and the trail is the only place it shows.
   *
   * DERIVED FIELDS ONLY, never the raw audit detail. Some rows carry a full restorable snapshot of a
   * withdrawn point, and a blob of JSON is neither readable nor something to hand out by default.
   * Each action is reduced here to the few facts its sentence needs, and the sentence itself is
   * localized on the client, so nothing ships an operator-facing constant like
   * CONDUCT_ENDORSEMENTS_INVALIDATED to a reader.
   */
  audit: {
    at: string;
    action: string;
    actor: string;
    actorName: string | null;
    /** Whitelisted per action; see AUDIT_META. Interpolated into the localized sentence. */
    meta: Record<string, string | number | boolean>;
  }[];
}

/**
 * What each audit action is allowed to tell a member, and nothing else.
 *
 * A whitelist rather than a redaction list: a new action added later shows with no meta rather than
 * leaking whatever its author happened to put in `detail`.
 */
function auditMeta(action: string, detail: string | null): Record<string, string | number | boolean> {
  let d: Record<string, unknown> = {};
  try {
    d = detail ? JSON.parse(detail) : {};
  } catch {
    return {};
  }
  const n = (v: unknown) => (typeof v === "number" ? v : Array.isArray(v) ? v.length : 0);
  switch (action) {
    case "CONDUCT_SIGNED":
      return { endorsement: d.endorsement === true, signatures: n(d.signatures) };
    case "CONDUCT_SIGNATURE_WITHDRAWN":
      return { endorsement: d.endorsement === true, remaining: n(d.remaining) };
    case "CONDUCT_GROUNDS_EDITED":
      return { supplemental: d.supplemental === true };
    case "CONDUCT_EVIDENCE_EDITED":
      return { added: n(d.added), updated: n(d.updated), removed: n(d.removed) };
    case "CONDUCT_ENDORSEMENTS_INVALIDATED":
      return { cleared: n(d.cleared), what: typeof d.what === "string" ? d.what : "" };
    // The decision. "Failed quorum" means nothing without the turnout it fell short of, so the
    // counts travel with the sentence rather than sitting unread in the detail column.
    case "CASE_SUBSTANTIATED":
    case "CASE_NOT_SUBSTANTIATED":
    case "CASE_FAILED_QUORUM":
      return {
        turnout: n(d.turnout),
        members: n(d.members),
        quorum: n(d.quorum),
        deny: n(d.deny),
        keep: n(d.keep),
        abstain: n(d.abstain),
      };
    default:
      return {};
  }
}

export async function liveConductForMember(
  providerId: string,
  memberVoter: string
): Promise<LiveConductView | null> {
  // EVERY LIVE STAGE, not just PENDING.
  //
  // This used to stop at PENDING, which meant a case vanished from the member surface at the moment
  // it became real. Members could see one that still needed signatures and nothing at all once it
  // was served: no grounds to re-read, no sight of the provider's answer, and no way to vote. The
  // case page cannot fill that gap either, because a sealed case 404s for everyone. The mechanism
  // could be started and could never reach a verdict.
  const live = await prisma.providerFlagCase.findFirst({
    where: {
      providerId,
      kind: "CONDUCT",
      state: { in: ["PENDING", "NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      initiations: {
        where: { withdrawnAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          memberEntityVoter: true,
          title: true,
          grounds: true,
          endorsement: true,
          createdAt: true,
          evidence: { select: { id: true, kind: true, chain: true, ref: true, claim: true } },
        },
      },
      // THE SUBJECT'S ANSWER. A member voting on an accusation has to be able to read the reply to
      // it; a vote cast on the accusation alone is not a judgement, it is an echo.
      defense: { select: { title: true, body: true, createdAt: true, editedAt: true } },
      votes: { select: { memberEntityVoter: true, vote: true } },
    },
  });
  if (!live) return null;

  // The trail. Ordered oldest first, so it reads as the case's history rather than a feed.
  const audit = await prisma.providerCaseAudit.findMany({
    where: { caseId: live.id },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, action: true, actor: true, detail: true },
  });

  // Who is accusing, in words, and who acted. A voter address does not answer either without a
  // separate lookup, and the reader is deciding whether to put their own name beside it.
  const names = await namesForMemberVoters([
    ...live.initiations.map((i) => i.memberEntityVoter),
    ...audit.map((a) => a.actor),
  ]);
  const signatures = live.initiations.length;
  const mine = live.votes.find((v) => v.memberEntityVoter === memberVoter);
  return {
    caseId: live.id,
    network: live.network,
    state: live.state,
    openedAt: live.openedAt.toISOString(),
    noticeEndsAt: live.noticeEndsAt ? live.noticeEndsAt.toISOString() : null,
    discussionEndsAt: live.discussionEndsAt.toISOString(),
    votingEndsAt: live.votingEndsAt.toISOString(),
    /** Open once discussion has run its course; the same rule the vote route enforces. */
    votingOpen: isVotingOpen(live, new Date()),
    defence: live.defense
      ? {
          title: live.defense.title,
          body: live.defense.body,
          at: (live.defense.editedAt ?? live.defense.createdAt).toISOString(),
        }
      : null,
    votes: {
      deny: live.votes.filter((v) => v.vote === "DENY").length,
      keep: live.votes.filter((v) => v.vote === "KEEP").length,
      abstain: live.votes.filter((v) => v.vote === "ABSTAIN").length,
      total: live.votes.length,
    },
    /** So the control can say what this member already chose rather than inviting a duplicate. */
    myVote: mine?.vote ?? null,
    signatures,
    required: CONDUCT_CO_INITIATORS_REQUIRED,
    remaining: Math.max(0, CONDUCT_CO_INITIATORS_REQUIRED - signatures),
    alreadySigned: live.initiations.some((i) => i.memberEntityVoter === memberVoter),
    points: live.initiations.map((i) => ({
      member: i.memberEntityVoter,
      memberName: names.get(i.memberEntityVoter.toLowerCase()) ?? null,
      title: i.title,
      grounds: i.grounds,
      endorsement: i.endorsement,
      mine: i.memberEntityVoter === memberVoter,
      at: i.createdAt.toISOString(),
      evidence: i.evidence,
    })),
    audit: audit.map((a) => {
      // AN OPERATOR ACTION IS ATTRIBUTED TO THE OPERATOR, NOT TO A WALLET.
      //
      // The admin routes are inconsistent about what they store: some write the literal "admin",
      // others the signed-in operator's own address. So the same operation read two different ways
      // in one list, half of it as "An administrator" and half as "0x670a...c63c", and the address
      // is the operator's personal wallet, which no member needs and nobody chose to publish.
      //
      // Decided by the ACTION rather than by the shape of the actor, because the action is what
      // says where it came from. Redacted HERE rather than in the component, so the address does
      // not travel to the browser at all and cannot be read out of the page source.
      const operator = a.action.startsWith("ADMIN_") || a.action === "CASE_DELETED";
      return {
        at: a.createdAt.toISOString(),
        action: a.action,
        actor: operator ? "admin" : a.actor,
        actorName: operator ? null : (names.get(a.actor.toLowerCase()) ?? null),
        meta: auditMeta(a.action, a.detail),
      };
    }),
  };
}

/** A published conduct finding, for the provider page. */
export interface ConductFinding {
  caseId: string;
  decidedAt: string | null;
  serviceStatus: string | null;
  lateReplyAt: string | null;
  points: {
    title: string | null;
    grounds: string;
    /** Signed the case as it stood, adding no ground of their own. `grounds` is empty. */
    endorsement: boolean;
    evidence: { kind: string; chain: string | null; ref: string; claim: string }[];
  }[];
  hasDefence: boolean;
  /** WHO RAISED IT, named. A finding is an act by identified members, not an anonymous verdict. */
  signers: { name: string | null; link: string | null; endorsement: boolean }[];
  /** THE VOTE THAT DECIDED IT. A card headed "decided by a vote" that never shows the vote is
   *  asking to be taken on trust, which is the opposite of what publishing a record is for. */
  vote: {
    cast: number;
    substantiated: number;
    notSubstantiated: number;
    abstained: number;
    members: number;
    quorum: number;
  };
  /** The provider's own answer, in full. It is already published on the case page, and summarising
   *  it as "a response was submitted" on the page most people actually read leaves the accusation
   *  visible and the reply one click away. */
  defence: { title: string | null; body: string } | null;
}

/**
 * Published conduct findings by provider id.
 *
 * PUBLISHED ONLY, and the filter is on `publishedAt` rather than on the state name, so a future
 * outcome that forgets to set it is invisible rather than accidentally public. Failing closed is the
 * correct direction for the one query that decides whether an accusation about a named business
 * appears on their page.
 */
export async function conductFindingsByProvider(): Promise<Map<string, ConductFinding[]>> {
  const cases = await prisma.providerFlagCase.findMany({
    where: { kind: "CONDUCT", publishedAt: { not: null } },
    orderBy: { decidedAt: "desc" },
    select: {
      id: true,
      providerId: true,
      decidedAt: true,
      serviceStatus: true,
      lateReplyAt: true,
      memberCountAtOpen: true,
      defense: { select: { title: true, body: true } },
      votes: { select: { vote: true } },
      initiations: {
        where: { withdrawnAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          memberEntityVoter: true,
          title: true,
          grounds: true,
          endorsement: true,
          evidence: { select: { kind: true, chain: true, ref: true, claim: true } },
        },
      },
    },
  });

  // Resolved ONCE for every signer across every published case, rather than per card. The five-role
  // join is the expensive part and it does not vary by case.
  const voters = [
    ...new Set(cases.flatMap((c) => c.initiations.map((i) => i.memberEntityVoter.toLowerCase()))),
  ];
  const names = voters.length ? await namesForMemberVoters(voters) : new Map<string, string>();
  const links = voters.length ? await linksForMemberVoters(voters) : new Map<string, string>();

  const map = new Map<string, ConductFinding[]>();
  for (const c of cases) {
    const list = map.get(c.providerId) ?? [];
    const cast = c.votes.length;
    list.push({
      caseId: c.id,
      decidedAt: c.decidedAt?.toISOString() ?? null,
      serviceStatus: c.serviceStatus,
      lateReplyAt: c.lateReplyAt?.toISOString() ?? null,
      hasDefence: !!c.defense,
      defence: c.defense ? { title: c.defense.title, body: c.defense.body } : null,
      signers: c.initiations.map((i) => ({
        name: names.get(i.memberEntityVoter.toLowerCase()) ?? null,
        link: links.get(i.memberEntityVoter.toLowerCase()) ?? null,
        endorsement: i.endorsement,
      })),
      vote: {
        cast,
        // DENY means substantiated here; the enum is the flag mechanism's. See the admin panel.
        substantiated: c.votes.filter((v) => v.vote === "DENY").length,
        notSubstantiated: c.votes.filter((v) => v.vote === "KEEP").length,
        abstained: c.votes.filter((v) => v.vote === "ABSTAIN").length,
        members: c.memberCountAtOpen,
        quorum: Math.ceil((QUORUM_TURNOUT_BIPS / 10000) * c.memberCountAtOpen),
      },
      points: c.initiations.map((i) => ({
        title: i.title,
        grounds: i.grounds,
        endorsement: i.endorsement,
        evidence: i.evidence,
      })),
    });
    map.set(c.providerId, list);
  }
  return map;
}

/**
 * Resolve member entity voter addresses to the provider names behind them.
 *
 * A conduct case names its co-initiators by voter address, which is correct for storage and useless
 * to read: a member deciding whether to add the fourth signature needs to know WHO is accusing, and
 * "0x04cfe617..." does not answer that without a separate lookup.
 *
 * Matched through all FIVE role addresses, not the voter alone. A listing is filed under whichever
 * role its owner claimed with, usually delegation, so a voter-only match leaves nearly every member
 * unnamed. A listing whose name is its own address is the on-chain tier and counts as unnamed, since
 * repeating the hex adds nothing.
 */
/**
 * The address each member voter resolves at under /provider/<address>, so a name can be a link.
 *
 * Separate from namesForMemberVoters because a member can be named without being reachable and vice
 * versa: the name comes from a listing, the link needs the specific listed address that routes.
 * Both walk the same five-role join, since a listing is filed under whichever role its owner
 * claimed with, usually the delegation address rather than the voter.
 */
export async function linksForMemberVoters(voters: string[]): Promise<Map<string, string>> {
  const lower = [...new Set(voters.map((v) => v.toLowerCase()))];
  if (!lower.length) return new Map();

  const ents = await prisma.providerOnchain.findMany({
    where: { voter: { in: lower } },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  const roleAddrs = new Set<string>();
  const rolesOf = (e: (typeof ents)[number]) =>
    [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]
      .filter((r): r is string => !!r)
      .map((r) => r.toLowerCase());
  for (const e of ents) for (const a of rolesOf(e)) roleAddrs.add(a);

  const addrs = await prisma.providerAddress.findMany({
    where: { address: { in: [...roleAddrs] } },
    select: { address: true },
  });
  const listed = new Set(addrs.map((a) => a.address.toLowerCase()));

  const out = new Map<string, string>();
  for (const e of ents) {
    const hit = rolesOf(e).find((r) => listed.has(r));
    if (hit) out.set(e.voter.toLowerCase(), hit);
  }
  return out;
}

export async function namesForMemberVoters(
  voters: string[]
): Promise<Map<string, string>> {
  const lower = [...new Set(voters.map((v) => v.toLowerCase()))];
  if (!lower.length) return new Map();

  const ents = await prisma.providerOnchain.findMany({
    where: { voter: { in: lower } },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  const roleAddrs = new Set<string>();
  for (const e of ents) {
    for (const a of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]) {
      if (a) roleAddrs.add(a.toLowerCase());
    }
  }
  const addrs = await prisma.providerAddress.findMany({
    where: { address: { in: [...roleAddrs] } },
    select: { address: true, provider: { select: { name: true } } },
  });
  const byAddr = new Map(addrs.map((a) => [a.address.toLowerCase(), a.provider.name]));

  const out = new Map<string, string>();
  for (const e of ents) {
    const roles = [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]
      .filter((r): r is string => !!r)
      .map((r) => r.toLowerCase());
    const name = roles.map((r) => byAddr.get(r)).find(Boolean);
    if (name && !/^0x[0-9a-f]{40}$/i.test(name.trim())) out.set(e.voter.toLowerCase(), name);
  }
  return out;
}
