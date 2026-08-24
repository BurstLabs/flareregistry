/**
 * THE VOTING RULE, on its own and with no imports.
 *
 * Separated from lib/governance for one reason: this arithmetic decides whether a public finding is
 * published about a named business, and a module with no database and no network can be executed
 * directly by a build guard. The guard used to test a TRANSCRIPTION of this rule, which passed
 * happily while the real function had its floor disabled, so it was checking its own copy rather
 * than the code that ships. scripts/check-outcome-rule.mjs now imports this file.
 */

/** >= 33% of members must vote. */
export const QUORUM_TURNOUT_BIPS = 3300;
/** >= 2/3 of the votes that take a side must be in favour. Fractionally above two thirds, so an
 *  exact 12 of 18 falls one short; that is deliberate and is asserted by the build guard. */
export const DENY_MAJORITY_BIPS = 6667;

export type OutcomeState = "DENIED" | "CLEARED" | "FAILED_QUORUM";

export function evaluateOutcome(
  memberCount: number,
  votesCast: number,
  denyVotes: number,
  decisiveVotes: number = votesCast,
  opts: { isReVote?: boolean; keepVotes?: number } = {}
): { decided: OutcomeState; turnoutFloor: number; denyNeeded: number; keepNeeded: number } {
  const turnoutFloor = Math.ceil((QUORUM_TURNOUT_BIPS / 10000) * memberCount);
  // Symmetric supermajority bar applied to whichever side must affirmatively win.
  const denyNeeded = Math.ceil((DENY_MAJORITY_BIPS / 10000) * decisiveVotes);
  const keepNeeded = Math.ceil((DENY_MAJORITY_BIPS / 10000) * decisiveVotes);
  if (votesCast < turnoutFloor) {
    return { decided: "FAILED_QUORUM", turnoutFloor, denyNeeded, keepNeeded };
  }
  // THE DECISIVE FLOOR: the same bar again, applied to the votes that actually took a side.
  //
  // Quorum counts every vote, abstentions included; the supermajority counts only the votes that
  // took a side. Those are two different populations, and without this the second one could shrink
  // to almost nothing while the first was satisfied: each abstention left the turnout intact and
  // removed itself from the denominator, so it RAISED the weight of whoever remained. Demonstrated
  // rather than theorised: 16 of 48 turn out, 14 abstain, 2 vote to substantiate and none against,
  // and the case published a finding about a named business on two votes.
  //
  // That is backwards. A case where most attending members declined to take a side has weak
  // support, and the old rule read it as strong support among a small group. The failure was also
  // one-directional: it could only ever make publication easier, and publication is the
  // irreversible half.
  //
  // Requiring the decisive votes to clear the same floor keeps abstention meaning what a member
  // expects, a way to attend without judging this one, while denying it the power to carry a
  // verdict for the few who did. The outcome is FAILED_QUORUM rather than a decision, because that
  // is what happened: not enough of the group was willing to decide.
  if (decisiveVotes < turnoutFloor) {
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
