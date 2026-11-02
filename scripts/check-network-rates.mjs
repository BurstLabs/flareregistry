// THE NETWORK RATES, ASSERTED.
//
// networkRates is what wallets turn into "stakers earned about N times more per FLR than delegators",
// so a wrong number is shown to users as a fact. Its edge cases matter more than its happy path: a
// window with an epoch missing, rows ingested before stakeWeight existed, and Songbird (no P-chain
// staking at all) must all give NO figure rather than a partial one.
//
// Since 2 November 2026 the stakers' rate also counts P-chain validator rewards (ValidatorRewardManager,
// from Flare's reward-scripts files): FTSO part + validator part, but only when the validator part covers
// the whole window. A window Flare has not finished publishing must fall back to the FTSO part with
// includesValidatorRewards: false, never a sum over fewer epochs, and Songbird must never carry it.
//
// Run from the build. No database and no network. Imports the REAL functions via Node type stripping,
// the same way check-outcome-rule.mjs does, so it cannot pass against a transcription.
const { networkRates, rankYield, validatorRate, NETWORK_RATES_METHOD, NETWORK_RATES_METHOD_FTSO_ONLY } = await import(
  new URL("../src/lib/yield-rank.ts", import.meta.url).href
);
const { stakeWeightOf } = await import(new URL("../src/lib/fsp-rewards.ts", import.meta.url).href);
const { summariseValidatorRewards } = await import(new URL("./validator-rewards-parse.mjs", import.meta.url).href);

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
  check("no validator rows: flagged as not including validator rewards", r.includesValidatorRewards === false);
  check("no validator rows: stakers is the FTSO part alone", near(r.stakers.ratePerEpoch, r.stakers.ftso.ratePerEpoch));
  check("no validator rows: stakers.ftso = MIRROR / stake weight", near(r.stakers.ftso.ratePerEpoch, 1_200 / 2_000_000));
  check("no validator rows: no stakers.validator", !("validator" in r.stakers));
  check("no validator rows: the method says so", r.method === NETWORK_RATES_METHOD_FTSO_ONLY);
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

// VALIDATOR REWARDS. Per epoch: 3,000 after fee on 10,000,000 staked in epoch 10, 1,000 on 10,000,000
// in epoch 11, so the window's validator rate is 4,000 / 20,000,000 (summed, not averaged per epoch).
const vrow = (epochId, reward, stake) => ({ epochId, stakerReward: wei(reward), totalStake: wei(stake) });
const vrows = [vrow(10, 3_000, 10_000_000), vrow(11, 1_000, 10_000_000)];
const ftsoRate = 1_200 / 2_000_000;
const valRate = 4_000 / 20_000_000;
const delRate = 300 / 3_000_000;
const v = networkRates(rows, [10, 11], vrows);
check("with validator rows: returns a figure", v !== null);
if (v) {
  check("with validator rows: flagged as including validator rewards", v.includesValidatorRewards === true);
  check("stakers.ftso is unchanged by validator rows", near(v.stakers.ftso.ratePerEpoch, ftsoRate));
  check("stakers.validator = total after-fee validator rewards / total stake", near(v.stakers.validator?.ratePerEpoch, valRate));
  check("stakers = ftso + validator", near(v.stakers.ratePerEpoch, ftsoRate + valRate));
  check("stakers.annualRate = combined rate x 365 / 3.5", near(v.stakers.annualRate, ((ftsoRate + valRate) * 365) / 3.5));
  check("stakers.validator.annualRate", near(v.stakers.validator?.annualRate, (valRate * 365) / 3.5));
  check("stakers.ftso.annualRate", near(v.stakers.ftso.annualRate, (ftsoRate * 365) / 3.5));
  check("ratio uses the combined staker rate", near(v.stakersToDelegators, (ftsoRate + valRate) / delRate));
  check("delegators are unchanged by validator rows", near(v.delegators.ratePerEpoch, delRate) && JSON.stringify(v.delegators) === JSON.stringify(r?.delegators));
  // Redoubt's wallets reject a feed whose ratio is not stakers.ratePerEpoch / delegators.ratePerEpoch (1%).
  check("ratio is the quotient of the two top-level rates", Math.abs(v.stakers.ratePerEpoch / v.delegators.ratePerEpoch / v.stakersToDelegators - 1) < 1e-12);
  check("with validator rows: the full method", v.method === NETWORK_RATES_METHOD);
  check("existing fields keep their names and types", ["epochs", "delegators", "stakers", "stakersToDelegators", "method"].every((k) => k in v) && typeof v.stakers.ratePerEpoch === "number" && typeof v.stakers.annualRate === "number");
}
check("the two methods differ and neither has an em dash", NETWORK_RATES_METHOD !== NETWORK_RATES_METHOD_FTSO_ONLY && ![NETWORK_RATES_METHOD, NETWORK_RATES_METHOD_FTSO_ONLY].some((m) => m.includes("\u2014")));
check("the fallback method names the flag", NETWORK_RATES_METHOD_FTSO_ONLY.includes("includesValidatorRewards is false"));

// A window Flare has not finished publishing: fall back to the FTSO part, flagged, never null.
const fallback = (label, vr) => {
  const f = networkRates(rows, [10, 11], vr);
  check(`${label}: still a figure`, f !== null);
  check(`${label}: flagged false`, f?.includesValidatorRewards === false);
  check(`${label}: stakers is the FTSO part alone`, near(f?.stakers.ratePerEpoch, ftsoRate) && !("validator" in (f?.stakers ?? {})));
  check(`${label}: same as with no validator rows`, JSON.stringify(f) === JSON.stringify(r));
};
fallback("newest epoch's validator rewards not published", [vrows[0]]);
fallback("oldest epoch's validator rewards missing", [vrows[1]]);
fallback("validator rows only outside the window", [vrow(9, 3_000, 10_000_000), vrow(12, 1_000, 10_000_000)]);
fallback("empty validator rows", []);
fallback("validator rows null", null);
fallback("an epoch with zero stake", [vrows[0], vrow(11, 1_000, 0)]);
fallback("an unreadable stake", [vrows[0], { ...vrows[1], totalStake: "abc" }]);
fallback("an unreadable reward", [vrows[0], { ...vrows[1], stakerReward: null }]);
fallback("a negative reward", [vrows[0], { ...vrows[1], stakerReward: "-1" }]);
fallback("no validator rewards at all", [vrow(10, 0, 10_000_000), vrow(11, 0, 10_000_000)]);
check("an epoch with zero validator rewards still counts when the window has some", near(validatorRate([vrow(10, 0, 10_000_000), vrows[1]], [10, 11]), 1_000 / 20_000_000));
check("validator rows outside the window are ignored", JSON.stringify(networkRates(rows, [10, 11], [...vrows, vrow(9, 9_999_999, 1)])) === JSON.stringify(v));
check("a duplicated validator epoch counts once", JSON.stringify(networkRates(rows, [10, 11], [...vrows, vrows[1]])) === JSON.stringify(v));
check("validator rows do not rescue an incomplete FTSO window", networkRates(rows, [10, 11, 12], [...vrows, vrow(12, 1_000, 10_000_000)]) === null);
check("validator rows do not rescue unfilled stake weights", networkRates([...rows.slice(0, 3), { ...rows[3], stakeWeight: null }], [10, 11], vrows) === null);
check("validator rows never give Songbird a figure", networkRates(songbird, [10, 11], vrows) === null);
check("validatorRate on an empty window is null", validatorRate(vrows, []) === null);

// THE PARSER over Flare's reward-scripts files. A pool of 1,000 FLR over three nodes, split exactly as
// reward-scripts' calculateRewardAmounts splits it:
//   A rewarded, 3,000,000 staked (1,000,000 self-bond, delegators 1,500,000 + 500,000), fee 20%:
//     nodeReward 600, fee 120, self-bond 160 -> validator 280, delegators 240 + 80
//   B passed uptime, failed minimal conditions, 2,000,000 staked: 400 burned
//   C failed uptime, 1,000,000 staked: no share
const G = 10n ** 9n; // P-chain units per FLR
const gwei = (tokens) => (BigInt(tokens) * G).toString();
const nodeA = {
  nodeId: "NodeID-A", uptimeEligible: true, eligible: true, fee: 200000,
  totalStakeAmount: gwei(3_000_000), totalSelfBond: gwei(1_000_000), normalDelegations: gwei(2_000_000),
  nodeRewardAmount: wei(600), validatorRewardAmount: wei(280),
  delegators: [{ amount: gwei(1_500_000), delegatorRewardAmount: wei(240) }, { amount: gwei(500_000), delegatorRewardAmount: wei(80) }],
};
const nodeB = { nodeId: "NodeID-B", uptimeEligible: true, eligible: false, fee: 100000, totalStakeAmount: gwei(2_000_000), totalSelfBond: gwei(500_000), normalDelegations: gwei(1_500_000), burnedRewardAmount: wei(400), delegators: [] };
const nodeC = { nodeId: "NodeID-C", uptimeEligible: false, eligible: false, fee: 0, totalStakeAmount: gwei(1_000_000), totalSelfBond: gwei(1_000_000), normalDelegations: "0", delegators: [] };
const dataJson = { configFileData: { REWARD_EPOCH: 444, REWARD_AMOUNT_EPOCH_WEI: wei(1_000) }, stakingVotePowerBlock: 72835277, recipients: [] };
const parsed = summariseValidatorRewards(444, dataJson, [nodeA, nodeB, nodeC]);
check("parser: a consistent epoch is accepted", parsed.ok === true);
if (parsed.ok) {
  const p = parsed.value;
  check("parser: stakerReward = rewarded nodes' reward minus the validator fee", p.stakerReward === wei(480));
  check("parser: feeReward = nodeReward x fee / 1e6", p.feeReward === wei(120));
  check("parser: burnedReward", p.burnedReward === wei(400));
  check("parser: delegatorReward is the delegators' part alone", p.delegatorReward === wei(320));
  check("parser: totalStake counts every node, in wei", p.totalStake === wei(6_000_000));
  check("parser: delegatedStake and selfBond in wei", p.delegatedStake === wei(3_500_000) && p.selfBond === wei(2_500_000));
  check("parser: rewardAmount is the pool", p.rewardAmount === wei(1_000));
  check("parser: node counts", p.nodes === 3 && p.rewardedNodes === 1);
  check("parser: staking vote-power block", p.stakingVpBlock === 72835277);
  check("parser output feeds validatorRate", near(validatorRate([{ epochId: 444, ...p }], [444]), 480 / 6_000_000));
}
const refused = (label, data, nodes, epoch = 444) => check(`parser refuses ${label}`, summariseValidatorRewards(epoch, data, nodes).ok === false);
refused("a file for another epoch", dataJson, [nodeA, nodeB, nodeC], 445);
refused("a pool that does not add up (1 wei short)", { ...dataJson, configFileData: { ...dataJson.configFileData, REWARD_AMOUNT_EPOCH_WEI: (BigInt(wei(1_000)) + 1n).toString() } }, [nodeA, nodeB, nodeC]);
refused("a missing pool", { ...dataJson, configFileData: { REWARD_EPOCH: 444 } }, [nodeA, nodeB, nodeC]);
refused("no configFileData", {}, [nodeA, nodeB, nodeC]);
refused("no nodes", dataJson, []);
refused("nodes that are not a list", dataJson, { nodeA });
refused("a node with no stake", dataJson, [nodeA, nodeB, { ...nodeC, totalStakeAmount: undefined }]);
refused("a rewarded node with no reward amount", dataJson, [{ ...nodeA, nodeRewardAmount: undefined }, nodeB, nodeC]);
refused("a delegator with no reward", dataJson, [{ ...nodeA, delegators: [{ amount: "1" }] }, nodeB, nodeC]);
refused("a fee above 100%", dataJson, [{ ...nodeA, fee: 1_000_001 }, nodeB, nodeC]);
refused("an unrewarded node with no burned amount", dataJson, [nodeA, { ...nodeB, burnedRewardAmount: undefined }, nodeC]);
refused("a validator paid less than its fee", dataJson, [{ ...nodeA, validatorRewardAmount: wei(100), delegators: [{ amount: "1", delegatorRewardAmount: wei(500) }] }, nodeB, nodeC]);
check("parser: a node that failed uptime needs no reward fields", summariseValidatorRewards(444, { ...dataJson, configFileData: { ...dataJson.configFileData, REWARD_AMOUNT_EPOCH_WEI: wei(600) } }, [nodeA, nodeC]).ok === true);

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
