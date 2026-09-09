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

// THE NEW-PROVIDER HOLDS. Two independent clocks, and a provider lists only when both have run.
// Asserted because the second was added after a change to the first listed three providers early,
// and the interaction is invisible from either function on its own.
//
// NO catch() HERE. The first version of this block imported lib/governance, which pulls in prisma,
// failed, and swallowed the error, so every assertion below silently did not run. A guard that
// cannot fail is not a guard, so an unimportable module is now a hard failure.
{
  const hold = await import(new URL("../src/lib/hold-rule.ts", import.meta.url).href);
  const now = new Date("2026-08-24T12:00:00Z");
  const days = (n) => new Date(now.getTime() - n * 86400000);
  // The fourth column is what the listing was BEFORE the claim: only a chain-only registration
  // serves a window, because an imported listing was already carried in the feed and holding it
  // would remove a provider that was already there.
  const rows = [
    ["chain-only, claimed today", days(400), days(0), "onchain", true],
    ["chain-only, claimed 40d ago", days(400), days(40), "onchain", false],
    ["IMPORTED, claimed today", days(400), days(0), "imported", false],
    ["imported, claimed today, new on-chain", days(5), days(0), "imported", true],
    ["chain-only 5d ago, claimed 5d ago", days(5), days(5), "onchain", true],
    ["never claimed, new on-chain", days(5), null, null, true],
    ["never claimed, long on-chain", days(400), null, null, false],
  ];
  let bad = 0;
  for (const [name, seen, claimed, src, want] of rows) {
    const got = hold.isHeldNewProvider(seen, now) || hold.isHeldNewClaim(claimed, src, now);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} hold: ${name.padEnd(34)} -> ${got ? "held" : "lists"}`);
  }
  // holdAnchor must prefer the earlier first-seen date over the row date, and ignore a later one.
  const rowDate = new Date("2026-08-15T00:00:00Z");
  const earlier = new Date("2026-06-22T00:00:00Z");
  const later = new Date("2026-09-01T00:00:00Z");
  const checks = [
    ["holdAnchor prefers an earlier firstSeenAt", hold.holdAnchor({ createdAt: rowDate, firstSeenAt: earlier }).getTime() === earlier.getTime()],
    ["holdAnchor ignores a later firstSeenAt", hold.holdAnchor({ createdAt: rowDate, firstSeenAt: later }).getTime() === rowDate.getTime()],
    ["holdAnchor falls back to createdAt", hold.holdAnchor({ createdAt: rowDate, firstSeenAt: null }).getTime() === rowDate.getTime()],
    ["claimAnchor takes the earliest claim", hold.claimAnchor({ addresses: [
        { verified: true, verifiedAt: later }, { verified: true, verifiedAt: earlier },
        { verified: false, verifiedAt: rowDate }] }).getTime() === earlier.getTime()],
    ["claimAnchor is null when unclaimed", hold.claimAnchor({ addresses: [{ verified: false, verifiedAt: rowDate }] }) === null],
  ];
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  }
  if (bad) { console.error(`hold-rule: ${bad} failure(s)`); process.exit(1); }
  console.log("hold-rule: OK. entity clock and claim clock both enforced.");
}

// THE PROPOSAL PAYLOAD. What a submission burns 100 FLR to write on chain, permanently, naming
// somebody. Asserted against the shipped function, not a copy: lib/proposal-payload has no React
// or wallet imports precisely so this can run here.
{
  const pp = await import(new URL("../src/lib/proposal-payload.ts", import.meta.url).href);
  let bad = 0;
  const ok = (name, cond) => {
    if (!cond) bad++;
    console.log(`  ${cond ? "ok  " : "FAIL"} payload: ${name}`);
  };

  // Round-trips as strict JSON, which is the convention proposals 1 to 11 follow.
  const basic = pp.buildProposalPayload({
    title: "Rotko", address: "0xB70c6987626A96Df66C9068bd10b84Ecb8e949df",
    description: "Running multiple identities", url: "https://forum.flare.network/t/x/577",
  });
  // Parsed defensively: if the builder ever stops producing JSON, this guard should SAY so rather
  // than crash with a parse error halfway through the run.
  let parsed = null;
  try { parsed = JSON.parse(basic); } catch { /* reported below */ }
  ok("is valid JSON", parsed !== null && typeof parsed === "object");
  if (parsed === null) { console.error("proposal-payload: builder no longer emits JSON"); process.exit(1); }
  ok("keys are name/address/description/url",
     ["name", "address", "description", "url"].every((k) => k in parsed));
  ok("address is lowercased", parsed.address === "0xb70c6987626a96df66c9068bd10b84ecb8e949df");

  // An apostrophe is how the historical entries became unparseable. It must survive.
  const quoted = pp.buildProposalPayload({
    title: "O'Brien's node", address: "", description: 'He said "no" and left.\nThen returned.', url: "https://x.test",
  });
  let q = null;
  try { q = JSON.parse(quoted); } catch { /* reported below */ }
  if (q === null) { console.error("proposal-payload: a quoted field broke the JSON"); process.exit(1); }
  ok("apostrophe survives round-trip", q.name === "O'Brien's node");
  ok("double quotes survive round-trip", q.description.includes('"no"'));
  ok("newline survives round-trip", q.description.includes("\n"));

  ok("fields are trimmed",
     JSON.parse(pp.buildProposalPayload({ title: "  T  ", address: "", description: " d ", url: " https://a.test " })).name === "T");
  ok("a non-address subject is left alone",
     JSON.parse(pp.buildProposalPayload({ title: "t", address: "not-an-address", description: "d", url: "https://a.test" })).address === "not-an-address");

  ok("isAddress accepts a checksummed address", pp.isAddress("0xB70c6987626A96Df66C9068bd10b84Ecb8e949df"));
  ok("isAddress rejects a short address", !pp.isAddress("0xb70c"));
  ok("isAddress rejects a non-hex address", !pp.isAddress("0x" + "z".repeat(40)));

  if (bad) { console.error(`proposal-payload: ${bad} failure(s)`); process.exit(1); }
  console.log("proposal-payload: OK. strict JSON, escaping and address handling asserted.");
}

// THE DISCUSSION LINK. Mandatory, and "any https URL" was too weak a test: a link back to the
// portal passed, which is self-referential and gives a reader nothing.
{
  const pp = await import(new URL("../src/lib/proposal-payload.ts", import.meta.url).href);
  let bad = 0;
  const ok = (name, cond) => { if (!cond) bad++; console.log(`  ${cond ? "ok  " : "FAIL"} url: ${name}`); };
  ok("accepts a forum thread", pp.checkForumUrl("https://forum.flare.network/t/x/577") === null);
  ok("accepts www.", pp.checkForumUrl("https://www.forum.flare.network/t/x") === null);
  ok("rejects the portal itself",
     pp.checkForumUrl("https://portal.flare.network/managementProposal/view/13-0x1e91") === "notForum");
  ok("rejects another host", pp.checkForumUrl("https://example.com/thread") === "notForum");
  ok("rejects empty", pp.checkForumUrl("   ") === "empty");
  ok("rejects a non-url", pp.checkForumUrl("forum.flare.network/t/x") === "notUrl");
  ok("rejects javascript:", pp.checkForumUrl("javascript:alert(1)") === "notUrl");
  ok("title bounds are sane", pp.TITLE_MAX === 80 && pp.TITLE_MIN === 3);
  ok("description bounds are sane", pp.DESCRIPTION_MAX === 500 && pp.DESCRIPTION_MIN === 20);
  if (bad) { console.error(`proposal-url: ${bad} failure(s)`); process.exit(1); }
  console.log("proposal-url: OK. discussion link must be a forum thread.");
}
