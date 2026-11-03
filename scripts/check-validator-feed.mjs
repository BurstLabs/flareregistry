// THE VALIDATOR FEED, ASSERTED.
//
// /api/feed/validators.json is what a wallet's staking picker ranks P-chain validators on, so a wrong
// rate is shown to users as what they would have earned. Two halves are checked here:
//
//   1. validatorNodeRows, against a trimmed copy of Flare's REAL epoch 446 files
//      (scripts/fixtures/validator-epoch-446.json: 10 nodes chosen to cover a plain 20% node, the 100%
//      fee entity, an overboosted node, a node with no FTSO provider, a node that failed uptime, two
//      whose provider failed minimal conditions, a multi-node entity and a node its provider lists at
//      weight 0), with every per-FLR rate worked out again here, apart from the code under test, plus
//      every way the files can fail to hold together, each of which must be refused.
//   2. rankValidators and validatorWindow, over synthetic windows: missed epochs and their reasons, a
//      node that left mid-window, a 100% fee node, an epoch gap, rewardingWeight 0, ties.
//
// Run from the build. No database and no network. Imports the REAL functions via Node type stripping,
// the same way check-network-rates.mjs does, so it cannot pass against a transcription.
import { readFileSync } from "node:fs";

const { validatorNodeRows, nodeIdToHex } = await import(new URL("./validator-rewards-parse.mjs", import.meta.url).href);
const { rankValidators, validatorWindow, validatorFeedMethod } = await import(
  new URL("../src/lib/validator-feed-rank.ts", import.meta.url).href
);
const { YIELD_WINDOW_EPOCHS } = await import(new URL("../src/lib/yield-rank.ts", import.meta.url).href);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/validator-epoch-446.json", import.meta.url), "utf8"));

const problems = [];
const check = (label, ok) => ok || problems.push(label);
const near = (a, b, rel = 1e-12) => typeof a === "number" && Math.abs(a - b) <= rel * Math.max(1e-30, Math.abs(b));
const clone = (x) => structuredClone(x);
const E18 = 10n ** 18n;
const G = 10n ** 9n; // P-chain units per FLR

// What one staked FLR earned, worked out apart from the code under test: reward / weight to 18 decimal
// places in BigInt, both wei-scale.
const perFlr = (rewardWei, weightWei) => (weightWei === 0n ? 0 : Number((rewardWei * E18) / weightWei) / 1e18);

// ---------------------------------------------------------------------------------------------------
// 1. THE PARSER, ON FLARE'S REAL FILES.
// ---------------------------------------------------------------------------------------------------
const ID = {
  plain: "NodeID-53Yqr6UiB8KYKj3HFadr27va9zLNkypmc", // 20% fee, its voter lists it (the cb58 test vector)
  full1: "NodeID-7aU2dDeBVu4btx4wbt44ACqyJeQRjCZMi", // 100% fee entity, node 1
  full2: "NodeID-KywEC9cXm8P4KezUkovM5oA1rLTTFDe6e", // 100% fee entity, node 2
  unlinked: "NodeID-4QpT6xPQNKiyBfuKQNC8AyU3oLGVaFFwb", // ftsoAddress zero: no FTSO provider
  uptime: "NodeID-FERvNWfCH4mjCSoFnjF4YouDBuYZCpfKm", // failed uptime, provider eligible
  conditions: "NodeID-D3QKd6XxLnrKowkziZJSG4RNLtffz8ESk", // provider registered, failed minimal conditions
  multiA: "NodeID-BeE5PDQkbtgbeDsxJMc2diKWyE95HtuHR", // multi-node entity, listed with weight
  multiZero: "NodeID-MKeSBNK4dMPNnvPPxb2xEjbeyyJMc9tfc", // same entity, listed at nodeWeight 0: no MIRROR
  overboost: "NodeID-KiAUisCU8UvXGnMRiUvoeyWneSdUm987", // 50% fee, rewardingWeight below its stake
  unregistered: "NodeID-HGNPxSh8dZqCNCmHfMMNWYC8CNQiUwDWK", // provider set but not registered in FSP
};

check("fixture is epoch 446", fixture.epochId === 446);
check("fixture holds the 10 chosen nodes", fixture.nodes.length === 10 && Object.values(ID).every((id) => fixture.nodes.some((n) => n.nodeId === id)));

// cb58: "NodeID-" + base58(20 bytes + last 4 bytes of their sha256). Known pair from epoch 446: voter
// 0x5e53fa91... lists node 0x2c5bea62... in reward-epoch-info.json, and nodes-data.json prints it as:
check("cb58 test vector decodes", nodeIdToHex(ID.plain) === "0x2c5bea62f08383745d9be382eed6b532555aaa5e");
check(
  "the voter that lists the test vector is the one in the file",
  fixture.rewardEpochInfo.voterRegistrationInfo.some(
    (e) => e.voterRegistrationInfo.voter === "0x5e53fa91ad7ce06b1510f03bfaac3ba77558ded8" && e.voterRegistrationInfo.nodeIds.includes("0x2c5bea62f08383745d9be382eed6b532555aaa5e"),
  ),
);
check("every fixture node ID decodes", fixture.nodes.every((n) => /^0x[0-9a-f]{40}$/.test(nodeIdToHex(n.nodeId) ?? "")));
check("a one-character change fails the checksum", nodeIdToHex(ID.plain.slice(0, -1) + "d") === null);
check("a non-base58 character is refused", nodeIdToHex(ID.plain.slice(0, -1) + "0") === null);
check("no NodeID- prefix is refused", nodeIdToHex(ID.plain.slice(7)) === null);
check("an empty node ID is refused", nodeIdToHex("NodeID-") === null && nodeIdToHex("NodeID-1") === null);
check("a non-string is refused", nodeIdToHex(undefined) === null && nodeIdToHex(42) === null);

const parsed = validatorNodeRows(446, fixture.nodes, fixture.rewardEpochInfo, fixture.rewardDistribution);
check(`parser accepts the real epoch${parsed.ok ? "" : ": " + parsed.reason}`, parsed.ok === true);
const rows = parsed.ok ? parsed.value : [];
const rowOf = (id) => rows.find((r) => r.nodeId === id);
check("one row per node, in file order", rows.map((r) => r.nodeId).join() === fixture.nodes.map((n) => n.nodeId).join());

// Independent expectations straight from the raw fixture.
const raw = (id) => fixture.nodes.find((n) => n.nodeId === id);
const voterOf = (hex) => fixture.rewardEpochInfo.voterRegistrationInfo.map((e) => e.voterRegistrationInfo).find((v) => v.nodeIds.includes(hex));
const mirrorPaid = (hex) =>
  fixture.rewardDistribution.rewardClaims.filter((c) => c.body.claimType === 3 && c.body.beneficiary.toLowerCase() === hex).reduce((s, c) => s + BigInt(c.body.amount), 0n);
const expectOf = (id) => {
  const n = raw(id);
  const hex = nodeIdToHex(id);
  const v = voterOf(hex);
  const rewarded = n.uptimeEligible === true && n.eligible === true;
  const nodeReward = rewarded ? BigInt(n.nodeRewardAmount) : 0n;
  const fee = (nodeReward * BigInt(n.fee)) / 1_000_000n;
  const rewardingWeight = BigInt(n.rewardingWeight) * G;
  const mirrorWeight = v ? BigInt(v.nodeWeights[v.nodeIds.indexOf(hex)]) : 0n;
  return {
    rewarded,
    net: rewarded ? perFlr(nodeReward - fee, rewardingWeight) : 0,
    gross: rewarded ? perFlr(nodeReward, rewardingWeight) : 0,
    ftso: perFlr(mirrorPaid(hex), mirrorWeight),
    fee,
    nodeReward,
    mirrorWeight,
  };
};

// The plain 20% node, field by field.
const plain = rowOf(ID.plain);
check("plain: identity is the voter that lists it", plain?.identity === "0x5e53fa91ad7ce06b1510f03bfaac3ba77558ded8");
check("plain: delegationAddress is its ftsoAddress, lowercased", plain?.delegationAddress === "0xc8142e2b2f6f8adfd34d8e6735f389667f9e2c0a");
check("plain: feePpm", plain?.feePpm === 200000);
check("plain: stake in wei (P-chain units x 1e9)", plain?.stake === "43483300675058334000000000");
check("plain: rewardingWeight and cappedWeight in wei", plain?.rewardingWeight === "43483300675058334000000000" && plain?.cappedWeight === plain?.rewardingWeight);
check("plain: nodeReward is nodeRewardAmount", plain?.nodeReward === "14771850178824984354723");
check("plain: feeReward = nodeReward x fee / 1e6, floored as Flare does", plain?.feeReward === "2954370035764996870944");
check("plain: mirrorReward is the MIRROR claims to its 20 bytes", plain?.mirrorReward === "40086206242982508043025");
check("plain: mirrorWeight is its FSP nodeWeight", plain?.mirrorWeight === "45734999675058334000000000");
check("plain: stakeEnd", plain?.stakeEnd === 1794794400);
check("plain: eligibility", plain?.uptimeEligible === true && plain?.eligible === true);
check("plain: MIRROR claims of other types to the same entity do not leak in", plain?.mirrorReward === mirrorPaid(nodeIdToHex(ID.plain)).toString());

// Every row against the independent expectation.
for (const r of rows) {
  const x = expectOf(r.nodeId);
  const n = raw(r.nodeId);
  check(`${r.nodeId}: nodeReward`, r.nodeReward === x.nodeReward.toString());
  check(`${r.nodeId}: feeReward`, r.feeReward === x.fee.toString());
  check(`${r.nodeId}: mirrorWeight`, r.mirrorWeight === x.mirrorWeight.toString());
  check(`${r.nodeId}: stake`, r.stake === (BigInt(n.totalStakeAmount) * G).toString());
  check(`${r.nodeId}: feePpm`, r.feePpm === n.fee);
  check(`${r.nodeId}: stakeEnd`, r.stakeEnd === n.stakeEnd);
}

// The rates, ranked over the one real epoch.
const real = rankValidators(rows, [446]);
const scoreOf = (id) => real.validators.find((v) => v.nodeId === id);
check("ranked: every node scored", real.validators.length === 10);
check("ranked: epochs echoed", JSON.stringify(real.epochs) === "[446]");
check("ranked: totalStake is every node's stake", real.totalStake === fixture.nodes.reduce((s, n) => s + BigInt(n.totalStakeAmount) * G, 0n).toString());
for (const v of real.validators) {
  const x = expectOf(v.nodeId);
  check(`${v.nodeId}: validatorRatePerEpoch = (nodeReward - fee) / rewardingWeight`, near(v.validatorRatePerEpoch, x.net) || (x.net === 0 && v.validatorRatePerEpoch === 0));
  check(`${v.nodeId}: validatorGrossRatePerEpoch = nodeReward / rewardingWeight`, near(v.validatorGrossRatePerEpoch, x.gross) || (x.gross === 0 && v.validatorGrossRatePerEpoch === 0));
  check(`${v.nodeId}: ftsoRatePerEpoch = MIRROR / nodeWeight`, near(v.ftsoRatePerEpoch, x.ftso) || (x.ftso === 0 && v.ftsoRatePerEpoch === 0));
  check(`${v.nodeId}: ratePerEpoch is the sum`, near(v.ratePerEpoch, x.net + x.ftso) || (x.net + x.ftso === 0 && v.ratePerEpoch === 0));
  check(`${v.nodeId}: annualRate = rate x 365 / 3.5`, near(v.annualRate, (v.ratePerEpoch * 365) / 3.5) || v.annualRate === 0);
  check(`${v.nodeId}: one period`, v.periods === 1 && v.lastEpoch === 446);
  check(`${v.nodeId}: paid iff rewarded`, v.paidPeriods === (x.rewarded ? 1 : 0) && v.missed.length === (x.rewarded ? 0 : 1));
  check(`${v.nodeId}: feePercent`, v.feePercent === raw(v.nodeId).fee / 1e4);
}
// What Flare's epoch 446 actually paid: 0.000272 per FLR after a 20% fee, 0.00034 before it, on every
// rewarded node (nobody was over the 5% cap, so the pool per FLR of rewardingWeight was the same).
check("20% node: 0.000272 per FLR after the fee", scoreOf(ID.plain)?.validatorRatePerEpoch.toFixed(6) === "0.000272");
check("20% node: 0.000340 per FLR before the fee", scoreOf(ID.plain)?.validatorGrossRatePerEpoch.toFixed(6) === "0.000340");
check("20% node: after-fee rate is 80% of gross", near(scoreOf(ID.plain)?.validatorRatePerEpoch, scoreOf(ID.plain).validatorGrossRatePerEpoch * 0.8, 1e-9));
const grossRates = real.validators.filter((v) => v.paidPeriods === 1).map((v) => v.validatorGrossRatePerEpoch);
check("every rewarded node had the same gross rate", grossRates.length === 6 && grossRates.every((g) => near(g, grossRates[0], 1e-9)));
check("plain: FTSO rate 0.000876 per FLR", scoreOf(ID.plain)?.ftsoRatePerEpoch.toFixed(6) === "0.000876");
check("plain: cappedShare 1", scoreOf(ID.plain)?.cappedShare === 1);

const full1 = scoreOf(ID.full1);
check("100% fee: validator rate exactly 0", full1?.validatorRatePerEpoch === 0 && scoreOf(ID.full2)?.validatorRatePerEpoch === 0);
check("100% fee: gross rate still shown", full1?.validatorGrossRatePerEpoch > 0.0003);
check("100% fee: feePercent 100", full1?.feePercent === 100);
check("100% fee: paid (the fee went to the validator)", full1?.paidPeriods === 1 && full1?.missed.length === 0);
check("100% fee: the FTSO part still counts", full1?.ftsoRatePerEpoch > 0 && near(full1.ratePerEpoch, full1.ftsoRatePerEpoch));
check("multi-node entity: one identity for both nodes", rowOf(ID.full1)?.identity === rowOf(ID.full2)?.identity && rowOf(ID.full1)?.identity === "0xfed1eff46608249054a6c7c4bce8998051dcff7d");
check("multi-node entity: the same MIRROR rate per FLR on both nodes", near(full1?.ftsoRatePerEpoch, scoreOf(ID.full2)?.ftsoRatePerEpoch, 1e-6));

const zero = scoreOf(ID.multiZero);
check("listed at weight 0: mirrorWeight and mirrorReward 0", rowOf(ID.multiZero)?.mirrorWeight === "0" && rowOf(ID.multiZero)?.mirrorReward === "0");
check("listed at weight 0: identity still its voter", rowOf(ID.multiZero)?.identity === "0x1650d2760baee638c034200dedcbe17b050d0364");
check("listed at weight 0: no FTSO rate, validator rate only", zero?.ftsoRatePerEpoch === 0 && zero?.ratePerEpoch === zero?.validatorRatePerEpoch && zero.validatorRatePerEpoch > 0);
check("same entity, weighted node: has an FTSO rate", scoreOf(ID.multiA)?.ftsoRatePerEpoch > 0);

const ob = rowOf(ID.overboost);
check("overboost: rewardingWeight below stake", ob && BigInt(ob.rewardingWeight) < BigInt(ob.stake));
check("overboost: the rate is per FLR of rewardingWeight, not of stake", near(scoreOf(ID.overboost)?.validatorRatePerEpoch, perFlr(BigInt(ob?.nodeReward ?? 0) - BigInt(ob?.feeReward ?? 0), BigInt(ob?.rewardingWeight ?? 1))));
check("overboost: 50% fee halves the gross rate", near(scoreOf(ID.overboost)?.validatorRatePerEpoch, scoreOf(ID.overboost)?.validatorGrossRatePerEpoch * 0.5, 1e-9) && scoreOf(ID.overboost)?.feePercent === 50);

const up = scoreOf(ID.uptime);
check("failed uptime: missed for uptime", JSON.stringify(up?.missed) === '[{"epoch":446,"reason":"uptime"}]' && up?.paidPeriods === 0);
check("failed uptime: no validator reward", up?.validatorRatePerEpoch === 0 && up?.validatorGrossRatePerEpoch === 0 && rowOf(ID.uptime)?.nodeReward === "0");
check("failed uptime: Flare computed no cappedWeight", rowOf(ID.uptime)?.cappedWeight === "0" && up?.cappedShare === null);
check("failed uptime: its provider's MIRROR is still paid", up?.ftsoRatePerEpoch > 0);

const unl = scoreOf(ID.unlinked);
check("no FTSO provider: identity and delegationAddress null", unl?.identity === null && unl?.delegationAddress === null);
check("no FTSO provider: missed as noProvider", JSON.stringify(unl?.missed) === '[{"epoch":446,"reason":"noProvider"}]');
check("no FTSO provider: earns nothing", unl?.ratePerEpoch === 0 && unl?.cappedShare === null);

const cond = scoreOf(ID.conditions);
check("conditions: missed as conditions", JSON.stringify(cond?.missed) === '[{"epoch":446,"reason":"conditions"}]');
check("conditions: identity is its voter", cond?.identity === "0x3a32539045a214958132e1d9afba66460e0073eb");
check("conditions: has FSP weight but no MIRROR that epoch", BigInt(rowOf(ID.conditions)?.mirrorWeight ?? 0) > 0n && rowOf(ID.conditions)?.mirrorReward === "0");
const unreg = scoreOf(ID.unregistered);
check("provider not registered in FSP: no identity, delegationAddress kept", unreg?.identity === null && unreg?.delegationAddress === "0x112b1130bd78b5a520adeace6130151e07a270a7");
check("provider not registered in FSP: missed as conditions", unreg?.missed[0]?.reason === "conditions");

check(
  "ranked: highest ratePerEpoch first",
  real.validators.every((v, i, a) => i === 0 || a[i - 1].ratePerEpoch > v.ratePerEpoch || (a[i - 1].ratePerEpoch === v.ratePerEpoch && a[i - 1].nodeId < v.nodeId)),
);
check("ranked: the plain 20% node tops this sample", real.validators[0]?.nodeId === ID.plain);

// Identity by delegation address: drop the test vector from its voter's nodeIds (and its MIRROR
// claim, which would otherwise be refused as paid to an unweighted node).
{
  const info = clone(fixture.rewardEpochInfo);
  const v = info.voterRegistrationInfo.find((e) => e.voterRegistrationInfo.voter === "0x5e53fa91ad7ce06b1510f03bfaac3ba77558ded8").voterRegistrationInfo;
  const at = v.nodeIds.indexOf("0x2c5bea62f08383745d9be382eed6b532555aaa5e");
  v.nodeIds.splice(at, 1);
  v.nodeWeights.splice(at, 1);
  const dist = clone(fixture.rewardDistribution);
  dist.rewardClaims = dist.rewardClaims.filter((c) => c.body.beneficiary !== "0x2c5bea62f08383745d9be382eed6b532555aaa5e");
  const r = validatorNodeRows(446, fixture.nodes, info, dist);
  const p = r.ok ? r.value.find((x) => x.nodeId === ID.plain) : null;
  check("fallback: identity from the voter whose delegationAddress is the ftsoAddress", p?.identity === "0x5e53fa91ad7ce06b1510f03bfaac3ba77558ded8");
  check("fallback: no FSP weight, no MIRROR", p?.mirrorWeight === "0" && p?.mirrorReward === "0");
  // Two voters sharing that delegation address: ambiguous, so refused rather than picked.
  const twin = clone(info.voterRegistrationInfo.find((e) => e.voterRegistrationInfo.voter === "0x5e53fa91ad7ce06b1510f03bfaac3ba77558ded8"));
  twin.voterRegistered.voter = twin.voterRegistrationInfo.voter = "0x00000000000000000000000000000000000000aa";
  twin.voterRegistrationInfo.nodeIds = [];
  twin.voterRegistrationInfo.nodeWeights = [];
  const amb = { ...info, voterRegistrationInfo: [...info.voterRegistrationInfo, twin] };
  check("fallback: two voters with the node's delegation address is refused", validatorNodeRows(446, fixture.nodes, amb, dist).ok === false);
}

// Accepted variations.
check("a MIRROR claim of 0 to a node listed at weight 0 is fine", (() => {
  const dist = clone(fixture.rewardDistribution);
  dist.rewardClaims.push({ body: { beneficiary: nodeIdToHex(ID.multiZero), claimType: 3, amount: "0", rewardEpochId: 446 } });
  return validatorNodeRows(446, fixture.nodes, fixture.rewardEpochInfo, dist).ok;
})());
check("a stakeEnd past the INTEGER range is stored as null", (() => {
  const nodes = clone(fixture.nodes);
  nodes[0].stakeEnd = 4_000_000_000;
  const r = validatorNodeRows(446, nodes, fixture.rewardEpochInfo, fixture.rewardDistribution);
  return r.ok && r.value[0].stakeEnd === null;
})());
check("fee given as a decimal string reads the same", (() => {
  const nodes = clone(fixture.nodes);
  nodes[0].fee = "200000";
  const r = validatorNodeRows(446, nodes, fixture.rewardEpochInfo, fixture.rewardDistribution);
  return r.ok && JSON.stringify(r.value[0]) === JSON.stringify(plain);
})());

// Refused: the files do not hold together.
const refuse = (label, mutate) => {
  const f = clone(fixture);
  const epoch = mutate(f) ?? 446;
  const r = validatorNodeRows(epoch, f.nodes, f.rewardEpochInfo, f.rewardDistribution);
  check(`parser refuses ${label}`, r.ok === false && typeof r.reason === "string" && r.reason.length > 0);
};
const node = (f, id) => f.nodes.find((n) => n.nodeId === id);
refuse("reward-epoch-info.json for another epoch", (f) => void (f.rewardEpochInfo.rewardEpochId = 445));
refuse("reward-distribution-data.json for another epoch", (f) => void (f.rewardDistribution.rewardEpochId = 445));
refuse("both fsp files for another epoch than asked", () => 447);
refuse("a MIRROR claim for another epoch", (f) => void (f.rewardDistribution.rewardClaims.find((c) => c.body.claimType === 3).body.rewardEpochId = 445));
refuse("a node ID that fails its checksum", (f) => void (node(f, ID.plain).nodeId = ID.plain.slice(0, -1) + "d"));
refuse("a node ID without the NodeID- prefix", (f) => void (node(f, ID.plain).nodeId = ID.plain.slice(7)));
refuse("the same node twice", (f) => void f.nodes.push(clone(node(f, ID.plain))));
refuse("a fee above 100%", (f) => void (node(f, ID.plain).fee = 1_000_001));
refuse("a negative fee", (f) => void (node(f, ID.plain).fee = -1));
refuse("an unreadable fee", (f) => void (node(f, ID.plain).fee = "20%"));
refuse("a missing fee", (f) => void delete node(f, ID.unlinked).fee);
refuse("an unreadable stake", (f) => void (node(f, ID.plain).totalStakeAmount = "1e24"));
refuse("a missing stake", (f) => void delete node(f, ID.uptime).totalStakeAmount);
refuse("an unreadable rewardingWeight", (f) => void (node(f, ID.unlinked).rewardingWeight = "abc"));
refuse("a cappedWeight above rewardingWeight", (f) => void (node(f, ID.plain).cappedWeight = node(f, ID.plain).rewardingWeight + "0"));
refuse("a rewarded node with no nodeRewardAmount", (f) => void delete node(f, ID.plain).nodeRewardAmount);
refuse("a rewarded node with an unreadable nodeRewardAmount", (f) => void (node(f, ID.plain).nodeRewardAmount = 1.5));
refuse("a rewarded node with no cappedWeight", (f) => void delete node(f, ID.plain).cappedWeight);
refuse("a rewarded node with no rewardingWeight", (f) => void delete node(f, ID.plain).rewardingWeight);
refuse("a node with no eligible flag", (f) => void delete node(f, ID.plain).eligible);
refuse("a node with an uptimeEligible that is not a boolean", (f) => void (node(f, ID.plain).uptimeEligible = "true"));
refuse("a node with no ftsoAddress", (f) => void delete node(f, ID.plain).ftsoAddress);
refuse("a node with a malformed ftsoAddress", (f) => void (node(f, ID.plain).ftsoAddress = "0x1234"));
refuse("a node listed by two voters", (f) => {
  const other = f.rewardEpochInfo.voterRegistrationInfo.find((e) => e.voterRegistrationInfo.voter !== "0x5e53fa91ad7ce06b1510f03bfaac3ba77558ded8").voterRegistrationInfo;
  other.nodeIds.push("0x2c5bea62f08383745d9be382eed6b532555aaa5e");
  other.nodeWeights.push("1");
});
refuse("node IDs without one weight each", (f) => void f.rewardEpochInfo.voterRegistrationInfo[0].voterRegistrationInfo.nodeWeights.pop());
refuse("an unreadable node weight", (f) => void (f.rewardEpochInfo.voterRegistrationInfo[0].voterRegistrationInfo.nodeWeights[0] = "lots"));
refuse("an unreadable FSP node ID", (f) => void (f.rewardEpochInfo.voterRegistrationInfo[0].voterRegistrationInfo.nodeIds[0] = "NodeID-x"));
refuse("a registration with no voter", (f) => {
  const e = f.rewardEpochInfo.voterRegistrationInfo[0];
  delete e.voterRegistered.voter;
  delete e.voterRegistrationInfo.voter;
});
refuse("MIRROR rewards to a node no voter gives weight", (f) =>
  void f.rewardDistribution.rewardClaims.push({ body: { beneficiary: nodeIdToHex(ID.multiZero), claimType: 3, amount: "1", rewardEpochId: 446 } }),
);
refuse("a MIRROR claim with an unreadable amount", (f) => void (f.rewardDistribution.rewardClaims.find((c) => c.body.claimType === 3).body.amount = "12.5"));
refuse("a MIRROR claim with a malformed beneficiary", (f) => void (f.rewardDistribution.rewardClaims.find((c) => c.body.claimType === 3).body.beneficiary = "0xabc"));
refuse("a claim with no claimType", (f) => void delete f.rewardDistribution.rewardClaims[0].body.claimType);
refuse("no nodes", (f) => void (f.nodes = []));
refuse("nodes that are not a list", (f) => void (f.nodes = { a: f.nodes[0] }));
refuse("no voterRegistrationInfo", (f) => void delete f.rewardEpochInfo.voterRegistrationInfo);
refuse("no rewardClaims", (f) => void delete f.rewardDistribution.rewardClaims);
refuse("no fsp files at all", (f) => {
  f.rewardEpochInfo = null;
  f.rewardDistribution = null;
});
refuse("an epoch that is not a whole number", () => 446.5);

// ---------------------------------------------------------------------------------------------------
// 2. THE WINDOW AND THE RANKING, ON SYNTHETIC ROWS.
// ---------------------------------------------------------------------------------------------------
check("the window is the yield feed's, 10 epochs", YIELD_WINDOW_EPOCHS === 10);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const W10 = range(437, 446);
check("window: 10 epochs, ascending", JSON.stringify(validatorWindow([...W10].reverse(), 10)) === JSON.stringify(W10));
check("window: the newest 10 of more", JSON.stringify(validatorWindow(range(420, 446), 10)) === JSON.stringify(W10));
check("window: duplicates and order do not matter", JSON.stringify(validatorWindow([446, 440, 437, 446, ...W10], 10)) === JSON.stringify(W10));
check("window: a gap ends it (consecutive, ending at the newest)", JSON.stringify(validatorWindow([...range(437, 440), ...range(442, 446)], 10)) === JSON.stringify(range(442, 446)));
check("window: a gap right before the newest leaves the newest alone", JSON.stringify(validatorWindow([440, 441, 442, 443, 444, 446], 10)) === "[446]");
check("window: fewer epochs than the size", JSON.stringify(validatorWindow([445, 446], 10)) === "[445,446]");
check("window: none", JSON.stringify(validatorWindow([], 10)) === "[]");

const flr = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // whole and fractional FLR, wei-scale
const srow = (epochId, nodeId, o = {}) => ({
  epochId,
  nodeId,
  identity: "0x00000000000000000000000000000000000000a1",
  delegationAddress: "0x00000000000000000000000000000000000000d1",
  feePpm: 200000,
  stake: flr(1_000_000),
  rewardingWeight: flr(1_000_000),
  cappedWeight: flr(1_000_000),
  uptimeEligible: true,
  eligible: true,
  nodeReward: flr(500),
  feeReward: flr(100),
  mirrorReward: flr(800),
  mirrorWeight: flr(1_000_000),
  ...o,
});
const unpaid = { nodeReward: "0", feeReward: "0" };
const synthetic = [
  // A: rewarded in all 10. Per FLR: 400 / 1e6 after fee, 500 / 1e6 gross, 800 / 1e6 MIRROR.
  ...W10.map((e) => srow(e, "NodeID-A")),
  // B: misses 439 (uptime), 441 (no provider), 444 (provider failed conditions); MIRROR every epoch.
  // Given out of order: missed must come back ascending.
  ...[...W10].reverse().map((e) =>
    srow(e, "NodeID-B", e === 439 ? { ...unpaid, uptimeEligible: false, cappedWeight: "0" } : e === 441 ? { ...unpaid, eligible: false, delegationAddress: null } : e === 444 ? { ...unpaid, eligible: false } : {}),
  ),
  // C: left after 441; its identity moved at 440 and its fee dropped to 10% in 441.
  ...range(437, 441).map((e) =>
    srow(e, "NodeID-C", {
      ...(e >= 440 ? { identity: "0x00000000000000000000000000000000000000b2", delegationAddress: "0x00000000000000000000000000000000000000d2" } : {}),
      ...(e === 441 ? { feePpm: 100000, feeReward: flr(50) } : {}),
    }),
  ),
  // D: 100% fee. The validator keeps everything: 0 after fee, 500 / 1e6 gross.
  ...W10.map((e) => srow(e, "NodeID-D", { feePpm: 1_000_000, feeReward: flr(500) })),
  // E: rewardingWeight 0 in the newest epoch (rate 0 that epoch, cappedShare null).
  ...W10.map((e) => srow(e, "NodeID-E", e === 446 ? { rewardingWeight: "0", cappedWeight: "0", nodeReward: "0", feeReward: "0" } : {})),
  // F: over the cap in the newest epoch (cappedShare 0.8), never listed by its provider (no MIRROR).
  ...W10.map((e) => srow(e, "NodeID-F", { mirrorReward: "0", mirrorWeight: "0", ...(e === 446 ? { cappedWeight: flr(800_000) } : {}) })),
  // G: joined at 445, not rewarded in 446.
  srow(445, "NodeID-G"),
  srow(446, "NodeID-G", { ...unpaid, eligible: false }),
  // Ties, given in reverse order: sorted by nodeId.
  srow(446, "NodeID-Tie2"),
  srow(446, "NodeID-Tie1"),
  // Outside the window, and a duplicate of A in 446 with other numbers: neither may count.
  srow(436, "NodeID-A", { nodeReward: flr(999_999), feeReward: "0" }),
  srow(436, "NodeID-Old"),
  srow(446, "NodeID-A", { nodeReward: flr(999_999), feeReward: "0", stake: flr(123) }),
];
const out = rankValidators(synthetic, W10);
const s = (id) => out.validators.find((v) => v.nodeId === id);

check("synthetic: echoes the window", JSON.stringify(out.epochs) === JSON.stringify(W10));
check("synthetic: a node only outside the window is absent", !s("NodeID-Old"));
check("synthetic: every node active in the window is present", out.validators.length === 9);
// Newest epoch: A, B, D, E, F, G, Tie1, Tie2 at 1,000,000 FLR each (A once). C left.
check("synthetic: totalStake is the newest epoch's, each node once", out.totalStake === (8n * 1_000_000n * E18).toString());

const A = s("NodeID-A");
check("A: 10 periods, all paid", A?.periods === 10 && A?.paidPeriods === 10 && A?.missed.length === 0);
check("A: validator rate 0.0004", near(A?.validatorRatePerEpoch, 0.0004));
check("A: gross rate 0.0005", near(A?.validatorGrossRatePerEpoch, 0.0005));
check("A: FTSO rate 0.0008", near(A?.ftsoRatePerEpoch, 0.0008));
check("A: rate 0.0012", near(A?.ratePerEpoch, 0.0012));
check("A: annual 0.0012 x 365 / 3.5", near(A?.annualRate, (0.0012 * 365) / 3.5));
check("A: feePercent 20, cappedShare 1, lastEpoch 446", A?.feePercent === 20 && A?.cappedShare === 1 && A?.lastEpoch === 446);
check("A: the duplicate and out-of-window rows do not count", near(A?.validatorRatePerEpoch, 0.0004) && A?.periods === 10);

const B = s("NodeID-B");
check("B: missed epochs ascending with Flare's reasons", JSON.stringify(B?.missed) === '[{"epoch":439,"reason":"uptime"},{"epoch":441,"reason":"noProvider"},{"epoch":444,"reason":"conditions"}]');
check("B: 10 periods, 7 paid", B?.periods === 10 && B?.paidPeriods === 7);
check("B: missed epochs count as 0 in the mean", near(B?.validatorRatePerEpoch, (7 * 0.0004) / 10) && near(B?.validatorGrossRatePerEpoch, (7 * 0.0005) / 10));
check("B: MIRROR still counts in missed epochs", near(B?.ftsoRatePerEpoch, 0.0008));
check("B: rate is the sum", near(B?.ratePerEpoch, (7 * 0.0004) / 10 + 0.0008));

const C = s("NodeID-C");
check("C: left mid-window, 5 periods", C?.periods === 5 && C?.paidPeriods === 5);
check("C: lastEpoch is its newest active epoch", C?.lastEpoch === 441);
check("C: identity and delegationAddress from its newest active epoch", C?.identity === "0x00000000000000000000000000000000000000b2" && C?.delegationAddress === "0x00000000000000000000000000000000000000d2");
check("C: feePercent from its newest active epoch", C?.feePercent === 10);
check("C: mean over its own periods, not the window", near(C?.validatorRatePerEpoch, (4 * 0.0004 + 0.00045) / 5));

const D = s("NodeID-D");
check("D: 100% fee, validator rate exactly 0", D?.validatorRatePerEpoch === 0);
check("D: gross rate before the fee", near(D?.validatorGrossRatePerEpoch, 0.0005));
check("D: still paid, the FTSO part is its rate", D?.paidPeriods === 10 && near(D?.ratePerEpoch, 0.0008) && D?.feePercent === 100);

const Ev = s("NodeID-E");
check("E: rewardingWeight 0 counts that epoch at 0", near(Ev?.validatorRatePerEpoch, (9 * 0.0004) / 10) && Ev?.paidPeriods === 10);
check("E: cappedShare null when the newest rewardingWeight is 0", Ev?.cappedShare === null);

const F = s("NodeID-F");
check("F: cappedShare from the newest epoch", near(F?.cappedShare, 0.8));
check("F: no MIRROR weight, FTSO rate 0", F?.ftsoRatePerEpoch === 0 && near(F?.ratePerEpoch, 0.0004));

const Gv = s("NodeID-G");
check("G: joined late, 2 periods, 1 paid", Gv?.periods === 2 && Gv?.paidPeriods === 1);
check("G: cappedShare null when its newest epoch was not rewarded", Gv?.cappedShare === null);
check("G: missed in 446 for conditions", JSON.stringify(Gv?.missed) === '[{"epoch":446,"reason":"conditions"}]');

check("sorted by ratePerEpoch, highest first", out.validators.every((v, i, a) => i === 0 || a[i - 1].ratePerEpoch >= v.ratePerEpoch));
const t1 = out.validators.findIndex((v) => v.nodeId === "NodeID-Tie1");
const t2 = out.validators.findIndex((v) => v.nodeId === "NodeID-Tie2");
check("ties sorted by nodeId", t1 > -1 && t2 === t1 + 1);
check("A (0.0012) ranks above B and D", out.validators.findIndex((v) => v.nodeId === "NodeID-A") < out.validators.findIndex((v) => v.nodeId === "NodeID-B"));

// An epoch gap: 441 has no rows at all. The window is the run after it, and older rows are not used.
const gapRows = synthetic.filter((r) => r.epochId !== 441);
const gapWindow = validatorWindow([...new Set(gapRows.map((r) => r.epochId))], 10);
check("gap: window is 442..446", JSON.stringify(gapWindow) === JSON.stringify(range(442, 446)));
const gap = rankValidators(gapRows, gapWindow);
check("gap: echoes the shorter window", JSON.stringify(gap.epochs) === JSON.stringify(range(442, 446)));
check("gap: A scored on 5 epochs", gap.validators.find((v) => v.nodeId === "NodeID-A")?.periods === 5);
check("gap: C, which left before the gap ended, is absent", !gap.validators.some((v) => v.nodeId === "NodeID-C"));
check("gap: B's misses before the window are dropped", JSON.stringify(gap.validators.find((v) => v.nodeId === "NodeID-B")?.missed) === '[{"epoch":444,"reason":"conditions"}]');

check("no rows: no validators and zero stake", (() => {
  const r = rankValidators([], W10);
  return r.validators.length === 0 && r.totalStake === "0";
})());

// The contract the wallets are written against: exactly these fields, in this order.
const FIELDS = [
  "nodeId", "identity", "delegationAddress", "periods", "paidPeriods", "missed", "validatorRatePerEpoch",
  "validatorGrossRatePerEpoch", "ftsoRatePerEpoch", "ratePerEpoch", "annualRate", "feePercent", "cappedShare", "lastEpoch",
];
check("contract: validator fields", [...real.validators, ...out.validators].every((v) => JSON.stringify(Object.keys(v)) === JSON.stringify(FIELDS)));
check("contract: network fields (chainId added by the feed)", JSON.stringify(Object.keys(out)) === '["epochs","totalStake","validators"]');
check("contract: rates are finite numbers", [...real.validators, ...out.validators].every((v) => FIELDS.slice(6, 11).every((k) => Number.isFinite(v[k]))));
check("contract: missed entries are { epoch, reason }", out.validators.every((v) => v.missed.every((m) => JSON.stringify(Object.keys(m)) === '["epoch","reason"]')));

// The method text.
const method = validatorFeedMethod(10);
check("method has no em dash", !method.includes("\u2014"));
check("method names Flare's files", ["nodes-data.json", "reward-epoch-info.json", "reward-distribution-data.json"].every((f) => method.includes(f)));
check("method gives the window and the annualisation", method.includes("up to 10 consecutive reward epochs") && method.includes("365 / 3.5"));
check("method names every missed reason", ["uptime (", "noProvider (", "conditions ("].every((r) => method.includes(r)));

// Neutrality: nothing in the feed's code names a provider, an address or a node.
for (const f of ["../src/lib/validator-feed-rank.ts", "../src/lib/validator-feed.ts", "./validator-rewards-parse.mjs", "./ingest-validator-rewards.mjs"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  const addresses = (src.match(/0x[0-9a-fA-F]{40}/g) ?? []).filter((a) => !/^0x0{40}$/.test(a));
  check(`${f} names no address or node`, addresses.length === 0 && !/NodeID-[1-9A-HJ-NP-Za-km-z]{20,}/.test(src));
}

if (problems.length) {
  console.error("check-validator-feed: FAILED");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("check-validator-feed: ok");
