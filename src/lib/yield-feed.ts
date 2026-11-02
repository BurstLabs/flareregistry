// DELEGATOR YIELD FEED: what delegators actually earned per wrapped token, per provider, over the
// last N reward epochs. Served at /api/feed/yield.json for wallets (Burst Wallet ranks its provider
// picker on it) and anyone else.
//
// Method, from the rows ingest.ts already stores per epoch (Flare's own fsp-rewards files):
//   rate = sum(delegatorReward) / sum(wNatWeight) over the window, per reward epoch.
// delegatorReward is the WNAT (claimType 2) pool paid to the provider's delegation address, i.e. what
// its delegators shared after the fee. Only providers present in EVERY epoch of the window with at
// least MIN_VOTE_POWER are ranked, so a provider that joined last week cannot top the list on one
// lucky epoch. One epoch is noisy; ten is the window the ranking is built for.
//
// cappedShare = sum(wNatCappedWeight) / sum(wNatWeight): the share of vote power the reward formula
// counts. Below 1 means the provider is over the cap and each delegator's share is diluted.
//
// Eligibility is reported as Flare published it for the newest epoch (passes.json), never inferred.
//
// networkRates (additive, per network): what delegators earned per wrapped token and what P-chain
// stakers earned per staked token across the whole network over the same window, and the ratio. Wallets
// show "stakers earned about N times more" from it rather than a number written into the app. Songbird
// has no P-chain staking (no node weights, no MIRROR claims), so it never carries the field.
// The stakers' rate is the FSP MIRROR part plus the P-chain validator rewards Flare pays through
// ValidatorRewardManager (ValidatorRewardEpoch, from Flare's reward-scripts files). Those are published
// up to a day after fsp-rewards, so for a while after each new epoch networkRates holds the previous
// complete window (its epochs then end one before the ranking's) instead of changing the figure. Only
// when they are missing for longer is it the MIRROR part alone, flagged includesValidatorRewards: false.

import { prisma } from "./db";
import { NETWORKS } from "./ingest";
import { MIN_VOTE_POWER, VALIDATOR_LAG_EPOCHS, YIELD_WINDOW_EPOCHS, networkRates, rankYield, type NetworkYield } from "./yield-rank";

export type { NetworkRates, NetworkYield, ProviderYield, StakerRates, ValidatorRewardRow, YieldRow } from "./yield-rank";

const CHAIN_IDS: Record<(typeof NETWORKS)[number], number> = { flare: 14, songbird: 19 };

/** Byte-exact submission agreement, as Oracle Independence measures it (Flare only). */
export interface Independence {
  /** Highest share of recent rounds in which this provider submitted identical encoded values to one other provider. */
  maxAgreement: number;
  /** Other providers it matched in at least `threshold` of those rounds. */
  peersAboveThreshold: number;
  threshold: number;
  measuredAt: string;
  method: string;
}

export interface YieldFeed {
  name: string;
  generatedAt: string;
  method: string;
  windowEpochs: number;
  networks: Record<string, NetworkYield & { independence?: Record<string, Independence> }>;
}

// Oracle Independence (our own service on the same box) measures pairwise byte-exact agreement on
// Flare. The feed carries its numbers as measured facts with the method link, never as a verdict.
// Cached for 10 minutes; if OI is unreachable the feed is served without it rather than failing.
const OI_BASE = process.env.OI_BASE_URL ?? "https://oracleindependence.com";
let oiCache: { at: number; value: Record<string, Independence> | null } | null = null;

async function flareIndependence(): Promise<Record<string, Independence> | null> {
  if (oiCache && Date.now() - oiCache.at < 10 * 60_000) return oiCache.value;
  let value: Record<string, Independence> | null = null;
  try {
    const res = await fetch(`${OI_BASE}/api/agreement/network`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const d = (await res.json()) as {
        network?: string;
        stale?: boolean;
        measuredAt?: string;
        threshold?: number;
        nodes?: { identity?: string; maxRate?: number; degree?: number }[];
      };
      if (d.network === "flare" && !d.stale && Array.isArray(d.nodes)) {
        value = {};
        for (const n of d.nodes) {
          if (!n.identity || typeof n.maxRate !== "number" || typeof n.degree !== "number") continue;
          value[n.identity.toLowerCase()] = {
            maxAgreement: n.maxRate,
            peersAboveThreshold: n.degree,
            threshold: d.threshold ?? 0.6,
            measuredAt: d.measuredAt ?? "",
            method: `${OI_BASE}/method`,
          };
        }
      }
    }
  } catch {
    value = null;
  }
  oiCache = { at: Date.now(), value };
  return value;
}

export async function buildYieldFeed(): Promise<YieldFeed> {
  const networks: YieldFeed["networks"] = {};
  const independence = await flareIndependence();
  for (const network of NETWORKS) {
    const state = await prisma.ingestState.findUnique({ where: { network } });
    const newest = state?.lastEpochIngested ?? 0;
    if (newest <= 0) continue;
    const epochs = Array.from({ length: YIELD_WINDOW_EPOCHS }, (_, i) => newest - i).reverse();
    // networkRates may hold a window up to VALIDATOR_LAG_EPOCHS older than the ranking's, so the rows
    // reach that far back. The ranking itself is given its own window's rows only.
    const reach = Array.from({ length: YIELD_WINDOW_EPOCHS + VALIDATOR_LAG_EPOCHS }, (_, i) => newest - i).reverse();
    const rows = await prisma.providerMetricEpoch.findMany({
      where: { network, epochId: { in: reach } },
      select: {
        epochId: true,
        voter: true,
        wNatWeight: true,
        wNatCappedWeight: true,
        delegatorReward: true,
        goodStanding: true,
        passes: true,
        failures: true,
        stakerReward: true,
        stakeWeight: true,
      },
    });
    // P-chain validator rewards exist on Flare only. Never queried for Songbird, so it cannot carry them.
    const validator =
      network === "flare"
        ? await prisma.validatorRewardEpoch.findMany({
            where: { network, epochId: { in: reach } },
            select: { epochId: true, stakerReward: true, totalStake: true },
          })
        : null;
    const rates = networkRates(rows, epochs, validator);
    networks[network] = {
      chainId: CHAIN_IDS[network],
      ...rankYield(
        rows.filter((r) => epochs.includes(r.epochId)),
        epochs,
      ),
      ...(network === "flare" && independence ? { independence } : {}),
      ...(rates ? { networkRates: rates } : {}),
    };
  }
  return {
    name: "Flare Registry delegator yield",
    generatedAt: new Date().toISOString(),
    method:
      "Per provider: sum of WNAT delegator rewards paid to its delegation address divided by its registered wNatWeight, " +
      `over the last ${YIELD_WINDOW_EPOCHS} reward epochs, from Flare's fsp-rewards data. Only providers registered in every ` +
      `epoch of the window with at least ${MIN_VOTE_POWER.toLocaleString("en-US")} vote power are ranked. Eligibility is ` +
      "Flare's passes.json for the newest epoch. Independence (Flare only) is Oracle Independence's live byte-exact " +
      "agreement measurement, keyed by identity address.",
    windowEpochs: YIELD_WINDOW_EPOCHS,
    networks,
  };
}
