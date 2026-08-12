// PROVIDER REPUTATION: a published, reproducible composite over the things Flare itself measures.
//
// This site is run by Burst Labs, who also compete as a signal provider. A composite necessarily
// involves weights, and weights are judgements, so the only workable defence is to make every part of
// it checkable rather than to ask for trust:
//
//   1. Every input is Flare's own published measurement. Nothing here is our assessment of anyone.
//   2. The weights are constants in this file, printed on the page, and versioned.
//   3. Scoring is ABSOLUTE, never relative. A provider is measured against the protocol's scale, not
//      against other providers, so nobody's score moves because a competitor got better or worse.
//      That also keeps the page from behaving like a league table, which is how these things end up
//      concentrating delegation on whoever sits at the top.
//   4. Anyone can recompute it from public data: Flare's success rates and passes.json.
//
// DELIBERATELY EXCLUDED, and this matters as much as what is included:
//   - Delegation weight, stake, registration weight. They measure SIZE. Folding size into a quality
//     score tells delegators the biggest provider is the best one, which then makes it bigger. That is
//     a feedback loop, not a measurement.
//   - Fee. All 107 registered Flare entities sit at exactly the 2000 bips floor, so it carries no
//     information at all.
//   - Availability. Removed in 1.2 for exactly the same reason, having been included in error. Across
//     the healthy field it ranges 0.97 to 1.00 with a standard deviation of 0.005, and 84 of 109
//     entities sit at precisely 10000 bps. It was taking 15 of the weight and producing 1.3% of the
//     differentiation between providers. Worse, because effectively everyone scored full marks on it,
//     it dragged all 92 scored providers toward 100 in unison and was itself a major cause of the
//     compression at the top of the range. Dropping it widens the useful spread using information
//     that was already there, rather than by inventing any.
//   - Management Group vote participation. Only 45 entities are members, and scoring non-members on
//     participation in a body they do not belong to would be incoherent. Shown as context instead.
//
// LONGEVITY is included, but capped and weighted lightly on purpose. Surviving many epochs is real
// evidence: an operator who has been registered and paid for a year has not rugged, has handled at
// least one upgrade, and has not quietly vanished. But tenure is also the one input a new entrant
// cannot earn at any price, so an uncapped or heavily weighted longevity term simply entrenches
// incumbents and tells delegators that the oldest provider is the best one. It therefore saturates at
// LONGEVITY_FULL_EPOCHS, after which more age buys nothing.

import { eligibilityRecord, RECORD_WINDOW, type EligibilityRecord } from "@/lib/eligibility-record";
import { prisma } from "@/lib/db";

/** Bump when any weight or input changes, so a figure can always be traced to the rule that made it. */
export const REPUTATION_VERSION = "2.0";

export const WEIGHTS = {
  /** Did Flare consider you eligible for rewards? The protocol's own verdict on doing the job. */
  reliability: 45,
  /**
   * Flare's four minimal conditions, as PROPORTIONAL RATES rather than the binary outcome.
   *
   * Replaces the old accuracy component in 2.0. Accuracy was the mean of Flare's primary and secondary
   * reward-band rates, and the primary band is tight, so it paid for proximity to the consensus
   * median. A provider that misses the band but stays very close is doing better work than one that
   * tracks the median in order to hit it, and the old component could not tell those apart.
   *
   * The replacement is better on every axis that matters here. It comes from minimal-conditions.json,
   * a published file with 195 epochs of replayable history, rather than a live gauge with no epoch,
   * no historical endpoint and no way for a provider to check last month's figure. And it measures
   * whether the provider did the four jobs the protocol asks of it, not how closely it agreed with
   * everyone else.
   *
   * FDC is where the differentiation actually is: across epoch 420, 28 of 98 providers sat below 90%
   * on FDC against only 3 on FTSO scaling.
   */
  conditions: 25,
  /**
   * Flare's own strike count. Published per epoch and therefore verifiable, unlike anything that would
   * have to be scraped from a forum.
   */
  strikes: 5,
  /** Epochs seen registered, saturating at LONGEVITY_FULL_EPOCHS. */
  longevity: 10,
  /**
   * Implementation independence, mirrored from oracleindependence.com. The SMALLEST weight in the
   * model, deliberately: the source describes itself as a suspicion score holding zero confirmed
   * positives, and says its signal must never drive an automated determination. This is as close to
   * honouring that as including it at all allows.
   */
  independence: 5,
} as const;

/**
 * Class to ratio, ASYMMETRIC because the underlying signal is asymmetric.
 *
 * The screen is explicit that a low tick-grid lift is strong evidence of an independent
 * implementation, while a high one proves nothing, since any median-of-prints implementation reads
 * above the field whether or not it is the reference code. So an exclusion earns full credit, and a
 * candidate classification costs a little rather than everything. At weight 5, the entire distance
 * between the best and worst outcome here is under four points of the final score.
 *
 * A candidate that a THIRD PARTY independently flags scores lowest. Two methods sharing no signals is
 * the one case where the screen's own caveats say the evidence is worth more, and it is still only
 * worth those few points.
 */
export function independenceRatio(klass: string | null, externalP: number | null): number | null {
  if (!klass || klass === "pending") return null; // no verdict yet: omit rather than guess

  // The exclusions are the source's RELIABLE half, so they are not overridden by a third party. Three
  // of the 59 excluded entities are flagged by the external screen, and letting that pull down a
  // verified independent implementation would invert which half of the signal we said we trust.
  if (klass === "excluded") return 1;

  // Corroboration from an unaffiliated method applies to EVERY non-excluded class, not just to
  // candidates. That inconsistency was real: 6 of the 8 other-median entities are externally flagged
  // and the external reading was being ignored for all of them purely because of which branch they
  // landed in.
  const corroborated = externalP != null && externalP >= 0.5;
  if (klass === "other-median") return corroborated ? 0.5 : 0.75;
  if (klass === "candidate") return corroborated ? 0 : 0.25;
  return null;
}

/**
 * Half-life, in reward epochs, for the recency weighting on reward eligibility.
 *
 * A flat rate over 30 epochs says a provider who broke three months ago and one who is broken right
 * now are identical, which is plainly wrong: the first has a fixed problem and the second has a live
 * one. Weighting by recency lets the single figure carry the direction of travel.
 *
 * 10 epochs is about 35 days. The most recent epoch counts double one from 10 epochs back and roughly
 * seven times one from the far end of the window, so a run of recent misses moves the figure hard
 * while an old scar fades without ever quite disappearing.
 */
export const RELIABILITY_HALF_LIFE = 10;

/** Verdicts newest first. Returns null when there is nothing to weight. */
export function recencyWeighted(verdicts: boolean[]): number | null {
  if (!verdicts.length) return null;
  const decay = Math.pow(0.5, 1 / RELIABILITY_HALF_LIFE);
  let num = 0;
  let den = 0;
  verdicts.forEach((ok, i) => {
    const w = Math.pow(decay, i);
    den += w;
    if (ok) num += w;
  });
  return den ? num / den : null;
}

/**
 * Tenure at which longevity is worth full marks: 100 epochs, about a year at 3.5 days each.
 *
 * Capped so the term rewards having stayed rather than having started early. Without a cap, a provider
 * from epoch 228 would outrank an equally good one from epoch 320 forever, on nothing but a head start.
 */
export const LONGEVITY_FULL_EPOCHS = 100;

/**
 * Epochs an entity may be absent before it is treated as departed rather than as failing.
 *
 * 8 is about a month. Generous on purpose: Flare's 100 seats are full, so displacement is routine,
 * and a provider bumped for a couple of epochs is having a bad week, not gone.
 */
export const DEPARTED_AFTER_EPOCHS = 8;

/**
 * Accuracy carries LESS weight while we have little history of it, and earns its way up.
 *
 * Every other input is either a replayable file (passes.json, back to epoch 251) or a count we hold
 * ourselves. Success rates are neither: Flare's explorer serves them as a live gauge with no epoch
 * and no historical endpoint, so until ProviderSuccessSnapshot has depth, this component is a single
 * unaudited reading taken at whatever moment the cron last fired. Giving a spot value the same weight
 * as a 30-epoch record would be treating the weakest evidence as the strongest.
 *
 * So the weight is a DETERMINISTIC function of how many epochs of history we hold for that entity,
 * not a number anyone adjusts by hand. It starts at the floor and reaches the ceiling at
 * ACCURACY_FULL_EPOCHS. Because the total weight is normalised, the shortfall redistributes across
 * the other components automatically rather than deflating the score.
 *
 * The weight in force is printed next to the component, so a reader can always see how much of the
 * figure it is currently allowed to move.
 */
/** Strikes at which the strike component reaches zero. Flare's scale runs 0..3. */
export const STRIKES_FLOOR = 3;

export type Band = "strong" | "solid" | "mixed" | "attention";

/** A named sub-rate inside a component, so a provider can see WHICH part is failing. */
export interface ComponentDetail {
  key: string;
  ratio: number;
  /** Whether Flare judged the condition MET. Not implied by the ratio: see the note below. */
  met?: boolean | null;
}

export interface ReputationComponent {
  key: "reliability" | "conditions" | "strikes" | "longevity" | "independence";
  /**
   * The parts this component averages, where it averages anything.
   *
   * "Minimal conditions 86.88%" tells a provider their score is down and nothing about what to fix.
   * The four conditions move independently, and FDC is where the field actually separates, so the
   * breakdown is the difference between a number and an instruction.
   */
  detail?: ComponentDetail[];
  /** Human-readable raw value, e.g. "28 of 30 epochs" or "95.4%". */
  raw: string;
  /** 0..1 before weighting. */
  ratio: number;
  weight: number;
  points: number;
}

export interface Departed {
  departed: true;
  network: string;
  epochsAbsent: number;
  lastEpochSeen: number;
}

export interface Reputation {
  departed?: false;
  /**
   * The network this figure describes. NOT decoration.
   *
   * A listing resolves to whichever of its entities was most recently active, and the two can differ
   * enormously: Comfy Nodes scored 73.6 on Flare and 15 on Songbird, and the page silently showed the
   * Songbird figure because that entity was one epoch fresher. Without the network on the label a
   * reader reasonably assumes Flare, and concludes a working operation is failing.
   */
  network: string;
  score: number;
  band: Band;
  components: ReputationComponent[];
  version: string;
  /** False when there is too little history for the figure to mean anything. */
  mature: boolean;
  record: EligibilityRecord | null;
  /** Epochs we have seen this entity registered. Drives the longevity component. */
  epochsSeen: number;
  /** Context, shown but never scored. */
  context: {
    managementGroup: boolean;
    missedVotes: number | null;
    relevantProposals: number | null;
    validatorUptime: number | null;
    validatorCount: number;
  };
}

function band(score: number): Band {
  if (score >= 90) return "strong";
  if (score >= 75) return "solid";
  if (score >= 50) return "mixed";
  return "attention";
}

/** Basis points (0..10000) to a 0..1 ratio, clamped. */
const bps = (v: number | null | undefined): number | null =>
  v == null ? null : Math.max(0, Math.min(1, v / 10000));

export async function reputationFor(
  network: string,
  voter: string
): Promise<Reputation | Departed | null> {
  const entity = await prisma.providerOnchain.findFirst({
    where: { network, voter: voter.toLowerCase() },
    select: {
      lastEpochSeen: true,
      managementGroup: true,
      oiClass: true,
      oiExternalP: true,
      oiCheckedAt: true,
      mgMissedVotes: true,
      mgRelevantProposals: true,
      nodeIds: true,
    },
  });
  if (!entity) return null;

  // DEPARTED ENTITIES GET NO SCORE.
  //
  // A provider that stopped operating is never reward-eligible, has no recent success rate and looks
  // identical to one that is present and failing. Scoring it produces a confident, precise, wrong
  // statement: an entity last seen at epoch 231 rendered as 2.6 out of 100, which reads as "operating
  // very badly" rather than "gone since last year".
  //
  // The threshold is deliberately generous. Publication lag and a missed cron can put a live provider
  // an epoch or two behind, and briefly losing a seat is routine now that Flare's 100 are full, so
  // this only fires on an absence no working provider would have.
  const st = await prisma.ingestState.findUnique({ where: { network } });
  const latest = st?.lastEpochIngested ?? null;
  const epochsAbsent = latest != null ? latest - entity.lastEpochSeen : 0;
  if (latest != null && epochsAbsent > DEPARTED_AFTER_EPOCHS) {
    return { departed: true, network, epochsAbsent, lastEpochSeen: entity.lastEpochSeen };
  }

  const record = await eligibilityRecord(network, voter);

  const components: ReputationComponent[] = [];

  // Reliability. Absent history is not a pass, so a provider with no verdicts scores nothing here and
  // is marked immature rather than being handed the benefit of the doubt.
  const reliabilityRatio = record ? recencyWeighted(record.verdicts) : null;
  if (reliabilityRatio != null && record) {
    // Show the plain count, because that is what actually happened and it is checkable. Add the
    // weighted figure only when the two differ enough to matter, so the points can be reconciled with
    // what is on screen instead of looking like arithmetic that does not add up.
    const flat = record.eligible / record.scored;
    const raw =
      Math.abs(flat - reliabilityRatio) >= 0.01
        ? `${record.eligible}/${record.scored} (${(reliabilityRatio * 100).toFixed(0)}% weighted)`
        : `${record.eligible}/${record.scored}`;
    components.push({
      key: "reliability",
      raw,
      ratio: reliabilityRatio,
      weight: WEIGHTS.reliability,
      points: reliabilityRatio * WEIGHTS.reliability,
    });
  }

  // CONDITIONS: the four minimal conditions as rates, averaged across the window.
  //
  // Each epoch contributes the mean of whichever of the four it has, so a provider is not punished for
  // a condition Flare did not publish that epoch. Fast updates is capped at 1: it is measured against
  // an expected count and routinely exceeds it (one provider ran 122% of expected), and letting
  // overshoot bank credit would pay for spamming rather than for doing the job.
  const condRows = await prisma.providerMetricEpoch.findMany({
    where: { network, voter: voter.toLowerCase() },
    orderBy: { epochId: "desc" },
    take: RECORD_WINDOW,
    select: {
      ftsoHits: true, ftsoPossible: true, fdcRounds: true, fdcTotal: true,
      fastUpdates: true, fastExpected: true, stakingOk: true, strikes: true,
      ftsoMet: true, fdcMet: true, fastMet: true,
    },
  });
  const ratio = (n: number | null, d: number | null) =>
    n != null && d != null && d > 0 ? Math.min(1, n / d) : null;

  const perEpochCond = condRows
    .map((r) =>
      [
        ratio(r.ftsoHits, r.ftsoPossible),
        ratio(r.fdcRounds, r.fdcTotal),
        // conditionMet, NOT the rate. Fast updates is measured against an expected count that low-
        // weight entities are exempted from, so the rate and the verdict are not monotonic: a provider
        // failed this at 98.7% of expected in epoch 420. Scoring the rate would credit a provider
        // Flare had just failed.
        r.fastMet == null ? null : r.fastMet ? 1 : 0,
        r.stakingOk == null ? null : r.stakingOk ? 1 : 0,
      ].filter((x): x is number => x != null)
    )
    .filter((parts) => parts.length)
    .map((parts) => parts.reduce((a, b) => a + b, 0) / parts.length);

  if (perEpochCond.length) {
    const r = perEpochCond.reduce((a, b) => a + b, 0) / perEpochCond.length;
    // Each condition averaged separately across the window, so the sub-rates add up to the story the
    // headline percentage tells.
    const mean = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const detail = (
      [
        ["ftso", condRows.map((x) => ratio(x.ftsoHits, x.ftsoPossible))],
        ["fdc", condRows.map((x) => ratio(x.fdcRounds, x.fdcTotal))],
        ["fast", condRows.map((x) => (x.fastMet == null ? null : x.fastMet ? 1 : 0))],
        ["staking", condRows.map((x) => (x.stakingOk == null ? null : x.stakingOk ? 1 : 0))],
      ] as const
    )
      .map(([key, xs]) => ({ key: key as string, ratio: mean(xs) }))
      .filter((d): d is ComponentDetail => d.ratio != null);

    // Attach the LATEST pass/fail verdict per condition. The rate says how comfortably; this says
    // which side of the line. FDC's threshold sits near 60%, so a rate on its own never tells a
    // provider whether they passed.
    const latest = condRows[0];
    if (latest) {
      const metBy: Record<string, boolean | null | undefined> = {
        ftso: latest.ftsoMet, fdc: latest.fdcMet, fast: latest.fastMet, staking: latest.stakingOk,
      };
      for (const dd of detail) dd.met = metBy[dd.key] ?? null;
    }

    components.push({
      key: "conditions",
      raw: `${(r * 100).toFixed(2)}%`,
      ratio: r,
      weight: WEIGHTS.conditions,
      points: r * WEIGHTS.conditions,
      detail,
    });
  }

  // STRIKES: the worst count seen in the window, not the latest.
  //
  // Strikes are consumed as they are worked off, so reading only the newest epoch would erase a
  // provider's recent trouble the moment it recovered one. The window already expires them.
  const strikeVals = condRows.map((r) => r.strikes).filter((x): x is number => x != null);
  if (strikeVals.length) {
    const worst = Math.max(...strikeVals);
    const r = 1 - Math.min(1, worst / STRIKES_FLOOR);
    components.push({
      key: "strikes",
      raw: String(worst),
      ratio: r,
      weight: WEIGHTS.strikes,
      points: r * WEIGHTS.strikes,
    });
  }

  // Longevity: epochs we have actually SEEN this entity registered, not last-minus-first, so a gap
  // where they were deregistered does not silently count as tenure.
  const epochsSeen = await prisma.providerMetricEpoch.count({
    where: { network, voter: voter.toLowerCase() },
  });
  if (epochsSeen > 0) {
    const ratio = Math.min(1, epochsSeen / LONGEVITY_FULL_EPOCHS);
    components.push({
      key: "longevity",
      raw: `${epochsSeen}`,
      ratio,
      weight: WEIGHTS.longevity,
      points: ratio * WEIGHTS.longevity,
    });
  }

  const indep = independenceRatio(entity.oiClass, entity.oiExternalP);
  if (indep != null) {
    components.push({
      key: "independence",
      raw: entity.oiClass ?? "",
      ratio: indep,
      weight: WEIGHTS.independence,
      points: indep * WEIGHTS.independence,
    });
  }

  // Normalise over the components we actually have, so a missing input neither silently zeroes a
  // provider nor quietly inflates them. The page states which components were available.
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const score = totalWeight ? (components.reduce((a, c) => a + c.points, 0) / totalWeight) * 100 : 0;

  const validators = (entity.nodeIds as string[] | null) ?? [];
  let validatorUptime: number | null = null;
  if (validators.length) {
    const rows = await prisma.providerValidator.findMany({
      where: { network, nodeId: { in: validators } },
      select: { uptimePercent: true },
    });
    const ups = rows.map((r) => r.uptimePercent).filter((x): x is number => x != null);
    if (ups.length) validatorUptime = ups.reduce((a, b) => a + b, 0) / ups.length;
  }

  return {
    network,
    score,
    band: band(score),
    components,
    version: REPUTATION_VERSION,
    // The eligibility record carries the maturity gate, and it gates the whole figure: without enough
    // epochs the largest single component is guesswork, so publishing a score would be false precision.
    mature: !!record?.mature,
    record,
    epochsSeen,
    context: {
      managementGroup: entity.managementGroup,
      missedVotes: entity.mgMissedVotes,
      relevantProposals: entity.mgRelevantProposals,
      validatorUptime,
      validatorCount: validators.length,
    },
  };
}
