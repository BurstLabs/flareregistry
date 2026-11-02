// THE NETWORK RATES, ASSERTED.
//
// networkRates is what wallets turn into "stakers earned about N times more per FLR than delegators",
// so a wrong number is shown to users as a fact. Its edge cases matter more than its happy path: a
// window with an epoch missing, rows ingested before stakeWeight existed, and Songbird (no P-chain
// staking at all) must all give NO figure rather than a partial one.
//
// Run from the build. No database and no network. Imports the REAL functions via Node type stripping,
// the same way check-outcome-rule.mjs does, so it cannot pass against a transcription.
const { networkRates, rankYield } = await import(new URL("../src/lib/yield-rank.ts", import.meta.url).href);
const { stakeWeightOf } = await import(new URL("../src/lib/fsp-rewards.ts", import.meta.url).href);

const problems = [];
const check = (label, ok) => ok || problems.push(label);
const near = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
const E = 10n ** 18n;
const wei = (tokens) => (BigInt(tokens) * E).toString();

const row = (epochId, voter, { wNat, del, stk, stake }) => ({
  epochId,
  voter,
  wNatWeight: wei(wNat),
  wNatCappedWeight: wei(wNat),
  delegatorReward: wei(del),
  goodStanding: true,
  passes: 3,
  failures: [],
  stakerReward: stk == null ? null : wei(stk),
  stakeWeight: stake == null ? null : wei(stake),
});

// Two epochs, two providers. Delegators: 300 / 3,000,000. Stakers: 1,200 / 2,000,000.
const rows = [
  row(10, "0xa", { wNat: 1_000_000, del: 100, stk: 500, stake: 1_000_000 }),
  row(10, "0xb", { wNat: 500_000, del: 50, stk: 100, stake: 0 }),
  row(11, "0xa", { wNat: 1_000_000, del: 100, stk: 500, stake: 1_000_000 }),
  row(11, "0xb", { wNat: 500_000, del: 50, stk: 100, stake: 0 }),
];
const r = networkRates(rows, [10, 11]);
check("returns a figure for a complete window", r !== null);
if (r) {
  check("delegators = total WNAT reward / total wNatWeight", near(r.delegators.ratePerEpoch, 300 / 3_000_000));
  check("stakers = total MIRROR reward / total stake weight", near(r.stakers.ratePerEpoch, 1_200 / 2_000_000));
  check("ratio = stakers / delegators", near(r.stakersToDelegators, 1_200 / 2_000_000 / (300 / 3_000_000)));
  check("annualised as rate x 365 / 3.5", near(r.stakers.annualRate, ((1_200 / 2_000_000) * 365) / 3.5));
  check("echoes the window", JSON.stringify(r.epochs) === "[10,11]");
  check("carries a method", typeof r.method === "string" && r.method.length > 50);
  check("method has no em dash", !r.method.includes("\u2014"));
}

check("rows outside the window are ignored", JSON.stringify(networkRates([...rows, row(9, "0xa", { wNat: 1, del: 1, stk: 9_999, stake: 1 })], [10, 11])) === JSON.stringify(r));
check("an epoch with no rows gives no figure", networkRates(rows, [10, 11, 12]) === null);
check("a row whose stakeWeight is not filled gives no figure", networkRates([...rows.slice(0, 3), { ...rows[3], stakeWeight: null }], [10, 11]) === null);
check("a row with no stakerReward gives no figure", networkRates([...rows.slice(0, 3), { ...rows[3], stakerReward: null }], [10, 11]) === null);
check("rows from before the column (field absent) give no figure", networkRates(rows.map(({ stakeWeight, ...rest }) => rest), [10, 11]) === null);

const songbird = rows.map((x) => ({ ...x, stakerReward: "0", stakeWeight: "0" }));
check("no stake at all (Songbird) gives no figure", networkRates(songbird, [10, 11]) === null);
check("no delegator reward gives no figure", networkRates(rows.map((x) => ({ ...x, delegatorReward: "0" })), [10, 11]) === null);
check("no rows gives no figure", networkRates([], [10, 11]) === null);

// The ranking must not notice the new fields: same output with and without them.
const bare = rows.map(({ stakerReward, stakeWeight, ...rest }) => rest);
check("rankYield ignores stakerReward/stakeWeight", JSON.stringify(rankYield(rows, [10, 11])) === JSON.stringify(rankYield(bare, [10, 11])));

// stakeWeightOf: the per-entity sum the ingest stores.
check("sums nodeWeights", stakeWeightOf({ nodeIds: ["0x1", "0x2"], nodeWeights: ["3000000000000000000000000", "5"] }) === "3000000000000000000000005");
check("no nodes is zero stake", stakeWeightOf({ nodeIds: [], nodeWeights: [] }) === "0");
check("no nodes and no weights listed is zero stake", stakeWeightOf({ nodeIds: [] }) === "0");
check("nodes without weights is unknown, not zero", stakeWeightOf({ nodeIds: ["0x1"] }) === null);
check("unreadable weights are unknown, not zero", stakeWeightOf({ nodeIds: ["0x1"], nodeWeights: ["abc"] }) === null);
check("missing entry is unknown", stakeWeightOf(undefined) === null);

if (problems.length) {
  console.error("check-network-rates: FAILED");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("check-network-rates: ok");
