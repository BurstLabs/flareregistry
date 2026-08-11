// REWARD-ELIGIBILITY RECORD: how often Flare found this provider eligible for rewards.
//
// Deliberately NOT a reputation score, and the distinction is the whole design.
//
// A composite score would require weighting incommensurate things (success rate versus uptime versus
// governance participation), and every weight is a value judgement. Burst Labs runs this registry AND
// competes as a signal provider, so any weight we chose would be our opinion about how our competitors
// should be graded. There is no disclaimer that fixes that, and no hosting arrangement that fixes it
// either. The only real remedy is to remove discretion from the calculation entirely.
//
// So this counts someone else's verdicts. `goodStanding` is Flare's own `eligibleForReward` from
// passes.json, a per-epoch boolean the protocol publishes. We add no weights, no normalisation and no
// opinion. Any provider can recompute the identical figure from the same public files, and nothing
// they could do to game it would be distinguishable from actually doing the job.
//
// WHY A RATE AND NOT A CURRENT STATE. Eligibility is volatile: across epochs 416-422 the number of
// ineligible providers ranged from 2 to 12 out of ~100. A single epoch is noise, and publishing it
// would brand someone for one bad week. Measured over 30 epochs the picture is stable, and the
// distribution is informative in the right way: 67 of 96 providers sit at a perfect 100%, so the
// figure separates almost nobody at the top and identifies the 29 with a real pattern. A metric that
// refuses to invent differences among the top two thirds is doing its job, not failing at it.

import { prisma } from "@/lib/db";

/** Reward epochs in the long window. 30 epochs is about 105 days at 3.5 days each. */
export const RECORD_WINDOW = 30;
/** The short window, so a provider who has just fixed something can show it rather than wait months. */
export const RECORD_RECENT = 10;
/**
 * Epochs of history required before a figure is shown at all.
 *
 * A new provider reading "eligible in 3 of 3" next to an established one reading "30 of 30" would be
 * making a far weaker claim in identical type. Below this we say so instead of implying precision we
 * do not have. Same reasoning as the detection table's maturity gate.
 */
export const RECORD_MIN_EPOCHS = 20;

export interface EligibilityRecord {
  /** Epochs in the window that carry a verdict at all. Null verdicts are absences, not passes. */
  scored: number;
  eligible: number;
  window: number;
  recentScored: number;
  recentEligible: number;
  mature: boolean;
  /** Newest epoch with a verdict, so the reader can see how current this is. */
  latestEpoch: number | null;
  /** Distinct failure causes Flare attributed in the window, e.g. ["FDC_FAILURE"]. */
  causes: string[];
}

/**
 * The record for one entity on one network.
 *
 * Scoped by voter+network rather than by listing, because eligibility is a property of the on-chain
 * entity. A provider running on both chains has two records, and merging them would average away the
 * chain where the problem actually is.
 */
export async function eligibilityRecord(
  network: string,
  voter: string
): Promise<EligibilityRecord | null> {
  const rows = await prisma.providerMetricEpoch.findMany({
    where: { network, voter: voter.toLowerCase() },
    orderBy: { epochId: "desc" },
    take: RECORD_WINDOW,
    select: { epochId: true, goodStanding: true, failures: true },
  });
  if (!rows.length) return null;

  // Only rows carrying a verdict count. goodStanding is nullable precisely so that "Flare has not
  // published this epoch yet" is distinguishable from "the provider passed", and averaging the two
  // together would quietly reward absence.
  const scoredRows = rows.filter((r) => r.goodStanding !== null);
  const recentRows = rows.slice(0, RECORD_RECENT).filter((r) => r.goodStanding !== null);

  const causes = [
    ...new Set(scoredRows.filter((r) => r.goodStanding === false).flatMap((r) => r.failures ?? [])),
  ];

  return {
    scored: scoredRows.length,
    eligible: scoredRows.filter((r) => r.goodStanding === true).length,
    window: RECORD_WINDOW,
    recentScored: recentRows.length,
    recentEligible: recentRows.filter((r) => r.goodStanding === true).length,
    mature: scoredRows.length >= RECORD_MIN_EPOCHS,
    latestEpoch: rows[0]?.epochId ?? null,
    causes,
  };
}
