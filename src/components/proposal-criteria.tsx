"use client";

// THE TWO TESTS A PROPOSAL HAS TO PASS, drawn the way the contract applies them.
//
// PollingManagementGroup._proposalSucceeded runs exactly two checks and defeats a proposal that
// fails either one (read from the verified source, 2026-09-17):
//
//   for + against  >=  ceil(thresholdConditionBIPS x noOfEligibleMembers / 10000)   turnout
//   for            >   floor(majorityConditionBIPS x (for + against) / 10000)       majority
//
// EXCEPT ON A REJECTION VOTE, where both lines invert. The contract returns `!_proposal.accept`
// when a check fails and takes its majority from `accept ? forVotePower : againstVotePower`, so a
// rejection vote stands unless the group BOTH turns out AND votes against it. Missing quorum is how
// it passes. Ten of the twenty-one Management Group proposals are this kind, one of them carried
// with no votes at all, and this block used to state the ordinary rule over all of them: a card
// reading "Quorum: Not met, Majority: Not met" directly under an "Accepted" chip.
//
// Both are percentages, and they are percentages of DIFFERENT DENOMINATORS. That is the thing
// readers get wrong, and a single bar cannot express it: the first is a share of everyone entitled
// to vote, the second a share of only those who did. Two bars, each against its own bar, is what
// makes the difference survive being looked at quickly.
//
// It is also the question this page exists to ask. The Management Group hardly ever disagrees; it
// fails to turn up. A card whose majority bar is full while its turnout bar falls short says that
// about the proposal in front of the reader, rather than in the abstract at the top of the page.
//
// Every figure here is the proposal's OWN: the conditions and the eligible count are snapshotted
// into it at creation, so a vote held in April is measured against the group and the thresholds
// that April actually faced.

import { useApp } from "./providers";

type Status = "met" | "metSoFar" | "notYet" | "notMet";

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
/**
 * One decimal at most, and no trailing zero: the bars people are comparing read "87.8% / 66%", not
 * "87.8% / 66.0%". Formatted rather than localised on purpose, because this renders on both sides
 * of hydration and a comma decimal on one of them is a mismatch.
 */
const fmt = (n: number) => `${Math.round(n * 10) / 10}%`;

/**
 * Green means THE PROPOSAL IS ON COURSE TO STAND, not "this condition is true".
 *
 * On a rejection vote a met condition is a step towards throwing the proposal out, so painting it
 * green because the word is "Met" would say the opposite of what happened. The labels stay factual
 * about the condition and the colour follows the consequence, which is the only pairing that reads
 * correctly under both headings.
 */
function StatusChip({ status, good }: { status: Status; good: boolean }) {
  const { t } = useApp();
  const tone = good
    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
    : status === "notYet" || status === "metSoFar"
      ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
      : "bg-rose-500/15 text-rose-600 dark:text-rose-300";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {t(`prop.crit.${status}`)}
    </span>
  );
}

function Condition({
  title, rule, status, good, value, need, count,
}: {
  title: string;
  rule: string;
  status: Status;
  /** Whether this condition's state points to the proposal standing. See StatusChip. */
  good: boolean;
  /** Where the proposal stands, as a share of this condition's own denominator. */
  value: number;
  /** The share it has to reach. */
  need: number;
  /** The same thing in whole votes, which is what a member actually counts in. */
  count: string;
}) {
  const fill = need > 0 ? Math.min(100, (value / need) * 100) : 0;
  const bar = good
    ? "bg-emerald-500/70"
    : status === "notYet" || status === "metSoFar"
      ? "bg-amber-500/70"
      : "bg-rose-500/70";
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium text-fg">{title}</p>
        <StatusChip status={status} good={good} />
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-faint">{rule}</p>
      <p className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] tabular-nums">
        <span>
          <span className="text-xs font-medium text-fg">{fmt(value)}</span>
          <span className="text-faint"> / {fmt(need)}</span>
        </span>
        <span className="text-faint">{count}</span>
      </p>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${fill}%` }} />
      </div>
    </div>
  );
}

export function ProposalCriteria({
  votesFor, votesAgainst, eligibleCount, quorumNeeded, quorumMet,
  majorityNeeded, majorityMet, thresholdBips, majorityBips, decided, accept,
}: {
  votesFor: number;
  votesAgainst: number;
  eligibleCount: number;
  quorumNeeded: number;
  quorumMet: boolean;
  majorityNeeded: number;
  majorityMet: boolean;
  thresholdBips: number;
  majorityBips: number;
  /** A closed vote states a verdict; a running one can only report where it has got to. */
  decided: boolean;
  /** False on a REJECTION vote, where the proposal stands unless both conditions are met. */
  accept: boolean;
}) {
  const { t } = useApp();
  const cast = votesFor + votesAgainst;
  /** The side the contract measures: in favour ordinarily, against on a rejection vote. */
  const deciding = accept ? votesFor : votesAgainst;

  // TURNOUT ONLY RISES, so a quorum that has been reached is reached for good and says so while the
  // vote is still running. Support does not: a majority that holds today can be gone by the close,
  // which is why it gets its own hedged label rather than borrowing the quorum's.
  const quorumStatus: Status = quorumMet ? "met" : decided ? "notMet" : "notYet";
  const majorityStatus: Status = majorityMet
    ? decided
      ? "met"
      : "metSoFar"
    : decided
      ? "notMet"
      : "notYet";

  return (
    <div className="mt-3 rounded-lg border border-themed p-3">
      {/* Label then statement, set apart by tone and a real gap: run together in one colour they
          read as a single lumpy sentence. The statement is the whole rule, and on a rejection vote
          it is the opposite of the usual one, so it is never left implied. */}
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
        <span className="font-medium uppercase tracking-wide text-faint">
          {t(accept ? "prop.crit.h" : "prop.crit.hReject")}
        </span>
        <span className="text-muted">{t(accept ? "prop.crit.both" : "prop.crit.bothReject")}</span>
      </p>
      <div className="mt-2.5 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
        <Condition
          title={t("prop.crit.quorumH")}
          rule={t("prop.crit.quorumRule", { pct: thresholdBips / 100, members: eligibleCount })}
          status={quorumStatus}
          good={accept ? quorumMet : !quorumMet}
          value={pct(cast, eligibleCount)}
          need={thresholdBips / 100}
          count={t("prop.crit.quorumCount", { cast, needed: quorumNeeded })}
        />
        <Condition
          title={t("prop.crit.majorityH")}
          rule={t(accept ? "prop.crit.majorityRule" : "prop.crit.majorityRuleReject", {
            pct: majorityBips / 100,
          })}
          status={majorityStatus}
          good={accept ? majorityMet : !majorityMet}
          value={pct(deciding, cast)}
          need={majorityBips / 100}
          // Before anyone has voted there is no "needed" to state: the bar moves with every vote
          // cast, since it is a share of them.
          count={
            cast > 0
              ? accept
                ? t("prop.crit.majorityCount", { for: votesFor, needed: majorityNeeded })
                : t("prop.crit.majorityCountReject", { against: votesAgainst, needed: majorityNeeded })
              : t("prop.crit.noVotes")
          }
        />
      </div>
    </div>
  );
}
