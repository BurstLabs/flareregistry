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
  /** Verdicts NEWEST FIRST, so a caller can weight by recency. Only epochs carrying a verdict. */
  verdicts: boolean[];
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
  // THE WINDOW IS 30 EPOCHS, NOT 30 ROWS, and that distinction is the whole point of this block.
  //
  // Taking the newest 30 ROWS silently slides the window back to wherever the provider last turned
  // up. A provider who deregisters writes no rows at all, so their absence was not scored as a
  // failure; it simply did not appear, and every component averaged over the epochs they DID work.
  // Measured on Swyke: eight epochs absent, newest row at 416 against a network head of 424, scored
  // 50.6 out of a window that ended a month earlier and read as current.
  //
  // Flare pays nothing for an epoch you are not registered for, so an absence is a miss, not a
  // neutral gap. Anchoring the window to the network head makes it count as one.
  const st = await prisma.ingestState.findUnique({ where: { network } });
  const head = st?.lastEpochIngested ?? null;

  const rows = await prisma.providerMetricEpoch.findMany({
    where: {
      network,
      voter: voter.toLowerCase(),
      ...(head != null ? { epochId: { gte: head - RECORD_WINDOW + 1, lte: head } } : {}),
    },
    orderBy: { epochId: "desc" },
    take: RECORD_WINDOW,
    select: { epochId: true, goodStanding: true, failures: true },
  });
  if (!rows.length) return null;

  // ABSENCE COUNTS ONLY FROM THE PROVIDER'S OWN FIRST EPOCH ONWARD.
  //
  // Two different things look identical in this table: a provider who stopped, and one who had not
  // started. Epochs before an entity's first appearance are not failures, they are epochs in which
  // it did not exist, and treating them as misses would score every new entrant near zero on arrival
  // and hand incumbents a permanent structural advantage. The maturity gate below already refuses to
  // publish a figure for thin history; this keeps that promise honest rather than undercutting it.
  const firstEver = await prisma.providerMetricEpoch.findFirst({
    where: { network, voter: voter.toLowerCase() },
    orderBy: { epochId: "asc" },
    select: { epochId: true },
  });

  // Rebuild the series epoch by epoch, newest first, inserting a miss for every epoch in the window
  // that the provider should have been present for and has no row for.
  type Slot = { epochId: number; goodStanding: boolean | null; failures: string[] | null };
  let series: Slot[] = rows as Slot[];
  if (head != null && firstEver) {
    const byEpoch = new Map(rows.map((r) => [r.epochId, r as Slot]));
    const from = Math.max(head - RECORD_WINDOW + 1, firstEver.epochId);
    series = [];
    for (let e = head; e >= from; e--) {
      series.push(byEpoch.get(e) ?? { epochId: e, goodStanding: false, failures: ["NOT_REGISTERED"] });
    }
  }

  // Only slots carrying a verdict count. goodStanding is nullable precisely so that "Flare has not
  // published this epoch yet" is distinguishable from "the provider passed", and averaging the two
  // together would quietly reward absence. A synthesised absence above is a definite false, not a
  // null, because we know the provider was not there rather than not knowing.
  const scoredRows = series.filter((r) => r.goodStanding !== null);
  const recentRows = series.slice(0, RECORD_RECENT).filter((r) => r.goodStanding !== null);

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
    // The newest epoch with a REAL row. Deliberately not series[0], which may be a synthesised
    // absence: this field is what the page uses to say how current a verdict is, and answering it
    // with an epoch we made up would defeat the purpose.
    latestEpoch: rows[0]?.epochId ?? null,
    causes,
    verdicts: scoredRows.map((r) => r.goodStanding === true),
  };
}
