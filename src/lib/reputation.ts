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
export const REPUTATION_VERSION = "1.0";

export const WEIGHTS = {
  /** Did Flare consider you eligible for rewards? The protocol's own verdict on doing the job. */
  reliability: 45,
  /** Flare's primary and secondary success rates: how close your values were to consensus. */
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

export interface Reputation {
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

export async function reputationFor(network: string, voter: string): Promise<Reputation | null> {
  const entity = await prisma.providerOnchain.findFirst({
    where: { network, voter: voter.toLowerCase() },
    select: {
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
  const prim = bps(entity.successPrimary);
  const sec = bps(entity.successSecondary);
  const accParts = [prim, sec].filter((x): x is number => x != null);
  if (accParts.length) {
    const ratio = accParts.reduce((a, b) => a + b, 0) / accParts.length;
    components.push({
      key: "accuracy",
      raw: `${(ratio * 100).toFixed(2)}%`,
      ratio,
      weight: WEIGHTS.accuracy,
      points: ratio * WEIGHTS.accuracy,
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
