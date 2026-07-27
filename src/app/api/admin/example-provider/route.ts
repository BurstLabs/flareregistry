import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/example-provider
// The example-provider similarity report (Flare only): each registered provider's rolling similarity to
// our reference example-provider instances, its calibrated probability, and its accuracy (deviation from
// the field consensus). Admin-only; this is a suspicion score, NOT proof - see the pipeline docs.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const rows = await prisma.providerSimilarity.findMany({
    orderBy: { refSimilarityMean: "desc" },
  });

  // Resolve voter (on-chain identity) -> our provider name/address for display. A voter is an entity's
  // identity address; match it to a ProviderOnchain, then to a listed ProviderAddress -> Provider.
  const voters = rows.map((r) => r.voter.toLowerCase());
  const entities = await prisma.providerOnchain.findMany({
    where: { voter: { in: voters } },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  // Map any of an entity's role addresses -> its voter, so we can find the listing by whichever address
  // the provider registered.
  const roleToVoter = new Map<string, string>();
  for (const e of entities) {
    for (const a of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]) {
      if (a) roleToVoter.set(a.toLowerCase(), e.voter.toLowerCase());
    }
  }
  const addrs = [...roleToVoter.keys()];
  const listings = await prisma.providerAddress.findMany({
    where: { address: { in: addrs } },
    select: { address: true, provider: { select: { name: true, url: true, source: true } } },
  });
  const nameByVoter = new Map<string, { name: string; url: string; source: string }>();
  for (const l of listings) {
    const v = roleToVoter.get(l.address.toLowerCase());
    if (v && !nameByVoter.has(v)) nameByVoter.set(v, l.provider);
  }

  const report = rows.map((r) => {
    const p = nameByVoter.get(r.voter.toLowerCase());
    return {
      voter: r.voter,
      name: p?.name ?? null,
      url: p?.url ?? null,
      source: p?.source ?? null,
      similarity: r.refSimilarityMean,
      variance: r.refSimilarityVar,
      accuracy: r.fieldDeviationMean, // deviation from field consensus (lower = more accurate)
      probability: r.probability,
      confidence: r.confidence,
      rounds: r.roundsObserved,
    };
  });

  const maxRounds = rows.reduce((m, r) => Math.max(m, r.roundsObserved), 0);
  return NextResponse.json({ report, maxRounds });
}
