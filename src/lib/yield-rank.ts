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

export interface NetworkYield {
  chainId: number;
  epochs: number[];
  median: number;
  providers: ProviderYield[];
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

