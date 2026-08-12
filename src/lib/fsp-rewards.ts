// Parser for the Flare-published fsp-rewards dataset
// (github.com/flare-foundation/fsp-rewards, folder <network>/<epochId>/).
//
// Pure functions: given the parsed JSON of an epoch's reward-epoch-info.json and
// reward-distribution-data.json (and optionally passes.json), produce per-provider metric
// records keyed by the entity's identity (voter) address. No I/O here; the job does the fetch.
//
// Schema verified against real Flare epoch 327. See docs/evolved-registry-research.md.

// claimType taxonomy in reward-distribution-data.json.
const CLAIM_FEE = 1; // provider commission
const CLAIM_WNAT = 2; // delegator pool
const CLAIM_MIRROR = 3; // staker / mirror

export interface EntityIdentity {
  voter: string; // lowercased identity address (canonical key)
  delegationAddress: string | null;
  submitAddress: string | null;
  submitSignaturesAddress: string | null;
  signingPolicyAddress: string | null;
  nodeIds: string[];
  feeBips: number | null;
  wNatWeight: string | null;
  wNatCappedWeight: string | null;
  signingWeight: string | null;
}

export interface EpochProviderMetric {
  voter: string;
  feeBips: number | null;
  wNatWeight: string | null;
  wNatCappedWeight: string | null;
  signingWeight: string | null;
  feedCount: number | null;
  epochThreshold: string | null;
  feeReward: string; // wei-scale decimal strings
  delegatorReward: string;
  stakerReward: string;
  registered: boolean;
  goodStanding: boolean | null;
  passes: number | null;
  failures: string[];
  ftsoHits: number | null;
  ftsoPossible: number | null;
  fdcRounds: number | null;
  fdcTotal: number | null;
  fastUpdates: number | null;
  fastExpected: number | null;
  ftsoMet: boolean | null;
  fdcMet: boolean | null;
  fastMet: boolean | null;
  stakingOk: boolean | null;
  strikes: number | null;
  passesHeld: number | null;
}

export interface ParsedEpoch {
  epochId: number;
  network: string;
  identities: EntityIdentity[]; // current identity per registered entity
  metrics: EpochProviderMetric[]; // per-entity metrics for this epoch
}

function lower(a: unknown): string | null {
  return typeof a === "string" && a ? a.toLowerCase() : null;
}

/**
 * Parse one epoch. `info` = reward-epoch-info.json, `dist` = reward-distribution-data.json.
 * `network` defaults to dist.network. Returns identities + per-entity metrics.
 */
export function parseEpoch(
  info: any,
  dist: any,
  network?: string,
  passes?: any,
  conds?: any
): ParsedEpoch {
  const epochId: number = info.rewardEpochId ?? dist.rewardEpochId;
  const net: string = network ?? dist.network ?? "flare";

  // signingPolicy.voters[i] are the entities' SIGNING-POLICY addresses (not identity voters),
  // and weights[i] is that entity's signing weight. Map by signingPolicyAddress, then resolve
  // to the identity voter via voterRegistrationInfo below.
  const signingPolicyAddrs: string[] = (info.signingPolicy?.voters ?? []).map((v: string) =>
    v.toLowerCase()
  );
  const signingWeights: (number | string)[] = info.signingPolicy?.weights ?? [];
  const signingWeightByPolicyAddr = new Map<string, string>();
  signingPolicyAddrs.forEach((a, i) => {
    const w = signingWeights[i];
    if (w !== undefined) signingWeightByPolicyAddr.set(a, String(w));
  });

  const feedCount: number | null = Array.isArray(info.canonicalFeedOrder)
    ? info.canonicalFeedOrder.length
    : null;
  const epochThreshold: string | null =
    info.signingPolicy?.threshold != null ? String(info.signingPolicy.threshold) : null;

  // Build identities from voterRegistrationInfo[].
  const identities: EntityIdentity[] = [];
  // address -> voter, to attribute reward claims (claims pay the delegation/voter address).
  const addrToVoter = new Map<string, string>();

  for (const entry of info.voterRegistrationInfo ?? []) {
    const reg = entry.voterRegistered ?? {};
    const vri = entry.voterRegistrationInfo ?? {};
    const voter = lower(reg.voter ?? vri.voter);
    if (!voter) continue;

    const identity: EntityIdentity = {
      voter,
      delegationAddress: lower(vri.delegationAddress),
      submitAddress: lower(reg.submitAddress),
      submitSignaturesAddress: lower(reg.submitSignaturesAddress),
      signingPolicyAddress: lower(reg.signingPolicyAddress),
      nodeIds: Array.isArray(vri.nodeIds)
        ? vri.nodeIds.map((n: string) => n.toLowerCase())
        : [],
      feeBips: typeof vri.delegationFeeBIPS === "number" ? vri.delegationFeeBIPS : null,
      wNatWeight: vri.wNatWeight != null ? String(vri.wNatWeight) : null,
      wNatCappedWeight: vri.wNatCappedWeight != null ? String(vri.wNatCappedWeight) : null,
      signingWeight:
        signingWeightByPolicyAddr.get(lower(reg.signingPolicyAddress) ?? "") ?? null,
    };
    identities.push(identity);

    // Map every address this entity controls back to its voter, for reward attribution.
    for (const a of [
      voter,
      identity.delegationAddress,
      identity.submitAddress,
      identity.submitSignaturesAddress,
      identity.signingPolicyAddress,
      ...identity.nodeIds,
    ]) {
      if (a) addrToVoter.set(a, voter);
    }
  }

  // Sum reward claims per voter by claimType.
  const fee = new Map<string, bigint>();
  const del = new Map<string, bigint>();
  const stake = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, k: string, v: string) =>
    m.set(k, (m.get(k) ?? 0n) + BigInt(v));

  for (const claim of dist.rewardClaims ?? []) {
    const body = claim.body ?? claim;
    const beneficiary = lower(body.beneficiary);
    if (!beneficiary) continue;
    const voter = addrToVoter.get(beneficiary);
    if (!voter) continue; // claim to an address we can't attribute to a known entity
    const amount = String(body.amount ?? "0");
    if (body.claimType === CLAIM_FEE) add(fee, voter, amount);
    else if (body.claimType === CLAIM_WNAT) add(del, voter, amount);
    else if (body.claimType === CLAIM_MIRROR) add(stake, voter, amount);
  }

  // voterAddress -> proportional minimal conditions. Kept identical to the .mjs parse, which is what
  // the cron actually runs.
  const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const cond = new Map<string, any>();
  for (const c of Array.isArray(conds) ? conds : []) {
    const v = typeof c?.voterAddress === "string" ? c.voterAddress.toLowerCase() : null;
    if (!v) continue;
    cond.set(v, {
      ftsoHits: num(c.ftsoScaling?.totalHits),
      ftsoPossible: num(c.ftsoScaling?.allPossibleHits),
      fdcRounds: num(c.fdc?.rewardedVotingRounds),
      fdcTotal: num(c.fdc?.totalRewardedVotingRounds),
      fastUpdates: num(c.fastUpdates?.updates),
      // expectedUpdates arrives as a decimal STRING, not a number.
      fastExpected: c.fastUpdates?.expectedUpdates != null ? Number(c.fastUpdates.expectedUpdates) : null,
      ftsoMet: typeof c.ftsoScaling?.conditionMet === "boolean" ? c.ftsoScaling.conditionMet : null,
      fdcMet: typeof c.fdc?.conditionMet === "boolean" ? c.fdc.conditionMet : null,
      fastMet: typeof c.fastUpdates?.conditionMet === "boolean" ? c.fastUpdates.conditionMet : null,
      stakingOk: typeof c.staking?.conditionMet === "boolean" ? c.staking.conditionMet : null,
      strikes: num(c.strikes),
      passesHeld: num(c.passesHeld),
    });
  }

  // voterAddress -> pass/eligibility verdict for this epoch.
  const pass = new Map<string, { eligible: boolean | null; passes: number | null; failures: string[] }>();
  for (const p of Array.isArray(passes) ? passes : []) {
    const v = typeof p?.voterAddress === "string" ? p.voterAddress.toLowerCase() : null;
    if (!v) continue;
    pass.set(v, {
      eligible: typeof p.eligibleForReward === "boolean" ? p.eligibleForReward : null,
      passes: typeof p.passes === "number" ? p.passes : null,
      failures: Array.isArray(p.failures)
        ? p.failures.map((f: any) => f?.failureId).filter(Boolean)
        : [],
    });
  }

  const metrics: EpochProviderMetric[] = identities.map((id) => ({
    voter: id.voter,
    feeBips: id.feeBips,
    wNatWeight: id.wNatWeight,
    wNatCappedWeight: id.wNatCappedWeight,
    signingWeight: id.signingWeight,
    feedCount,
    epochThreshold,
    feeReward: (fee.get(id.voter) ?? 0n).toString(),
    delegatorReward: (del.get(id.voter) ?? 0n).toString(),
    stakerReward: (stake.get(id.voter) ?? 0n).toString(),
    registered: true,
    // From passes.json, verbatim. Was hardcoded true, which reported every provider as in good
    // standing during epochs where Flare had burned all of their rewards.
    goodStanding: pass.get(id.voter)?.eligible ?? null,
    passes: pass.get(id.voter)?.passes ?? null,
    failures: pass.get(id.voter)?.failures ?? [],
    ftsoHits: cond.get(id.voter)?.ftsoHits ?? null,
    ftsoPossible: cond.get(id.voter)?.ftsoPossible ?? null,
    fdcRounds: cond.get(id.voter)?.fdcRounds ?? null,
    fdcTotal: cond.get(id.voter)?.fdcTotal ?? null,
    fastUpdates: cond.get(id.voter)?.fastUpdates ?? null,
    fastExpected: cond.get(id.voter)?.fastExpected ?? null,
    ftsoMet: cond.get(id.voter)?.ftsoMet ?? null,
    fdcMet: cond.get(id.voter)?.fdcMet ?? null,
    fastMet: cond.get(id.voter)?.fastMet ?? null,
    stakingOk: cond.get(id.voter)?.stakingOk ?? null,
    strikes: cond.get(id.voter)?.strikes ?? null,
    passesHeld: cond.get(id.voter)?.passesHeld ?? null,
  }));

  return { epochId, network: net, identities, metrics };
}
