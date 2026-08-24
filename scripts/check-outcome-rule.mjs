// THE VOTING RULE, ASSERTED.
//
// evaluateOutcome decides whether a public finding is published about a named business, so its
// edge cases deserve a test rather than a careful reading. Two of the cases below are defects that
// actually shipped and were found by running the mechanism, not by reading it:
//
//   - a case published on 2 substantive votes out of 48 members, because 14 abstentions counted
//     toward turnout and then removed themselves from the denominator of the supermajority, which
//     RAISED the weight of whoever remained;
//   - an all-abstain quorum, where the two thirds bar computes to zero and "denyVotes >= 0" is
//     trivially true, so a case could substantiate with nobody in favour.
//
// Run from the build. No database and no network: the rule is pure arithmetic and should be
// testable as such.
// Imports the REAL function, via Node type stripping, because the earlier version tested a
// transcription of the rule kept in this file. That version passed while evaluateOutcome had its
// decisive floor disabled behind `if (false && ...)`, which is precisely the change it existed to
// catch. A guard that cannot fail is not a guard.
const { evaluateOutcome, QUORUM_TURNOUT_BIPS, DENY_MAJORITY_BIPS } = await import(
  new URL("../src/lib/outcome-rule.ts", import.meta.url).href
);

const QUORUM = QUORUM_TURNOUT_BIPS;
const MAJORITY = DENY_MAJORITY_BIPS;
const evaluate = (memberCount, votesCast, denyVotes, decisiveVotes, opts = {}) =>
  evaluateOutcome(memberCount, votesCast, denyVotes, decisiveVotes, opts).decided;



const M = 48; // members
const floor = Math.ceil((QUORUM / 10000) * M);
const cases = [
  ["short turnout fails quorum", [M, 2, 1, 1], "FAILED_QUORUM"],
  ["thin majority cannot carry a case", [M, 16, 2, 2], "FAILED_QUORUM"],
  ["all abstain never substantiates", [M, 16, 0, 0], "FAILED_QUORUM"],
  ["one short of the decisive floor", [M, 20, floor - 1, floor - 1], "FAILED_QUORUM"],
  ["exactly at both floors, unanimous", [M, floor, floor, floor], "DENIED"],
  ["quorum met, majority short", [M, 20, 6, 20], "CLEARED"],
  // 6667 bips is fractionally ABOVE two thirds, so an exact 12 of 18 falls one short. Asserted
  // rather than left as a surprise: the difference decides real cases.
  ["exact two thirds falls one short", [M, 18, 12, 18], "CLEARED"],
  ["one above two thirds substantiates", [M, 18, 13, 18], "DENIED"],
  ["abstentions cannot lower the bar", [M, 30, 10, 16], "CLEARED"],
];

let bad = 0;
for (const [name, args, want] of cases) {
  const got = evaluate(...args);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(36)} -> ${got}${ok ? "" : ` (wanted ${want})`}`);
}

if (bad) {
  console.error(`outcome-rule: ${bad} failure(s)`);
  process.exit(1);
}
console.log(`outcome-rule: OK. ${cases.length} cases, quorum ${QUORUM / 100}% (${floor} of ${M}), majority ${(MAJORITY / 100).toFixed(2)}%.`);
