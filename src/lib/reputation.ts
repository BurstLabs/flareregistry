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
//   - Management Group vote participation. Only 45 entities are members, and scoring non-members on
//     participation in a body they do not belong to would be incoherent. Shown as context instead.
//
// LONGEVITY is included, but capped and weighted lightly on purpose. Surviving many epochs is real
// evidence: an operator who has been registered and paid for a year has not rugged, has handled at
// least one upgrade, and has not quietly vanished. But tenure is also the one input a new entrant
// cannot earn at any price, so an uncapped or heavily weighted longevity term simply entrenches
// incumbents and tells delegators that the oldest provider is the best one. It therefore saturates at
// LONGEVITY_FULL_EPOCHS, after which more age buys nothing.

import { eligibilityRecord, type EligibilityRecord } from "@/lib/eligibility-record";
import { prisma } from "@/lib/db";

/** Bump when any weight or input changes, so a figure can always be traced to the rule that made it. */
export const REPUTATION_VERSION = "1.1";

export const WEIGHTS = {
  /** Did Flare consider you eligible for rewards? The protocol's own verdict on doing the job. */
  reliability: 45,
  /**
   * Flare's primary and secondary success rates. NOT a fixed weight: see accuracyWeight().
   * This is the ceiling, reached once there is enough snapshot history to average over.
   */
  accuracy: 30,
  /** Flare's availability rate: were you there at all. */
  availability: 15,
  /** Epochs seen registered, saturating at LONGEVITY_FULL_EPOCHS. */
  longevity: 10,
} as const;

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
export const ACCURACY_WEIGHT_FLOOR = 10;
export const ACCURACY_FULL_EPOCHS = 20;

export function accuracyWeight(snapshotEpochs: number): number {
  const span = WEIGHTS.accuracy - ACCURACY_WEIGHT_FLOOR;
  return ACCURACY_WEIGHT_FLOOR + span * Math.min(1, snapshotEpochs / ACCURACY_FULL_EPOCHS);
}

export type Band = "strong" | "solid" | "mixed" | "attention";

export interface ReputationComponent {
  key: "reliability" | "accuracy" | "availability" | "longevity";
  /** Human-readable raw value, e.g. "28 of 30 epochs" or "95.4%". */
  raw: string;
  /** 0..1 before weighting. */
  ratio: number;
  weight: number;
  points: number;
}

export interface Departed {
  departed: true;
  epochsAbsent: number;
  lastEpochSeen: number;
}

export interface Reputation {
  departed?: false;
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
      successPrimary: true,
      successSecondary: true,
      successAvailability: true,
      managementGroup: true,
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
    return { departed: true, epochsAbsent, lastEpochSeen: entity.lastEpochSeen };
  }

  const record = await eligibilityRecord(network, voter);

  const components: ReputationComponent[] = [];

  // Reliability. Absent history is not a pass, so a provider with no verdicts scores nothing here and
  // is marked immature rather than being handed the benefit of the doubt.
  const reliabilityRatio = record && record.scored > 0 ? record.eligible / record.scored : null;
  if (reliabilityRatio != null && record) {
    components.push({
      key: "reliability",
      raw: `${record.eligible}/${record.scored}`,
      ratio: reliabilityRatio,
      weight: WEIGHTS.reliability,
      points: reliabilityRatio * WEIGHTS.reliability,
    });
  }

  // Accuracy: the mean of Flare's primary and secondary rates. Both are published for every registered
  // entity, and they measure different bands of the same thing, so averaging them is not mixing units.
  //
  // Averaged ACROSS EPOCHS once we hold history, and only falling back to the live snapshot value
  // while we do not. A spot reading of a volatile gauge is a worse measurement than a mean over
  // twenty of them, so the component upgrades itself the moment it can, rather than needing anyone to
  // decide it is now trustworthy.
  const snapshots = await prisma.providerSuccessSnapshot.findMany({
    where: { network, voter: voter.toLowerCase() },
    orderBy: { epochId: "desc" },
    take: ACCURACY_FULL_EPOCHS,
    select: { primary: true, secondary: true },
  });
  const perEpoch = snapshots
    .map((r) => [bps(r.primary), bps(r.secondary)].filter((x): x is number => x != null))
    .filter((parts) => parts.length)
    .map((parts) => parts.reduce((a, b) => a + b, 0) / parts.length);

  const spotParts = [bps(entity.successPrimary), bps(entity.successSecondary)].filter(
    (x): x is number => x != null
  );
  const ratio = perEpoch.length
    ? perEpoch.reduce((a, b) => a + b, 0) / perEpoch.length
    : spotParts.length
      ? spotParts.reduce((a, b) => a + b, 0) / spotParts.length
      : null;

  if (ratio != null) {
    const weight = accuracyWeight(perEpoch.length);
    components.push({
      key: "accuracy",
      raw: `${(ratio * 100).toFixed(2)}%`,
      ratio,
      weight,
      points: ratio * weight,
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

  const avail = bps(entity.successAvailability);
  if (avail != null) {
    components.push({
      key: "availability",
      raw: `${(avail * 100).toFixed(2)}%`,
      ratio: avail,
      weight: WEIGHTS.availability,
      points: avail * WEIGHTS.availability,
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
