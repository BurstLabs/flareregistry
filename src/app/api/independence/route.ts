import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/independence
//
// PUBLIC and UNAUTHENTICATED, unlike /api/detection, and the difference is deliberate.
//
// This endpoint serves the DIRECT measurement: how often pairs of providers submit byte-identical
// values. It reads reveals off the chain and counts. There is no reference instance, no calibration,
// no model, and no inference about which software anyone runs. That is what makes it publishable.
//
// /api/detection serves the example-provider CLASSIFICATION, which is inference carrying zero
// confirmed positives and known failure modes in both directions. It stays token-gated.
//
// NO PROVIDER NAMES OR PER-PROVIDER RATES ARE RETURNED HERE. flareregistry.com/detection states
// publicly that "no scores, no rankings and no provider names appear here or anywhere public", and an
// aggregate endpoint is what honours that. A provider can see their OWN row, but only after proving
// control of the address; that belongs behind the SIWE flow, not here.

/** Reporting threshold. Not a classification: it is the figure the governance proposal turns on. */
const THRESHOLD = 0.6;

export async function GET() {
  const network = "flare";

  // Latest snapshot per provider. Snapshots are append-only history, so take the newest run.
  const snaps = await prisma.correlationSnapshot.findMany({
    where: { network },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  if (snaps.length === 0) {
    return NextResponse.json({ error: "no measurement available yet" }, { status: 503 });
  }
  const latestRun = snaps[0].createdAt.getTime();
  // Everything written by the same run, allowing a small window for the batch insert to straddle a
  // second boundary. Mixing runs would blend different round windows into one distribution.
  const current = snaps.filter((s) => latestRun - s.createdAt.getTime() < 120_000);

  const maxRates = current.map((s) => s.maxRate).sort((a, b) => a - b);
  const q = (p: number) => maxRates[Math.min(maxRates.length - 1, Math.floor(p * maxRates.length))];

  // Weight the headline by actual protocol influence, not by provider count: thirty small providers
  // correlating matters less than three large ones, and registration weight is the unit that says so.
  const onchain = await prisma.providerOnchain.findMany({
    where: { network, NOT: { registrationWeight: null } },
    select: { voter: true, submitAddress: true, registrationWeight: true },
  });
  const weightBySubmit = new Map<string, number>();
  let totalWeight = 0;
  for (const e of onchain) {
    const w = Number(e.registrationWeight);
    totalWeight += w;
    for (const a of [e.submitAddress, e.voter]) {
      if (a) weightBySubmit.set(a.toLowerCase(), w);
    }
  }
  let correlatedWeight = 0;
  for (const s of current) {
    if (s.peersAbove > 0) correlatedWeight += weightBySubmit.get(s.voter.toLowerCase()) ?? 0;
  }

  const bands = [
    [0, 0.2], [0.2, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01],
  ] as const;

  return NextResponse.json({
    note:
      "Direct measurement of on-chain reveals: how often pairs of providers submit byte-identical " +
      "values. No inference about which software any provider runs, and no provider is named. " +
      "Reproducible from chain data alone.",
    network,
    measuredAt: snaps[0].createdAt.toISOString(),
    window: { fromRound: current[0].fromRound, toRound: current[0].toRound },
    threshold: THRESHOLD,
    providers: current.length,

    // The headline number: share of protocol voting power held by providers that submit
    // byte-identical values to at least one peer above the threshold.
    correlatedWeightPct: totalWeight > 0 ? (correlatedWeight / totalWeight) * 100 : null,
    correlatedProviders: current.filter((s) => s.peersAbove > 0).length,

    maxPeerAgreement: {
      median: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      max: maxRates[maxRates.length - 1],
    },
    distribution: bands.map(([lo, hi]) => ({
      from: lo,
      to: hi,
      providers: current.filter((s) => s.maxRate >= lo && s.maxRate < hi).length,
    })),
    method: "https://flareregistry.com/detection",
  });
}
