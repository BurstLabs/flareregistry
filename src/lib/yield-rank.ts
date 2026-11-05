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

/** One reward epoch of P-chain validator rewards, network-wide (ValidatorRewardEpoch). Flare only. */
export interface ValidatorRewardRow {
  epochId: number;
  /** Validator rewards paid on stake after the validator's fee, wei. */
  stakerReward: string;
  /** Stake on every active validator, wei. */
  totalStake: string;
}

/** What a staked FLR earned: the FTSO (MIRROR) part plus, when published for the whole window, the validator part. */
export interface StakerRates extends RateSummary {
  /** Total MIRROR rewards / total stake on the providers' validator nodes. */
  ftso: RateSummary;
  /** Validator rewards after the validator's fee / total stake on every active validator. Absent when includesValidatorRewards is false. */
  validator?: RateSummary;
}

/** Network-wide delegator and staker rates over the same window, summed across every registered provider. */
export interface NetworkRates {
  epochs: number[];
  /** Total WNAT delegator rewards / total wNatWeight. */
  delegators: RateSummary;
  /** stakers.ftso plus stakers.validator; stakers.ftso alone when includesValidatorRewards is false. */
  stakers: StakerRates;
  /** stakers.ratePerEpoch / delegators.ratePerEpoch. */
  stakersToDelegators: number;
  /** false when Flare has not yet published validator rewards for every epoch of the window. */
  includesValidatorRewards: boolean;
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

/**
 * Pure ranking over stored rows, so it can be checked against the raw fsp-rewards files. epochDays is
 * the reward epoch length used to annualise: 3.5 on Flare and Songbird, 0.25 on Coston2.
 */
export function rankYield(
  rows: YieldRow[],
  epochs: number[],
  epochDays: number = REWARD_EPOCH_DAYS,
): Omit<NetworkYield, "chainId"> {
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
        annualRate: (rate * 365) / epochDays,
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

/**
 * How many epochs the networkRates window may trail the ranking window so it can include validator
 * rewards. Flare publishes them in reward-scripts 1 to 18 hours after fsp-rewards, so for that long
 * after each new epoch the newest complete window ends one epoch earlier. 1 means the window ends at
 * the ranking window's newest epoch or the one before it: the last 2 epochs. Validator rewards missing
 * for longer than that is an outage, not a lag, and the figure falls back to the FTSO part alone.
 */
export const VALIDATOR_LAG_EPOCHS = 1;

const NETWORK_RATES_METHOD_BASE =
  "Network-wide, over one window of reward epochs (epochs). Delegators: total WNAT delegator rewards " +
  "(fsp-rewards claimType 2) paid to every registered provider's delegation address divided by their total " +
  "registered wNatWeight, after the provider's fee. Stakers: what a staked FLR earned, the sum of two " +
  "per-FLR rates. stakers.ftso is the total MIRROR rewards (claimType 3) paid to the providers' registered " +
  "validator node IDs, after the provider's capped staking fee and shared by all the FLR staked on those " +
  "nodes, divided by the total stake on those nodes (nodeWeights). stakers.validator is the P-chain " +
  "validator rewards Flare pays through ValidatorRewardManager, from its reward-scripts files " +
  "(generated-files/reward-epoch-N/nodes-data.json): each rewarded node's reward minus the validator's fee, " +
  "which is what its self-bond, boost and delegators earned, divided by the total stake on every active " +
  "validator, including nodes whose share Flare burned or withheld for failing minimal conditions or " +
  "uptime. Each rate is rewards summed over the window divided by weights summed over the window, per " +
  "reward epoch, annualised as rate x 365 / 3.5. stakersToDelegators is the stakers' rate divided by the " +
  "delegators'. The window is the newest run of consecutive reward epochs, as long as the provider " +
  "ranking's, for which both fsp-rewards and Flare's validator rewards are published. Flare publishes " +
  "validator rewards up to a day after fsp-rewards, so for that long after each new epoch the window ends " +
  "one epoch before the ranking's and the figure does not change until the new epoch is complete. Present " +
  "only where the window has P-chain stake, so never on Songbird.";

/** Method text when the validator part is in the staker rate. */
export const NETWORK_RATES_METHOD = NETWORK_RATES_METHOD_BASE;

/** Method text when it is not: validator rewards missing for longer than the usual publication lag. */
export const NETWORK_RATES_METHOD_FTSO_ONLY =
  NETWORK_RATES_METHOD_BASE +
  " includesValidatorRewards is false: no complete window ends within the last " +
  `${VALIDATOR_LAG_EPOCHS + 1} reward epochs, because Flare has not published validator rewards for longer ` +
  "than its usual lag, so the window is the provider ranking's and stakers is stakers.ftso alone, which " +
  "understates what stakers earned.";

const annual = (rate: number) => (rate * 365) / REWARD_EPOCH_DAYS;
const summary = (rate: number): RateSummary => ({ ratePerEpoch: rate, annualRate: annual(rate) });

/**
 * The validator part of the staker rate over `epochs`: total validator rewards after fee over total
 * stake, both summed over the window. Null unless every epoch of the window has a row with readable,
 * positive stake, and the window's rewards are positive, so a partial window is never passed off as a
 * whole one.
 */
export function validatorRate(rows: ValidatorRewardRow[] | null | undefined, epochs: number[]): number | null {
  if (!rows || epochs.length === 0) return null;
  const want = new Set(epochs);
  const byEpoch = new Map<number, ValidatorRewardRow>();
  for (const r of rows) if (want.has(r.epochId) && !byEpoch.has(r.epochId)) byEpoch.set(r.epochId, r);
  if (byEpoch.size !== want.size) return null;
  let reward = 0n;
  let stake = 0n;
  for (const r of byEpoch.values()) {
    let a: bigint, w: bigint;
    try {
      a = BigInt(r.stakerReward);
      w = BigInt(r.totalStake);
    } catch {
      return null;
    }
    if (a < 0n || w <= 0n) return null;
    reward += a;
    stake += w;
  }
  if (reward <= 0n) return null;
  const rate = toTokens(reward) / toTokens(stake);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

interface FspTotals {
  delegators: number;
  ftso: number;
}

/** The FSP part over `epochs`: null unless every epoch has rows, every row's stake is filled and there is stake. */
function fspRates(rows: YieldRow[], epochs: number[]): FspTotals | null {
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
  if (want.size === 0 || seen.size !== want.size) return null;
  if (wNatWeight <= 0n || stakeWeight <= 0n || delegatorReward <= 0n || stakerReward <= 0n) return null;
  const delegators = toTokens(delegatorReward) / toTokens(wNatWeight);
  const ftso = toTokens(stakerReward) / toTokens(stakeWeight);
  return [delegators, ftso].every((x) => Number.isFinite(x) && x > 0) ? { delegators, ftso } : null;
}

function buildRates(epochs: number[], fsp: FspTotals, fromValidators: number | null): NetworkRates | null {
  const stakers = fsp.ftso + (fromValidators ?? 0);
  const ratio = stakers / fsp.delegators;
  if (![stakers, ratio].every((x) => Number.isFinite(x) && x > 0)) return null;
  return {
    epochs,
    delegators: summary(fsp.delegators),
    stakers: {
      ...summary(stakers),
      ftso: summary(fsp.ftso),
      ...(fromValidators != null ? { validator: summary(fromValidators) } : {}),
    },
    stakersToDelegators: ratio,
    includesValidatorRewards: fromValidators != null,
    method: fromValidators != null ? NETWORK_RATES_METHOD : NETWORK_RATES_METHOD_FTSO_ONLY,
  };
}

/**
 * What delegators and stakers earned per token across the whole network, from the same stored rows as
 * rankYield. Defined like the per-provider rate: rewards summed over the window divided by weights summed
 * over the window, so it is the weight-averaged per-epoch rate. `epochs` is the ranking window; `rows`
 * and `validator` may reach VALIDATOR_LAG_EPOCHS further back.
 *
 * The window is the newest one, `epochs` or `epochs` shifted back by up to VALIDATOR_LAG_EPOCHS, where
 * both the FSP rows and the validator rewards (`validator`, Flare only) cover every epoch. So the normal
 * publication lag of Flare's validator files holds the previous complete window rather than changing the
 * figure. When no such window exists, the figure is the FTSO part alone over `epochs`, flagged
 * includesValidatorRewards: false, so a long outage still shows a figure.
 *
 * Returns null rather than a partial figure when no window qualifies and `epochs` itself has an epoch
 * with no rows, a row whose stake weight has not been filled, or no stake at all (Songbird, which has no
 * P-chain staking and lists no nodes).
 */
export function networkRates(
  rows: YieldRow[],
  epochs: number[],
  validator?: ValidatorRewardRow[] | null,
): NetworkRates | null {
  if (validator && validator.length > 0) {
    for (let lag = 0; lag <= VALIDATOR_LAG_EPOCHS; lag++) {
      const window = epochs.map((e) => e - lag);
      const fromValidators = validatorRate(validator, window);
      if (fromValidators == null) continue;
      const fsp = fspRates(rows, window);
      if (!fsp) continue;
      const rates = buildRates(window, fsp, fromValidators);
      if (rates) return rates;
    }
  }
  const fsp = fspRates(rows, epochs);
  return fsp ? buildRates(epochs, fsp, null) : null;
}
