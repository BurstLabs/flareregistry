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
export const REPUTATION_VERSION = "2.8";

/**
 * Points deducted from the final score for a chill still in force, decaying to nothing as the
 * provider serves out the recovery period.
 *
 * A DEDUCTION AND NOT A COMPONENT, deliberately. Adding a sixth weighted component would give every
 * provider who has never been chilled another ratio of exactly 1.000, and the top of this scale is
 * already carrying 60 of its 90 weight units at exactly 1.000 explaining 0.0% of the variance. A
 * component that 99% of the field maxes out adds nothing but compression. A deduction leaves every
 * unchilled provider's score untouched and moves only the providers the finding is about.
 *
 * 20 points is a judgement, and the only one in this file that is not read off a measurement. It is
 * chosen to be roughly one band wide: large enough that a chill visibly changes what the page says
 * about a provider, small enough that it does not permanently brand someone governance has already
 * released.
 */
export const CHILL_PENALTY_MAX = 20;

/**
 * Epochs after a chill's term ends before the deduction reaches zero. 100 epochs is about a year,
 * matching LONGEVITY_FULL_EPOCHS rather than inventing a second horizon.
 *
 * The clock starts when the term Flare set ENDS, not when the chill was applied. Governance decides
 * how long someone is barred; this decides how long the fact stays visible in the number afterwards,
 * and starting it any earlier would let a long chill expire faster than a short one.
 */
export const CHILL_RECOVERY_EPOCHS = 100;

/** 0 while a chill is in force, rising to 1 over CHILL_RECOVERY_EPOCHS after its term ends. */
export function chillRecovery(untilEpoch: number, currentEpoch: number): number {
  if (currentEpoch < untilEpoch) return 0;
  return Math.min(1, (currentEpoch - untilEpoch) / CHILL_RECOVERY_EPOCHS);
}

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
 * candidate classification costs a little rather than everything. At weight 5 of 90, the entire
 * distance between the best and worst outcome here is about five and a half points of the final
 * score. (It read "under four points" until 2.1, left over from a version whose weights summed to a
 * larger total.)
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

/**
 * Recency-weighted mean of values given NEWEST FIRST. Null when there is nothing to weight.
 *
 * The single decay in this file. Reward eligibility, minimal conditions and strikes all run on it,
 * so the components can no longer disagree about what "recent" means, which they did until 2.2.
 *
 * The index is the value's position in the array it was given, and callers pass already-filtered
 * arrays. That is deliberate: age is measured in epochs the provider actually published, never in
 * calendar epochs, so an entity that stops reporting freezes its own history rather than ageing out
 * of it. See weightedWorstStrike for why that distinction is load-bearing.
 */
export function recencyWeightedMean(values: number[]): number | null {
  if (!values.length) return null;
  const decay = Math.pow(0.5, 1 / RELIABILITY_HALF_LIFE);
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    const w = Math.pow(decay, i);
    den += w;
    num += v * w;
  });
  return den ? num / den : null;
}

/** Verdicts newest first. Returns null when there is nothing to weight. */
export function recencyWeighted(verdicts: boolean[]): number | null {
  return recencyWeightedMean(verdicts.map((ok) => (ok ? 1 : 0)));
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
 * Strikes at which the strike component reaches zero.
 *
 * FLARE'S SCALE IS 0..4, NOT 0..3. A strike is one failed minimal condition in that epoch, and FIP.12
 * added FDC as a fourth protocol, so four can fail at once: 25 provider-epochs on Flare record a 4.
 * The comment here claimed 0..3 and was simply wrong.
 *
 * The floor stays at 3 anyway, because 3 is where the protocol's own protection is exhausted: a
 * provider holds at most 3 passes, so a 3-strike epoch already burns the rewards of anyone at full
 * protection. What the floor does hide is that a 4 is worse than a 3, since min(1, worst/3) clamps
 * both to zero. That is a real limitation of this component, recorded rather than papered over.
 */
export const STRIKES_FLOOR = 3;

/**
 * The heaviest strike in the window after an age discount, plus the raw figure Flare recorded.
 *
 * DECAY IS BY ROW INDEX, NOT BY EPOCH DISTANCE, and the difference is the whole security of this
 * component. Ageing by epoch distance would let a provider discount a strike by going quiet: two
 * rows, the bad one and a single clean one k epochs later, would buy exactly what k consecutive
 * clean epochs buy. Since an operating provider carries roughly an 11.7% chance of a new strike per
 * epoch and a deregistered one carries none, deregistering would strictly beat operating on this
 * component. Indexing into the provider's own newest-first rows means silence stalls recovery
 * instead of granting it: only epochs they actually turned up for move the figure.
 *
 * It is the same clock `recencyWeighted` uses for reward eligibility, so the two components no
 * longer disagree about what "recent" means.
 *
 * Returns the recorded worst as well as the decayed value, because the two can point at different
 * epochs and the page must not report the second under the name of the first.
 */
export function weightedWorstStrike(
  strikes: number[]
): { worst: number; ageRows: number; weighted: number } | null {
  if (!strikes.length) return null;
  const decay = Math.pow(0.5, 1 / RELIABILITY_HALF_LIFE);
  let worst = 0;
  let ageRows = 0;
  let weighted = 0;
  strikes.forEach((s, i) => {
    if (s > worst) {
      worst = s;
      ageRows = i;
    }
    // d^0 = 1, so a strike in the newest row is never discounted and a live failure is never
    // absolved by a clean history.
    const w = s * Math.pow(decay, i);
    if (w > weighted) weighted = w;
  });
  return { worst, ageRows, weighted };
}

export type Band = "clean" | "strong" | "solid" | "mixed" | "attention";

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
   * Strikes only. `worst` is the figure Flare actually recorded and `weighted` is the aged value the
   * score uses; they can come from different epochs, so both are carried rather than letting the
   * page print one under the other's name.
   */
  strike?: { worst: number; ageRows: number; weighted: number };
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
  /**
   * Governance chills against any of this entity's addresses, newest first. Always present when one
   * exists, whether or not it still affects the score.
   */
  chills: {
    /** Which chain the chill was issued on. Both count; the page says which. */
    network: string;
    untilEpoch: number;
    appliedAt: string;
    txHash: string;
    active: boolean;
    inWindow: boolean;
    penalty: number;
  }[];
  baseScore: number;
  chillPenalty: number;
  /** Context, shown but never scored. */
  context: {
    managementGroup: boolean;
    missedVotes: number | null;
    relevantProposals: number | null;
    validatorUptime: number | null;
    validatorCount: number;
  };
}

/**
 * Band floors, exported so /reputation prints the same numbers the scorer applies.
 *
 * The published methodology page reads every constant from this file rather than restating it. A
 * methodology that has drifted from the code is worse than none, because it invites a provider to
 * recompute their figure, get a different answer, and conclude the score is arbitrary.
 */
export const BAND_FLOORS: ReadonlyArray<readonly [Band, number]> = [
  ["strong", 95],
  // 85, not 75, from 2.4. At 75 this band held 42 of 95 providers spanning 76.1 to 94.7 and was the
  // largest in the model, which is the same failure the old 90 floor had at the other end: one band
  // carrying most of the field says little about anyone in it. Raising the floor moves 10 providers
  // between 76.1 and 84.2 into Mixed.
  ["solid", 85],
  // 80, not 50, from 2.5. The bottom of the scale is deliberately demanding: below 80 is called out
  // rather than described as merely uneven. Mixed now spans a narrow 80 to 85.
  ["mixed", 80],
  ["attention", 0],
] as const;

/**
 * THE STRONG FLOOR MOVED FROM 90 TO 95 IN 2.3, on measurement rather than taste.
 *
 * Over epochs 402-422, 21 of 94 providers crossed 90 at least once, 31 times, 7 of them oscillating,
 * and 70% of everyone within two points of it crossed: it sat on the steepest slope in the
 * distribution. 95 crossed 7, oscillated 2, and sits in a density trough holding 4.3 to 5.9 providers
 * within a point of it at every sampled epoch. 75 and 50 are unchanged: 75 is the cleanest line in
 * the file (8 crossers, zero oscillators) and 50 sits inside the largest gap in the whole
 * distribution, 20.9 points wide.
 */

/**
 * CLEAN is a CONJUNCTIVE CAP, not a fifth score cut, and the distinction is the whole justification
 * for the band existing.
 *
 * There is no room at the top of this scale for another threshold. The 44 providers above 97.5 are at
 * ratio exactly 1.000 on reliability, longevity AND independence, every one of them: 60 of the 90
 * weight is constant there and explains 0.0% of the variance. What is left is 2.4 points wide, its
 * largest internal gap is 0.545, its median internal gap is 0.0089, and the median provider inside it
 * moves 0.008 per epoch. Gaps and jitter are the same size, and no gap that exists inside the cluster
 * has an inversion rate under about 7.5%. Any line drawn in there would report a rank the data does
 * not contain, and 57% of what it would be reading is the strikes decay ramp, whose value changes
 * every epoch with no change in anyone's conduct.
 *
 * So the extra distinction is not a narrower slice of the same number. It is a separate, binary,
 * checkable FACT: Flare recorded no failed minimal condition and no ineligible epoch in any of the
 * last RECORD_WINDOW epochs. A strike is exactly the count of the four conditions that failed that
 * epoch, so a zero-strike window means all four jobs done, every epoch, for a month and a half. It
 * changes only when a real event happens, never because a third significant figure drifted.
 *
 * INDEPENDENCE AND LONGEVITY ARE DELIBERATELY EXCLUDED from the cap. Independence is a third-party
 * suspicion screen whose own source says it must never drive an automated determination, and gating a
 * band on it would hand it exactly that. Longevity is the one input a new entrant cannot earn at any
 * price, and gating the top band on tenure would entrench incumbents, which is the reason that
 * component is capped and weighted lightly in the first place.
 *
 * NOT A RANK ABOVE STRONG. The two bands overlap in score, 96.49 to 99.99 against 96.74 to 99.48.
 * Clean says something strong does not say; it does not say it louder.
 */
export const CLEAN_FLOOR = 95;

/**
 * Tolerance for "this component is at full marks".
 *
 * Both ratios are exactly 1 in IEEE terms when the record is unblemished, so this only guards against
 * a future refactor introducing a rounding path. The margin is enormous either way: the highest
 * non-perfect values in the field are 0.9487 on strikes and 0.9821 on reliability, because the
 * smallest possible blemish is a single strike at the far end of the window, worth 0.5^3 / 3.
 */
const FULL_MARKS = 1 - 1e-9;

function band(score: number, components: ReputationComponent[], chillPenalty: number): Band {
  const ratioOf = (k: ReputationComponent["key"]) =>
    components.find((c) => c.key === k)?.ratio ?? null;
  const strikes = ratioOf("strikes");
  const reliability = ratioOf("reliability");
  // A missing component is not a pass: no record means no clean record.
  // A GOVERNANCE CHILL DISQUALIFIES THE CLEAN BAND for exactly as long as it is still costing
  // points. Clean record is a factual claim that Flare recorded nothing against this provider, and a
  // chill is the most serious thing Flare can record, so carrying the label while still serving one
  // would make the label false.
  //
  // GATED ON THE DEDUCTION, not on the 30-epoch window. Tying it to the window would have given the
  // same fact two different horizons: a chill would have stopped blocking the band after 30 epochs
  // while still costing points for another 70, so a provider could hold "Clean record" and a visible
  // chill deduction at the same time. One fact, one clock.
  //
  // A fully served chill is still published, permanently, as a statement of record.
  if (
    score >= CLEAN_FLOOR &&
    strikes != null &&
    strikes >= FULL_MARKS &&
    reliability != null &&
    reliability >= FULL_MARKS &&
    chillPenalty === 0
  ) {
    return "clean";
  }
  for (const [name, floor] of BAND_FLOORS) if (score >= floor) return name;
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
      // All five role addresses: the December 2025 action chilled TWO addresses per entity, so
      // matching chills on the identity alone would have found one of them and missed the other.
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
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
    // RECENCY WEIGHTED from 2.2, on the same half-life as reward eligibility and strikes.
    //
    // This was a flat mean over 30 epochs, which is the treatment RELIABILITY_HALF_LIFE exists to
    // argue against, applied to a component worth five times what strikes is worth. It said a
    // provider whose FDC broke three months ago and one whose FDC is broken right now are the same
    // provider, and it dropped an epoch off a cliff at the window edge for up to 0.93 published
    // points with no change in anyone's behaviour.
    //
    // Nothing about a rate made it exempt. It was simply never revisited when reliability was
    // weighted, and the tooltip stated the flatness as a plain fact because no reason existed.
    const r = recencyWeightedMean(perEpochCond)!;
    // Each condition weighted separately across the window, so the sub-rates add up to the story the
    // headline percentage tells. Nulls are dropped BEFORE weighting, so an epoch where Flare did not
    // publish a condition does not silently age the ones around it.
    const mean = (xs: (number | null)[]) =>
      recencyWeightedMean(xs.filter((x): x is number => x != null));
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

  // STRIKES: the heaviest strike in the window after an age discount.
  //
  // WHAT A STRIKE IS, measured rather than assumed. Across epochs 393-422, 2,942 provider-epochs,
  // `strikes` is exactly the number of the four minimal conditions that failed IN THAT EPOCH, with
  // zero mismatches. It is a per-epoch severity count, not a running tally: nothing accumulates and
  // Flare expires nothing, so the previous comment here ("the window already expires them") was
  // wrong on both counts.
  //
  // That is why a flat max() over 30 epochs was the wrong estimator. It is a worst-single-day
  // statistic that throws away the other 29 epochs, and it left providers scoring zero on the
  // strength of one bad epoch nearly three months gone: one had been clean for 28 consecutive
  // epochs and was back at Flare's full three passes. The old note claimed the window expired
  // strikes, but a fixed window does not decay anything, it just drops it off a cliff.
  //
  // NOT SWITCHED TO `passes`, though that is Flare's own counter with memory (0..3, +1 per clean
  // epoch, minus the strike count on a bad one) and we already ingest it. It is not a drop-in: a
  // pass is withheld whenever staking obstructs it even at zero strikes, on 314 rows in this
  // window, so reading it directly would penalise clean providers for a condition this component
  // does not claim to measure. Worth revisiting deliberately rather than as part of this fix.
  //
  // A 4 IS POSSIBLE and is not equivalent to a 3. FIP.12 added FDC as a fourth protocol, so four
  // conditions can fail at once; 25 Flare provider-epochs record a 4. Both clamp to zero while
  // fresh, but once discounted a 4 stays worse than a 3 for the rest of the window, which is the
  // behaviour the old hard clamp erased.
  const strikeVals = condRows.map((r) => r.strikes).filter((x): x is number => x != null);
  const ws = weightedWorstStrike(strikeVals);
  if (ws) {
    const r = 1 - Math.min(1, ws.weighted / STRIKES_FLOOR);
    components.push({
      key: "strikes",
      // The page builds its own label from `strike`; this stays as the plain recorded figure so any
      // API consumer reading `raw` still gets Flare's number rather than our discounted one.
      raw: String(ws.worst),
      strike: ws,
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

  // GOVERNANCE CHILLS. Flare's most serious sanction and, unlike everything else here, an explicit
  // finding by governance rather than a measurement.
  //
  // MATCHED ACROSS BOTH CHAINS AND EVERY ROLE ADDRESS, which needs both halves to work.
  //
  // Every role, because the December 2025 action chilled three beneficiary types for each entity
  // (identity, delegation address and node id) in a single transaction, so matching on the identity
  // alone would have found one of three.
  //
  // Both chains, because a chill is a verdict about an OPERATOR, not about performance on a
  // particular network. Songbird runs the same written policy: STP.03 is the twin of FIP.02, same
  // two-epoch first chill, same permanent ban on a second, and 30 chills have been issued there. The
  // same team runs both networks, often on byte-identical keys: sToadz's submit, submitSignatures
  // and signingPolicy addresses are the same on Flare and Songbird. Counting only the Flare verdict
  // would let an operator banned outright from Songbird carry a clean Flare score.
  //
  // The performance components stay Flare-only. This is deliberately narrow: what crosses the chain
  // boundary is governance's verdict on the operator, never a measurement of how they performed
  // somewhere else.
  //
  // Sibling entities are resolved through the registry LISTING, because an operator's Flare and
  // Songbird identities are different addresses. Without that hop a Songbird-only chill would be
  // invisible from the Flare entity. An unlisted entity falls back to its own addresses, which is
  // the best that can be done for one we cannot link.
  const ownAddresses = [
    entity.voter,
    entity.delegationAddress,
    entity.submitAddress,
    entity.submitSignaturesAddress,
    entity.signingPolicyAddress,
  ]
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase());

  const listing = await prisma.providerAddress.findFirst({
    where: { address: { in: ownAddresses } },
    select: { provider: { select: { addresses: { select: { address: true } } } } },
  });
  const chillAddresses = new Set(ownAddresses);
  if (listing) {
    const listed = listing.provider.addresses.map((a) => a.address.toLowerCase());
    const siblings = await prisma.providerOnchain.findMany({
      where: {
        OR: [
          { voter: { in: listed } },
          { delegationAddress: { in: listed } },
          { submitAddress: { in: listed } },
          { submitSignaturesAddress: { in: listed } },
          { signingPolicyAddress: { in: listed } },
        ],
      },
      select: {
        voter: true,
        delegationAddress: true,
        submitAddress: true,
        submitSignaturesAddress: true,
        signingPolicyAddress: true,
      },
    });
    for (const a of listed) chillAddresses.add(a);
    for (const sib of siblings) {
      for (const a of [
        sib.voter,
        sib.delegationAddress,
        sib.submitAddress,
        sib.submitSignaturesAddress,
        sib.signingPolicyAddress,
      ]) {
        if (a) chillAddresses.add(a.toLowerCase());
      }
    }
  }

  const chillRows = await prisma.providerChill.findMany({
    // No network filter: see above.
    where: { beneficiary: { in: [...chillAddresses] } },
    orderBy: { blockNumber: "desc" },
  });
  // EACH CHILL IS MEASURED AGAINST ITS OWN CHAIN'S CLOCK.
  //
  // Flare and Songbird number their reward epochs independently, and the counts are nowhere near
  // each other: Flare is past 420 while the Songbird chills on record run to the low 200s. Judging a
  // Songbird chill's term against the Flare epoch head would mark a live ban as long served, which
  // is the one error that would make counting Songbird worse than ignoring it.
  const sgbState = await prisma.ingestState.findUnique({ where: { network: "songbird" } });
  const headFor = (n: string) => (n === "songbird" ? sgbState?.lastEpochIngested ?? null : latest);

  // A chill is dated by the epoch it runs UNTIL, so "in window" means its term overlapped any epoch
  // the score is currently looking at.
  // `latest` is null only before the first ingest has run. Treat that as "cannot tell", which means
  // no chill is scored, rather than silently deciding every chill is out of window.
  const windowStart = latest != null ? latest - RECORD_WINDOW + 1 : null;
  // ONE ROW PER GOVERNANCE ACTION, not per address. The December 2025 action chilled two addresses
  // for each entity in a single transaction, so an entity matching on both rendered the identical
  // sentence twice. Keyed on the transaction because that is what a single governance decision is.
  const seenTx = new Set<string>();
  const chills = chillRows
    .filter((c) => (seenTx.has(c.txHash) ? false : (seenTx.add(c.txHash), true)))
    .map((c) => ({
      network: c.network,
      untilEpoch: c.untilEpoch,
      appliedAt: c.appliedAt.toISOString(),
      txHash: c.txHash,
      active: headFor(c.network) != null && c.untilEpoch > headFor(c.network)!,
      inWindow:
        c.network === network && windowStart != null && c.untilEpoch >= windowStart,
      // Points still being deducted for this chill, 0 once fully served.
      penalty:
        headFor(c.network) == null
          ? 0
          : CHILL_PENALTY_MAX * (1 - chillRecovery(c.untilEpoch, headFor(c.network)!)),
    }));

  // Only the HEAVIEST outstanding chill is deducted, not the sum. Two chills are not twice as
  // disqualifying as one, and the December action alone would otherwise have counted six times over
  // for an entity matching every address in it.
  const chillPenalty = chills.reduce((a, c) => Math.max(a, c.penalty), 0);

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
  const base = totalWeight ? (components.reduce((a, c) => a + c.points, 0) / totalWeight) * 100 : 0;
  // Floored at 0 so a deduction can never produce a negative published figure.
  const score = Math.max(0, base - chillPenalty);

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
    band: band(score, components, chillPenalty),
    components,
    version: REPUTATION_VERSION,
    // The eligibility record carries the maturity gate, and it gates the whole figure: without enough
    // epochs the largest single component is guesswork, so publishing a score would be false precision.
    mature: !!record?.mature,
    record,
    epochsSeen,
    chills,
    /** The score before the chill deduction, so the page can show the subtraction rather than assert it. */
    baseScore: base,
    chillPenalty,
    context: {
      managementGroup: entity.managementGroup,
      missedVotes: entity.mgMissedVotes,
      relevantProposals: entity.mgRelevantProposals,
      validatorUptime,
      validatorCount: validators.length,
    },
  };
}
