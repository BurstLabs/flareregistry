// Pure delegator-yield ranking (no database import), so it can be checked against the raw
// fsp-rewards files or a database export. The feed in yield-feed.ts feeds it stored rows.

export const YIELD_WINDOW_EPOCHS = 10;
export const MIN_VOTE_POWER = 1_000_000; // whole tokens
const REWARD_EPOCH_DAYS = 3.5;
const WEI = 10n ** 18n;

export interface YieldRow {
  epochId: number;
  voter: string;
  wNatWeight: string | null;
  wNatCappedWeight: string | null;
  delegatorReward: string | null;
  goodStanding: boolean | null;
  passes: number | null;
  failures: string[];
  /** claimType 3 (MIRROR) rewards paid to the provider's validator node IDs. Only networkRates reads it. */
  stakerReward?: string | null;
  /** Sum of the provider's nodeWeights. Only networkRates reads it; null = not filled yet. */
  stakeWeight?: string | null;
}

export interface ProviderYield {
  /** Identity (voter) address, lowercase. Join to providerlist.json via flareregistry.entity.identity. */
  identity: string;
  rank: number;
  /** Delegator reward per token per reward epoch, as a fraction. */
  ratePerEpoch: number;
  annualRate: number;
  /** ratePerEpoch / the median provider's. 1 = median. */
  relativeToMedian: number;
  cappedShare: number;
  averageVotePower: number;
  /** Newest epoch in the window, as Flare published it. null = Flare's file did not say. */
  eligibleLastEpoch: boolean | null;
  passesLastEpoch: number | null;
  failuresLastEpoch: string[];
  /** Epochs in the window where Flare marked the provider ineligible. */
  ineligibleEpochs: number;
}

export interface RateSummary {
  /** Reward per token per reward epoch, as a fraction. */
  ratePerEpoch: number;
  /** ratePerEpoch * 365 / 3.5, as for providers. */
  annualRate: number;
}

/** Network-wide delegator and staker rates over the same window, summed across every registered provider. */
export interface NetworkRates {
  epochs: number[];
  /** Total WNAT delegator rewards / total wNatWeight. */
  delegators: RateSummary;
  /** Total MIRROR rewards / total stake on the providers' validator nodes. */
  stakers: RateSummary;
  /** stakers.ratePerEpoch / delegators.ratePerEpoch. */
  stakersToDelegators: number;
  method: string;
}

export interface NetworkYield {
  chainId: number;
  epochs: number[];
  median: number;
  providers: ProviderYield[];
  /** Absent on networks without P-chain staking (Songbird) and whenever the window is incomplete. */
  networkRates?: NetworkRates;
}

const toTokens = (wei: bigint) => Number(wei / WEI) + Number(wei % WEI) / 1e18;
const big = (s: string | null) => {
  try {
    return s ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
};

/** Pure ranking over stored rows, so it can be checked against the raw fsp-rewards files. */
export function rankYield(rows: YieldRow[], epochs: number[]): Omit<NetworkYield, "chainId"> {
  const newest = Math.max(...epochs);
  const byVoter = new Map<string, YieldRow[]>();
  for (const r of rows) {
    if (!epochs.includes(r.epochId)) continue;
    const list = byVoter.get(r.voter) ?? [];
    list.push(r);
    byVoter.set(r.voter, list);
  }

  const ranked = [...byVoter.entries()]
    .filter(([, list]) => new Set(list.map((r) => r.epochId)).size === epochs.length)
    .map(([voter, list]) => {
      let reward = 0n;
      let weight = 0n;
      let capped = 0n;
      for (const r of list) {
        reward += big(r.delegatorReward);
        weight += big(r.wNatWeight);
        capped += big(r.wNatCappedWeight);
      }
      const last = list.find((r) => r.epochId === newest);
      const averageVotePower = toTokens(weight) / epochs.length;
      const rate = weight > 0n ? toTokens(reward) / toTokens(weight) : 0;
      return {
        identity: voter.toLowerCase(),
        ratePerEpoch: rate,
        annualRate: (rate * 365) / REWARD_EPOCH_DAYS,
        cappedShare: weight > 0n ? Math.min(toTokens(capped) / toTokens(weight), 1) : 0,
        averageVotePower,
        eligibleLastEpoch: last?.goodStanding ?? null,
        passesLastEpoch: last?.passes ?? null,
        failuresLastEpoch: last?.failures ?? [],
        ineligibleEpochs: list.filter((r) => r.goodStanding === false).length,
      };
    })
    .filter((p) => p.averageVotePower >= MIN_VOTE_POWER)
    .sort((a, b) => b.ratePerEpoch - a.ratePerEpoch);

  const rates = ranked.map((p) => p.ratePerEpoch).sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const median = rates.length === 0 ? 0 : rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;

  return {
    epochs,
    median,
    providers: ranked.map((p, i) => ({ ...p, rank: i + 1, relativeToMedian: median > 0 ? p.ratePerEpoch / median : 0 })),
  };
}

export const NETWORK_RATES_METHOD =
  "Network-wide, over the same reward epochs, summed across every provider registered in each epoch. " +
  "Delegators: total WNAT delegator rewards (claimType 2) paid to the providers' delegation addresses divided by " +
  "their total registered wNatWeight. Stakers: total MIRROR rewards (claimType 3) paid to the providers' " +
  "registered validator node IDs and shared by the FLR staked on those nodes, divided by the total stake " +
  "registered on those nodes (nodeWeights). Both are after the provider's fee, per reward epoch, and " +
  "annualised as rate x 365 / 3.5. stakersToDelegators is the stakers' rate divided by the delegators'. " +
  "P-chain validator rewards, which Flare pays separately through ValidatorRewardManager and does not " +
  "publish in fsp-rewards, are not included. Present only where the window has P-chain stake, so never " +
  "on Songbird.";

/**
 * What delegators and stakers earned per token across the whole network over `epochs`, from the same
 * stored rows as rankYield. Defined like the per-provider rate: rewards summed over the window divided
 * by weights summed over the window, so it is the weight-averaged per-epoch rate.
 *
 * Returns null rather than a partial figure when any epoch of the window has no rows, when any row's
 * stake weight has not been filled, or when there is no stake at all (Songbird, which has no P-chain
 * staking and lists no nodes).
 */
export function networkRates(rows: YieldRow[], epochs: number[]): NetworkRates | null {
  const want = new Set(epochs);
  const seen = new Set<number>();
  let delegatorReward = 0n;
  let wNatWeight = 0n;
  let stakerReward = 0n;
  let stakeWeight = 0n;
  for (const r of rows) {
    if (!want.has(r.epochId)) continue;
    if (r.stakeWeight == null || r.stakerReward == null) return null;
    seen.add(r.epochId);
    delegatorReward += big(r.delegatorReward);
    wNatWeight += big(r.wNatWeight);
    stakerReward += big(r.stakerReward);
    stakeWeight += big(r.stakeWeight);
  }
  if (seen.size !== want.size) return null;
  if (wNatWeight <= 0n || stakeWeight <= 0n || delegatorReward <= 0n || stakerReward <= 0n) return null;

  const delegators = toTokens(delegatorReward) / toTokens(wNatWeight);
  const stakers = toTokens(stakerReward) / toTokens(stakeWeight);
  const ratio = stakers / delegators;
  if (![delegators, stakers, ratio].every((x) => Number.isFinite(x) && x > 0)) return null;

  const annual = (rate: number) => (rate * 365) / REWARD_EPOCH_DAYS;
  return {
    epochs,
    delegators: { ratePerEpoch: delegators, annualRate: annual(delegators) },
    stakers: { ratePerEpoch: stakers, annualRate: annual(stakers) },
    stakersToDelegators: ratio,
    method: NETWORK_RATES_METHOD,
  };
}
