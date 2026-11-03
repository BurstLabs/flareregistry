// P-CHAIN VALIDATOR REWARDS, ONE REWARD EPOCH, SUMMED NETWORK-WIDE.
//
// Pure (no I/O, no database), so the build check can assert it and the ingest stores exactly what it
// returns. Input is two files Flare publishes per reward epoch in github.com/flare-foundation/
// reward-scripts, folder generated-files/reward-epoch-<N>/:
//
//   data.json        configFileData.REWARD_EPOCH (N) and REWARD_AMOUNT_EPOCH_WEI (the epoch's whole
//                    validator reward pool: ValidatorRewardManager's daily authorized inflation x 3.5),
//                    plus the per-address recipients that the 4-epoch payout file sums.
//   nodes-data.json  one entry per active validator at the epoch's staking vote-power block.
//
// Units: stake amounts in nodes-data.json are P-chain units (1e9 per FLR); reward amounts are wei
// (1e18 per FLR). Everything returned is wei, as decimal strings, so it lines up with the other weights.
//
// How Flare splits a rewarded node's reward (reward-scripts src/utils/rewards.ts, calculateRewardAmounts):
//   nodeRewardAmount  = cappedWeight x pool / total capped weight of uptime-eligible nodes
//   fee               = nodeRewardAmount x fee / 1e6                      -> the validator keeps it
//   the rest is shared pro rata over rewardingWeight (self-bond, boost, delegators): the self-bond
//   and boost shares go to the validator, each delegator gets its own share.
// A node that passed uptime but failed FSP minimal conditions has its share burned
// (burnedRewardAmount). A node that failed uptime gets no share at all.
//
// stakerReward is what the stake earned, after the validator's fee: the sum over rewarded nodes of
// nodeRewardAmount minus that fee. It counts the self-bond's and boost's shares as well as the
// delegators', because the per-FLR rate is the same for all of them and the FTSO side counts all stake
// on a node too (fsp-rewards MIRROR claims are shared by every FLR staked on the node, after the
// provider's capped staking fee). totalStake is the stake on EVERY active validator in the file,
// including nodes that earned nothing, the same way the FTSO side keeps ineligible providers' stake
// in its denominator.
//
// Refuses (ok: false) rather than guessing whenever the file does not hold together, including when
// Flare's own conservation check fails: what was paid to validators and delegators plus what was
// burned must equal the pool exactly.

import { createHash } from "node:crypto";

const GWEI_TO_WEI = 10n ** 9n;
const FEE_DENOMINATOR = 1_000_000n; // fee is in millionths: 200000 = 20%

const toBig = (v) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

/**
 * @param {number} epochId the reward epoch the files were fetched for
 * @param {any} data parsed data.json
 * @param {any} nodes parsed nodes-data.json
 * @returns {{ ok: true, value: {
 *   epochId: number, rewardAmount: string, stakerReward: string, feeReward: string, burnedReward: string,
 *   delegatorReward: string, totalStake: string, delegatedStake: string, selfBond: string,
 *   nodes: number, rewardedNodes: number, stakingVpBlock: number | null } } | { ok: false, reason: string }}
 */
export function summariseValidatorRewards(epochId, data, nodes) {
  const fail = (reason) => ({ ok: false, reason: `epoch ${epochId}: ${reason}` });
  const cfg = data?.configFileData;
  if (!cfg || typeof cfg !== "object") return fail("data.json has no configFileData");
  if (Number(cfg.REWARD_EPOCH) !== epochId) return fail(`data.json is for epoch ${cfg.REWARD_EPOCH}`);
  const pool = toBig(cfg.REWARD_AMOUNT_EPOCH_WEI);
  if (pool == null || pool <= 0n) return fail("REWARD_AMOUNT_EPOCH_WEI missing or not positive");
  if (!Array.isArray(nodes) || nodes.length === 0) return fail("nodes-data.json has no nodes");

  let totalStake = 0n;
  let delegatedStake = 0n;
  let selfBond = 0n;
  let stakerReward = 0n;
  let feeReward = 0n;
  let burnedReward = 0n;
  let delegatorReward = 0n;
  let paid = 0n; // validator + delegator amounts, for the conservation check
  let rewardedNodes = 0;

  for (const node of nodes) {
    const id = typeof node?.nodeId === "string" ? node.nodeId : "?";
    const stake = toBig(node?.totalStakeAmount);
    if (stake == null) return fail(`node ${id} has no readable totalStakeAmount`);
    totalStake += stake;
    delegatedStake += toBig(node.normalDelegations) ?? 0n;
    selfBond += toBig(node.totalSelfBond) ?? 0n;

    if (node.uptimeEligible !== true) continue; // no share at all
    if (node.eligible === true) {
      const nodeReward = toBig(node.nodeRewardAmount);
      const validatorReward = toBig(node.validatorRewardAmount);
      const fee = toBig(node.fee);
      if (nodeReward == null || validatorReward == null) return fail(`rewarded node ${id} has no readable reward amounts`);
      if (fee == null || fee < 0n || fee > FEE_DENOMINATOR) return fail(`rewarded node ${id} has an unreadable fee`);
      if (!Array.isArray(node.delegators)) return fail(`rewarded node ${id} has no delegators list`);
      let toDelegators = 0n;
      for (const d of node.delegators) {
        const a = toBig(d?.delegatorRewardAmount);
        if (a == null) return fail(`rewarded node ${id} has a delegator with no readable reward`);
        toDelegators += a;
      }
      // The validator's fee, computed exactly as Flare computes it.
      const feeAmount = (nodeReward * fee) / FEE_DENOMINATOR;
      if (feeAmount > validatorReward) return fail(`rewarded node ${id} pays its validator less than the fee`);
      feeReward += feeAmount;
      stakerReward += nodeReward - feeAmount;
      delegatorReward += toDelegators;
      paid += validatorReward + toDelegators;
      rewardedNodes++;
    } else {
      const burned = toBig(node.burnedRewardAmount);
      if (burned == null) return fail(`unrewarded node ${id} has no readable burnedRewardAmount`);
      burnedReward += burned;
    }
  }

  if (paid + burnedReward !== pool) return fail(`paid ${paid} + burned ${burnedReward} does not equal the pool ${pool}`);
  if (totalStake <= 0n) return fail("no stake");

  const vp = Number(data.stakingVotePowerBlock);
  return {
    ok: true,
    value: {
      epochId,
      rewardAmount: pool.toString(),
      stakerReward: stakerReward.toString(),
      feeReward: feeReward.toString(),
      burnedReward: burnedReward.toString(),
      delegatorReward: delegatorReward.toString(),
      totalStake: (totalStake * GWEI_TO_WEI).toString(),
      delegatedStake: (delegatedStake * GWEI_TO_WEI).toString(),
      selfBond: (selfBond * GWEI_TO_WEI).toString(),
      nodes: nodes.length,
      rewardedNodes,
      stakingVpBlock: Number.isSafeInteger(vp) && vp > 0 ? vp : null,
    },
  };
}

// P-CHAIN VALIDATOR REWARDS, ONE REWARD EPOCH, PER NODE.
//
// What one staked FLR earned on each validator node, so /api/feed/validators.json can rank validators
// on it. Same nodes-data.json as above, plus two fsp-rewards files of the same epoch
// (github.com/flare-foundation/fsp-rewards, folder flare/<N>/):
//
//   reward-epoch-info.json        voterRegistrationInfo[]: which FSP voter lists which node IDs
//                                 (0x + 20 bytes) and at what nodeWeight (wei-scale).
//   reward-distribution-data.json rewardClaims[]: claimType 3 (MIRROR, FSP staking rewards) is paid
//                                 to a node's 20 bytes and shared by all the FLR staked on the node
//                                 by its nodeWeight, after the provider's capped staking fee.
//
// Per node, as Flare computes it (reward-scripts calculateRewardAmounts): a rewarded node
// (uptimeEligible and eligible) gets nodeRewardAmount, the validator keeps nodeRewardAmount x fee / 1e6
// and the rest is shared pro rata over rewardingWeight. So (nodeReward - feeReward) / rewardingWeight
// is what one staked FLR earned from validator rewards, and mirrorReward / mirrorWeight what it earned
// from MIRROR. A node that failed uptime gets no share; one that passed uptime but is not eligible
// (no FTSO provider, or a provider that failed minimal conditions) has its share burned. Either way its
// nodeReward and feeReward are "0" here. The MIRROR part is the provider's, so it is paid or not
// regardless of the node's own uptime.
//
// The node ID's 20 bytes are recovered from its cb58 form ("NodeID-" + base58 of the 20 bytes and the
// last 4 bytes of their sha256), checksum verified, so a mistyped ID never matches another node's claims.
//
// Refuses (ok: false) rather than guessing whenever the files do not hold together: fsp files for
// another epoch, an unreadable number, a fee outside 0 to 100%, a node ID that fails its checksum, the
// same node twice, a node listed by two voters, MIRROR rewards to a node no voter gives weight to.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CLAIM_MIRROR = 3;
const INT4_MAX = 2_147_483_647; // stakeEnd is a Postgres INTEGER
const AMBIGUOUS = Symbol("ambiguous");

const address = (v) => (typeof v === "string" && HEX_ADDRESS.test(v) ? v.toLowerCase() : null);

/**
 * The 20 bytes behind a P-chain node ID as lowercase 0x hex, the form fsp-rewards uses for nodeIds and
 * MIRROR beneficiaries. null when the string is not "NodeID-" + cb58 of 20 bytes or its checksum fails.
 * @param {unknown} nodeId
 * @returns {string | null}
 */
export function nodeIdToHex(nodeId) {
  if (typeof nodeId !== "string" || !nodeId.startsWith("NodeID-")) return null;
  const s = nodeId.slice("NodeID-".length);
  if (s.length === 0 || s.length > 64) return null;
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0); // each leading "1" is a leading zero byte
  }
  if (bytes.length !== 24) return null;
  const body = Uint8Array.from(bytes.slice(0, 20));
  const sum = createHash("sha256").update(body).digest();
  for (let i = 0; i < 4; i++) if (sum[28 + i] !== bytes[20 + i]) return null;
  return "0x" + Buffer.from(body).toString("hex");
}

/** Absent is 0 (Flare leaves reward fields off unrewarded nodes); present but unreadable is null. */
const optionalBig = (v) => (v === undefined || v === null ? 0n : toBig(v));

/**
 * @param {number} epochId the reward epoch the files were fetched for
 * @param {any} nodes parsed reward-scripts nodes-data.json
 * @param {any} fspInfo parsed fsp-rewards reward-epoch-info.json
 * @param {any} fspDistribution parsed fsp-rewards reward-distribution-data.json
 * @returns {{ ok: true, value: Array<{
 *   epochId: number, nodeId: string, identity: string | null, delegationAddress: string | null,
 *   feePpm: number, stake: string, rewardingWeight: string, cappedWeight: string,
 *   uptimeEligible: boolean, eligible: boolean, nodeReward: string, feeReward: string,
 *   mirrorReward: string, mirrorWeight: string, stakeEnd: number | null }> } | { ok: false, reason: string }}
 */
export function validatorNodeRows(epochId, nodes, fspInfo, fspDistribution) {
  const fail = (reason) => ({ ok: false, reason: `epoch ${epochId} per node: ${reason}` });
  if (!Number.isSafeInteger(epochId) || epochId < 1) return fail("not a reward epoch number");
  if (!Array.isArray(nodes) || nodes.length === 0) return fail("nodes-data.json has no nodes");
  if (Number(fspInfo?.rewardEpochId) !== epochId) return fail(`reward-epoch-info.json is for epoch ${fspInfo?.rewardEpochId}`);
  if (Number(fspDistribution?.rewardEpochId) !== epochId) {
    return fail(`reward-distribution-data.json is for epoch ${fspDistribution?.rewardEpochId}`);
  }
  if (!Array.isArray(fspInfo.voterRegistrationInfo)) return fail("reward-epoch-info.json has no voterRegistrationInfo");
  if (!Array.isArray(fspDistribution.rewardClaims)) return fail("reward-distribution-data.json has no rewardClaims");

  // Node bytes -> the voter that lists it and its FSP weight; delegation address -> voter.
  const listed = new Map();
  const byDelegation = new Map();
  for (const entry of fspInfo.voterRegistrationInfo) {
    const vri = entry?.voterRegistrationInfo ?? {};
    const voter = address(entry?.voterRegistered?.voter ?? vri.voter);
    if (!voter) return fail("a registration with no readable voter");
    const ids = vri.nodeIds ?? [];
    const weights = vri.nodeWeights ?? [];
    if (!Array.isArray(ids) || !Array.isArray(weights) || ids.length !== weights.length) {
      return fail(`voter ${voter} does not list one weight per node ID`);
    }
    for (let i = 0; i < ids.length; i++) {
      const hex = address(ids[i]);
      const weight = toBig(weights[i]);
      if (!hex || weight == null || weight < 0n) return fail(`voter ${voter} lists an unreadable node ID or weight`);
      if (listed.has(hex)) return fail(`node ${hex} is listed by two voters`);
      listed.set(hex, { voter, weight });
    }
    const delegation = address(vri.delegationAddress);
    if (delegation) byDelegation.set(delegation, byDelegation.has(delegation) ? AMBIGUOUS : voter);
  }

  const mirror = new Map();
  for (const claim of fspDistribution.rewardClaims) {
    const body = claim?.body ?? claim;
    const type = toBig(body?.claimType);
    if (type == null) return fail("a reward claim with no readable claimType");
    if (type !== BigInt(CLAIM_MIRROR)) continue;
    if (body.rewardEpochId != null && Number(body.rewardEpochId) !== epochId) return fail(`a MIRROR claim for epoch ${body.rewardEpochId}`);
    const to = address(body.beneficiary);
    const amount = toBig(body.amount);
    if (!to || amount == null || amount < 0n) return fail("a MIRROR claim with an unreadable beneficiary or amount");
    mirror.set(to, (mirror.get(to) ?? 0n) + amount);
  }

  const rows = [];
  const seen = new Set();
  for (const node of nodes) {
    const id = typeof node?.nodeId === "string" ? node.nodeId : "?";
    const hex = nodeIdToHex(node?.nodeId);
    if (!hex) return fail(`node ${id} is not a node ID or fails its checksum`);
    if (seen.has(id)) return fail(`node ${id} appears twice`);
    seen.add(id);

    const fee = toBig(node.fee);
    if (fee == null || fee < 0n || fee > FEE_DENOMINATOR) return fail(`node ${id} has an unreadable fee`);
    if (typeof node.uptimeEligible !== "boolean" || typeof node.eligible !== "boolean") {
      return fail(`node ${id} has no readable uptimeEligible or eligible`);
    }
    const ftso = address(node.ftsoAddress);
    if (!ftso) return fail(`node ${id} has no readable ftsoAddress`);
    const delegationAddress = ftso === ZERO_ADDRESS ? null : ftso;

    const stake = toBig(node.totalStakeAmount);
    const rewardingWeight = optionalBig(node.rewardingWeight);
    const cappedWeight = optionalBig(node.cappedWeight);
    if (stake == null || stake < 0n) return fail(`node ${id} has no readable totalStakeAmount`);
    if (rewardingWeight == null || rewardingWeight < 0n || cappedWeight == null || cappedWeight < 0n) {
      return fail(`node ${id} has an unreadable rewardingWeight or cappedWeight`);
    }
    if (cappedWeight > rewardingWeight) return fail(`node ${id} has a cappedWeight above its rewardingWeight`);

    let nodeReward = 0n;
    let feeReward = 0n;
    if (node.uptimeEligible && node.eligible) {
      nodeReward = toBig(node.nodeRewardAmount);
      if (nodeReward == null || nodeReward < 0n) return fail(`rewarded node ${id} has no readable nodeRewardAmount`);
      if (node.rewardingWeight == null || node.cappedWeight == null) return fail(`rewarded node ${id} has no rewardingWeight or cappedWeight`);
      feeReward = (nodeReward * fee) / FEE_DENOMINATOR; // exactly as Flare computes the validator's fee
    }

    const fsp = listed.get(hex);
    const mirrorWeight = fsp?.weight ?? 0n;
    const mirrorReward = mirror.get(hex) ?? 0n;
    if (mirrorReward > 0n && mirrorWeight === 0n) return fail(`node ${id} has MIRROR rewards but no FSP node weight`);

    let identity = fsp?.voter ?? null;
    if (!identity && delegationAddress) {
      const voter = byDelegation.get(delegationAddress);
      if (voter === AMBIGUOUS) return fail(`node ${id}: two voters share its delegation address`);
      identity = voter ?? null;
    }

    const stakeEnd = Number(node.stakeEnd);
    rows.push({
      epochId,
      nodeId: id,
      identity,
      delegationAddress,
      feePpm: Number(fee),
      stake: (stake * GWEI_TO_WEI).toString(),
      rewardingWeight: (rewardingWeight * GWEI_TO_WEI).toString(),
      cappedWeight: (cappedWeight * GWEI_TO_WEI).toString(),
      uptimeEligible: node.uptimeEligible,
      eligible: node.eligible,
      nodeReward: nodeReward.toString(),
      feeReward: feeReward.toString(),
      mirrorReward: mirrorReward.toString(),
      mirrorWeight: mirrorWeight.toString(),
      stakeEnd: Number.isSafeInteger(stakeEnd) && stakeEnd > 0 && stakeEnd <= INT4_MAX ? stakeEnd : null,
    });
  }
  return { ok: true, value: rows };
}
