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
