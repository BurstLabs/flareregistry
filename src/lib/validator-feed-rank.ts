// Pure validator ranking (no database import), so the build check can assert it against rows parsed
// from Flare's real files and against synthetic windows. The feed in validator-feed.ts feeds it stored
// ValidatorNodeEpoch rows. No value imports either: Node's type stripping, which the build check runs
// this file under, cannot resolve an extensionless import, so the window size comes in as a parameter.

const REWARD_EPOCH_DAYS = 3.5;
const WEI = 10n ** 18n;
const FEE_PPM_PER_PERCENT = 1e4; // feePpm is in millionths: 200000 = 20%

/** One validator node in one reward epoch (ValidatorNodeEpoch). Amounts and weights are wei-scale strings. */
export interface ValidatorNodeRow {
  epochId: number;
  nodeId: string;
  identity: string | null;
  delegationAddress: string | null;
  feePpm: number;
  stake: string;
  rewardingWeight: string;
  cappedWeight: string;
  uptimeEligible: boolean;
  eligible: boolean;
  nodeReward: string;
  feeReward: string;
  mirrorReward: string;
  mirrorWeight: string;
}

/** Why a node earned no validator reward in an epoch it was active in. */
export type MissedReason = "uptime" | "noProvider" | "conditions";

export interface ValidatorScore {
  nodeId: string;
  /** Lowercase FSP voter (identity) address, from the node's newest active epoch. Join to providerlist.json via flareregistry.entity.identity. */
  identity: string | null;
  /** Lowercase ftsoAddress, from the node's newest active epoch; null when the node has no FTSO provider. */
  delegationAddress: string | null;
  /** Window epochs the node was in nodes-data.json. */
  periods: number;
  /** Of those, epochs it was rewarded (uptimeEligible and eligible). */
  paidPeriods: number;
  missed: { epoch: number; reason: MissedReason }[];
  /** Mean over periods of (nodeReward - feeReward) / rewardingWeight, 0 in missed epochs. FLR per staked FLR. */
  validatorRatePerEpoch: number;
  /** Mean over periods of nodeReward / rewardingWeight, before the validator's fee. */
  validatorGrossRatePerEpoch: number;
  /** Mean over periods of mirrorReward / mirrorWeight, 0 when mirrorWeight is 0. */
  ftsoRatePerEpoch: number;
  /** validatorRatePerEpoch + ftsoRatePerEpoch. */
  ratePerEpoch: number;
  /** ratePerEpoch * 365 / 3.5. */
  annualRate: number;
  /** Validator fee in the newest active epoch, percent. */
  feePercent: number;
  /** cappedWeight / rewardingWeight in the newest active epoch; null when it was not rewarded then or rewardingWeight is 0. */
  cappedShare: number | null;
  /** Newest window epoch the node was active in. */
  lastEpoch: number;
}

export interface NetworkValidators {
  chainId: number;
  /** The window, ascending. */
  epochs: number[];
  /** Stake on every active validator in the newest epoch, wei-scale. */
  totalStake: string;
  validators: ValidatorScore[];
}

export interface ValidatorFeed {
  name: string;
  generatedAt: string;
  method: string;
  windowEpochs: number;
  networks: Record<string, NetworkValidators>;
}

const toTokens = (wei: bigint) => Number(wei / WEI) + Number(wei % WEI) / 1e18;
const big = (s: string | null | undefined) => {
  try {
    return s ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
};
/** a / b as a plain number, 0 when b is not positive. */
const ratio = (a: bigint, b: bigint) => (b > 0n ? toTokens(a) / toTokens(b) : 0);

/**
 * The window: the newest run of consecutive epochs among `epochIds` that ends at the newest of them, at
 * most `size` long, ascending. An epoch with no rows breaks the run, so the window is never a set of
 * epochs with a hole in it; it is shorter instead until the hole has left it. [] when there are none.
 */
export function validatorWindow(epochIds: number[], size: number): number[] {
  const have = new Set(epochIds.filter((e) => Number.isSafeInteger(e)));
  if (have.size === 0 || size < 1) return [];
  const newest = Math.max(...have);
  const window: number[] = [];
  for (let e = newest; have.has(e) && window.length < size; e--) window.unshift(e);
  return window;
}

const missedReason = (r: ValidatorNodeRow): MissedReason | null => {
  if (!r.uptimeEligible) return "uptime";
  if (!r.eligible) return r.delegationAddress == null ? "noProvider" : "conditions";
  return null;
};

/**
 * Every node active in any epoch of `epochs`, scored on what one staked FLR earned on it, highest
 * ratePerEpoch first (ties by nodeId). Rows outside `epochs` are ignored; a node and epoch given twice
 * counts once. Each rate is worked out per epoch in BigInt and averaged over the epochs the node was
 * active in, so a node that left mid-window is scored on the epochs it was there for.
 */
export function rankValidators(rows: ValidatorNodeRow[], epochs: number[]): Omit<NetworkValidators, "chainId"> {
  const window = [...new Set(epochs)].sort((a, b) => a - b);
  const want = new Set(window);
  const newest = window.length ? window[window.length - 1]! : null;

  const byNode = new Map<string, Map<number, ValidatorNodeRow>>();
  for (const r of rows) {
    if (!want.has(r.epochId)) continue;
    const list = byNode.get(r.nodeId) ?? new Map<number, ValidatorNodeRow>();
    if (!list.has(r.epochId)) list.set(r.epochId, r);
    byNode.set(r.nodeId, list);
  }

  let totalStake = 0n;
  const validators: ValidatorScore[] = [];
  for (const [nodeId, list] of byNode) {
    const active = [...list.values()].sort((a, b) => a.epochId - b.epochId);
    const last = active[active.length - 1]!;
    if (last.epochId === newest) totalStake += big(last.stake);

    let net = 0;
    let gross = 0;
    let ftso = 0;
    const missed: ValidatorScore["missed"] = [];
    for (const r of active) {
      const reason = missedReason(r);
      if (reason) missed.push({ epoch: r.epochId, reason });
      else {
        const weight = big(r.rewardingWeight);
        const reward = big(r.nodeReward);
        net += ratio(reward - big(r.feeReward), weight);
        gross += ratio(reward, weight);
      }
      ftso += ratio(big(r.mirrorReward), big(r.mirrorWeight));
    }
    const periods = active.length;
    const validatorRatePerEpoch = net / periods;
    const ftsoRatePerEpoch = ftso / periods;
    const ratePerEpoch = validatorRatePerEpoch + ftsoRatePerEpoch;
    const lastWeight = big(last.rewardingWeight);
    validators.push({
      nodeId,
      identity: last.identity?.toLowerCase() ?? null,
      delegationAddress: last.delegationAddress?.toLowerCase() ?? null,
      periods,
      paidPeriods: periods - missed.length,
      missed,
      validatorRatePerEpoch,
      validatorGrossRatePerEpoch: gross / periods,
      ftsoRatePerEpoch,
      ratePerEpoch,
      annualRate: (ratePerEpoch * 365) / REWARD_EPOCH_DAYS,
      feePercent: last.feePpm / FEE_PPM_PER_PERCENT,
      cappedShare: missedReason(last) == null && lastWeight > 0n ? ratio(big(last.cappedWeight), lastWeight) : null,
      lastEpoch: last.epochId,
    });
  }
  validators.sort((a, b) => b.ratePerEpoch - a.ratePerEpoch || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return { epochs: window, totalStake: totalStake.toString(), validators };
}

/** The feed's method text, for a window of `windowEpochs` reward epochs. */
export function validatorFeedMethod(windowEpochs: number): string {
  return (
    `Per P-chain validator node on Flare, over the newest run of up to ${windowEpochs} consecutive reward epochs ` +
    "(epochs) for which Flare has published both its reward-scripts files (generated-files/reward-epoch-N/" +
    "nodes-data.json) and its fsp-rewards files (flare/N/reward-epoch-info.json and reward-distribution-data.json). " +
    "Every rate is FLR earned per FLR staked on the node in one reward epoch, worked out for each epoch and then " +
    "averaged over the epochs the node was active in (periods), an epoch in which it earned nothing counting as 0. " +
    "validatorGrossRatePerEpoch is the node's validator reward (nodeRewardAmount) divided by its rewardingWeight, " +
    "before the validator's fee. validatorRatePerEpoch is the same after that fee (nodeRewardAmount x fee / 1e6, as " +
    "Flare computes it), which is what the node's self-bond, boost and delegators earned per FLR. ftsoRatePerEpoch is " +
    "the FSP staking rewards (MIRROR, claimType 3) paid to the node ID, after its FTSO provider's staking fee, divided " +
    "by the node's FSP weight (its nodeWeight in reward-epoch-info.json), 0 when no provider gives it weight. " +
    "ratePerEpoch is the sum of the two and annualRate is ratePerEpoch x 365 / 3.5. paidPeriods counts the epochs in " +
    "which Flare rewarded the node (uptimeEligible and eligible in nodes-data.json); missed lists the others with the " +
    "reason: uptime (the node failed Flare's uptime requirement and got no share), noProvider (no FTSO provider is " +
    "linked to the node, so its share was burned) or conditions (its FTSO provider was not eligible for rewards that " +
    "epoch under Flare's minimal conditions, so its share was burned). identity is the FSP voter that lists the node, " +
    "or else the voter whose delegation address is the node's ftsoAddress. identity, delegationAddress, feePercent " +
    "and cappedShare (cappedWeight / rewardingWeight, below 1 when the node's entity is over Flare's 5% stake cap; " +
    "null when the node was not rewarded) are from the newest epoch the node was active in (lastEpoch). totalStake is " +
    "the stake on every active validator in the newest epoch, wei-scale. Sorted by ratePerEpoch, highest first. " +
    "These are past rewards, not a promise of future ones."
  );
}
