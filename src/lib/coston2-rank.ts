// COSTON2 PROVIDER LIST AND DELEGATOR YIELD, from Coston2's own contracts.
//
// Flare publishes fsp-rewards files for Flare and Songbird only, so the Coston2 (chain 114) feeds are
// built from the chain. coston2-feed.ts reads it; everything here is pure so the check script can run
// it without a network.
//
// Per provider and reward epoch:
//   wNatWeight, wNatCappedWeight, fee: FlareSystemsCalculator's VoterRegistrationInfo event, emitted when
//     the voter registered for that epoch. wNatWeight is the delegation address's vote power at the
//     epoch's vote power block, the same figure fsp-rewards calls wNatWeight.
//   delegator reward: RewardManager.getUnclaimedRewardState(delegationAddress, epoch, WNAT). Once the
//     epoch's weight-based claim is initialised it holds the delegators' pool (after the provider's fee)
//     and the vote power it is shared over. Each delegator's claim removes its share of both, so
//     amount / weight stays the pool's reward per token however much has been claimed. Checked against
//     Flare's own fsp-rewards on Flare epoch 445: equal to every printed digit for three providers whose
//     delegators had claimed 40 to 81 percent. The pool is that rate times wNatWeight.
//   An epoch whose weight-based claims are all initialised and that has no initialised WNAT claim for a
//   provider paid its delegators nothing. Anything else unknown is left out, never guessed: a provider
//   missing an epoch of the window is not ranked on the window (wallets fall back to the last epoch).
//
// Names: a Flare Registry listing on chain 114, else the legacy public provider list's chain 114 entry
// (the list Flare Registry imports Flare and Songbird listings from), else the delegation address, as for
// any unclaimed on-chain entity. Nothing is invented and no provider is favoured.

import type { YieldRow, NetworkYield } from "./yield-rank";
import type { FeedProvider, ProviderList } from "./feed";

export const COSTON2_CHAIN_ID = 114;
export const COSTON2_NETWORK = "coston2";
/** How far back the newest epoch of the window may sit when the newest epochs are not yet initialised. */
export const COSTON2_READY_LOOKBACK = 3;

export interface Coston2Registration {
  epochId: number;
  /** Identity (voter) address, checksummed. */
  voter: string;
  /** Checksummed. */
  delegationAddress: string;
  feeBips: number;
  wNatWeight: bigint;
  wNatCappedWeight: bigint;
}

export interface Coston2Entity {
  identity: string;
  submit: string | null;
  submitSignatures: string | null;
  signingPolicy: string | null;
  delegation: string;
}

export interface Coston2RewardState {
  initialised: boolean;
  amount: bigint;
  weight: bigint;
}

export interface Coston2EpochClaims {
  /** noOfWeightBasedClaims for this reward manager. 0 = rewards not signed yet. */
  total: number;
  /** noOfInitialisedWeightBasedClaims. */
  initialised: number;
}

export interface Coston2Snapshot {
  currentEpoch: number;
  epochSeconds: number;
  /** Registrations for the candidate epochs and the current one. */
  registrations: Coston2Registration[];
  /** Role addresses of the voters registered in the current epoch. */
  entities: Coston2Entity[];
  /** Keyed by stateKey(epochId, delegationAddress). */
  rewardStates: Map<string, Coston2RewardState>;
  claims: Map<number, Coston2EpochClaims>;
}

/** What is published about a provider: a Flare Registry listing or the legacy list's entry. */
export interface Coston2Listing {
  name: string;
  description: string;
  url: string;
  logoURI: string;
  verified: boolean;
  attestedAt: string | null;
}

export const stateKey = (epochId: number, delegationAddress: string) => `${epochId}:${delegationAddress.toLowerCase()}`;

const epochComplete = (c: Coston2EpochClaims | undefined) => !!c && c.total > 0 && c.initialised >= c.total;

/**
 * The delegators' pool for one provider and epoch, in wei. null = not knowable from the chain right now
 * (rewards not initialised yet, or every token already claimed so the ratio is gone).
 */
export function delegatorReward(
  wNatWeight: bigint,
  state: Coston2RewardState | undefined,
  claims: Coston2EpochClaims | undefined,
): bigint | null {
  if (!claims || claims.total <= 0) return null; // rewards for this epoch not signed yet
  if (!state || !state.initialised) return epochComplete(claims) ? 0n : null;
  if (state.weight <= 0n) return null;
  return (state.amount * wNatWeight) / state.weight;
}

/**
 * The window: windowLen consecutive epochs ending at the newest epoch before the current one whose
 * delegator reward is known for every provider registered in it. Looks back COSTON2_READY_LOOKBACK
 * epochs for one (rewards are signed and initialised some time after an epoch ends), then settles for the
 * newest epoch with signed rewards. Empty when nothing is signed.
 */
export function chooseWindow(s: Coston2Snapshot, windowLen: number): number[] {
  const regsByEpoch = new Map<number, Coston2Registration[]>();
  for (const r of s.registrations) {
    const list = regsByEpoch.get(r.epochId) ?? [];
    list.push(r);
    regsByEpoch.set(r.epochId, list);
  }
  let newest: number | null = null;
  let fallback: number | null = null;
  for (let e = s.currentEpoch - 1; e >= s.currentEpoch - COSTON2_READY_LOOKBACK; e--) {
    const claims = s.claims.get(e);
    if (!claims || claims.total <= 0) continue;
    fallback ??= e;
    const regs = regsByEpoch.get(e) ?? [];
    const known = regs.every(
      (r) => delegatorReward(r.wNatWeight, s.rewardStates.get(stateKey(e, r.delegationAddress)), claims) !== null,
    );
    if (regs.length > 0 && known) {
      newest = e;
      break;
    }
  }
  const end = newest ?? fallback;
  if (end == null) return [];
  return Array.from({ length: windowLen }, (_, i) => end - windowLen + 1 + i);
}

/** Rows in the shape the Flare and Songbird ranking reads. A provider-epoch with no known reward has no row. */
export function coston2YieldRows(s: Coston2Snapshot, epochs: number[]): YieldRow[] {
  const want = new Set(epochs);
  const rows: YieldRow[] = [];
  for (const r of s.registrations) {
    if (!want.has(r.epochId)) continue;
    const reward = delegatorReward(r.wNatWeight, s.rewardStates.get(stateKey(r.epochId, r.delegationAddress)), s.claims.get(r.epochId));
    if (reward === null) continue;
    rows.push({
      epochId: r.epochId,
      voter: r.voter.toLowerCase(),
      wNatWeight: r.wNatWeight.toString(),
      wNatCappedWeight: r.wNatCappedWeight.toString(),
      delegatorReward: reward.toString(),
      // Eligibility comes from Flare's passes files, which do not exist for Coston2. Unknown, not true.
      goodStanding: null,
      passes: null,
      failures: [],
    });
  }
  return rows;
}

export type RankFn = (rows: YieldRow[], epochs: number[], epochDays: number) => Omit<NetworkYield, "chainId">;

export interface Coston2Feeds {
  providerList: ProviderList;
  yieldFeed: {
    name: string;
    generatedAt: string;
    method: string;
    windowEpochs: number;
    networks: Record<string, NetworkYield>;
  };
}

export function coston2YieldMethod(windowLen: number, minVotePower: number, epochHours: number): string {
  return (
    "Coston2 (chain 114), read from Coston2's own contracts through the FlareContractRegistry, since Flare " +
    "publishes no fsp-rewards files for it. Per provider: the WNAT delegator reward pool divided by its " +
    `registered wNatWeight, summed over the last ${windowLen} reward epochs (${epochHours} hours each). ` +
    "wNatWeight is FlareSystemsCalculator's VoterRegistrationInfo for the epoch. The pool is " +
    "RewardManager.getUnclaimedRewardState(delegation address, epoch, WNAT): amount / weight is the reward " +
    "per token whatever has been claimed, times wNatWeight. Only providers registered with a known reward in " +
    `every epoch of the window and at least ${minVotePower.toLocaleString("en-US")} vote power are ranked. ` +
    "Eligibility is null: Flare publishes no passes files for Coston2. annualRate = ratePerEpoch x 365 / " +
    `${epochHours / 24}. Test network tokens have no value; this ranks providers, it is not an income figure.`
  );
}

export function assembleCoston2Feeds(
  s: Coston2Snapshot,
  opts: {
    rank: RankFn;
    windowLen: number;
    minVotePower: number;
    revokeAfterEpochs: number;
    placeholderLogo: string;
    /** Origin the schema URL is built from, so the test harness can pass its own. */
    publicBaseUrl: string;
    /** Keyed by lowercase role address. Flare Registry listings win over the legacy list. */
    registryListings: Map<string, Coston2Listing>;
    upstreamListings: Map<string, Coston2Listing>;
    now: Date;
  },
): Coston2Feeds {
  const epochs = chooseWindow(s, opts.windowLen);
  const epochDays = s.epochSeconds / 86_400;
  const newest = epochs.length ? epochs[epochs.length - 1]! : null;
  const ranked = epochs.length ? opts.rank(coston2YieldRows(s, epochs), epochs, epochDays) : null;

  const current = s.registrations.filter((r) => r.epochId === s.currentEpoch);
  const entityByVoter = new Map(s.entities.map((e) => [e.identity.toLowerCase(), e]));
  const lastByVoter = new Map<string, Coston2Registration>();
  if (newest != null) for (const r of s.registrations) if (r.epochId === newest) lastByVoter.set(r.voter.toLowerCase(), r);

  const providers: FeedProvider[] = current.map((r) => {
    const entity = entityByVoter.get(r.voter.toLowerCase()) ?? {
      identity: r.voter,
      submit: null,
      submitSignatures: null,
      signingPolicy: null,
      delegation: r.delegationAddress,
    };
    const roles = [entity.identity, entity.delegation, entity.submit, entity.submitSignatures, entity.signingPolicy]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase());
    const pick = (m: Map<string, Coston2Listing>) => roles.map((a) => m.get(a)).find(Boolean);
    const listing = pick(opts.registryListings) ?? pick(opts.upstreamListings);
    const last = lastByVoter.get(r.voter.toLowerCase());
    const lastReward =
      newest != null && last
        ? delegatorReward(last.wNatWeight, s.rewardStates.get(stateKey(newest, last.delegationAddress)), s.claims.get(newest))
        : null;
    return {
      chainId: COSTON2_CHAIN_ID,
      name: listing?.name ?? r.delegationAddress.toLowerCase(),
      description: listing?.description ?? "",
      url: listing?.url ?? "",
      address: r.delegationAddress,
      logoURI: listing?.logoURI || opts.placeholderLogo,
      // listed means Qualified, which is not assessed on a test network.
      listed: false,
      flareregistry: {
        verified: listing?.verified ?? false,
        registered: true,
        managementGroup: false,
        qualified: false,
        // Qualification is not assessed on a test network, so no entry here can be "listed" and
        // none can be "departed" either: there is no pass data to go silent against. A listing
        // gives it an identity; without one it is a registration nobody has named.
        status: listing ? "unqualified" : "unnamed",
        // No digest on a test network: these logos come from a registry listing we did not hash
        // per entry, and nothing consumes Coston2 images for verification.
        logoHash: null,
        network: COSTON2_NETWORK,
        feePercent: r.feeBips / 100,
        votePower: r.wNatWeight.toString(),
        votePowerCapped: r.wNatCappedWeight.toString(),
        feedCount: null,
        activeSince: null,
        lastEpoch: lastReward !== null ? newest : null,
        delegatorRewardLastEpoch: lastReward !== null ? lastReward.toString() : null,
        // Fee rewards are direct claims, on chain only once claimed, so not knowable here.
        feeRewardLastEpoch: null,
        entity: {
          identity: entity.identity,
          submit: entity.submit,
          submitSignatures: entity.submitSignatures,
          signingPolicy: entity.signingPolicy,
          delegation: entity.delegation,
        },
        validators: [],
        selfDeclared: { privateNode: null, algorithm: null, singleEntity: null },
        qualification: {
          qualifiedSince: null,
          lastSubmittedEpoch: null,
          epochsSinceSubmit: null,
          epochsUntilRevoke: null,
          revokeAfterEpochs: opts.revokeAfterEpochs,
        },
        updatedAt: null,
        attestedAt: listing?.attestedAt ?? null,
      },
    };
  });
  providers.sort((a, b) => a.name.localeCompare(b.name));

  const generatedAt = opts.now.toISOString();
  return {
    providerList: {
      // Same schema as the mainnet feeds: the shape is identical and a consumer validating one
      // should validate the other, which is the point of the guard in check-coston2-feed.
      $schema: `${opts.publicBaseUrl}/providerlist.schema.json`,
      name: "Flare Registry FTSO Signal Providers (Coston2)",
      timestamp: generatedAt,
      version: { major: 1, minor: 4, patch: 0 },
      providers,
    },
    yieldFeed: {
      name: "Flare Registry delegator yield (Coston2)",
      generatedAt,
      method: coston2YieldMethod(opts.windowLen, opts.minVotePower, s.epochSeconds / 3600),
      windowEpochs: opts.windowLen,
      networks: ranked ? { [COSTON2_NETWORK]: { chainId: COSTON2_CHAIN_ID, ...ranked } } : {},
    },
  };
}
