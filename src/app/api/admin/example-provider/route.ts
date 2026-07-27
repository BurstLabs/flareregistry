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

  // Resolve the similarity row's address -> our provider name for display. IMPORTANT: the address we
  // stored is the reveal tx sender = the entity's SUBMIT address, not its identity/voter. So match it
  // against ANY of the 5 role addresses of a ProviderOnchain entity, then map that entity's roles to the
  // listing. `key` here is the similarity row's stored address (submit address).
  const keys = rows.map((r) => r.voter.toLowerCase());
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: { in: keys } },
        { submitAddress: { in: keys } },
        { delegationAddress: { in: keys } },
        { submitSignaturesAddress: { in: keys } },
        { signingPolicyAddress: { in: keys } },
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
  // Map: each role address of an entity -> a stable entity key (its voter). Then map the SIMILARITY row's
  // stored address to that entity key, so we can look up the listing.
  const roleToEntity = new Map<string, string>();
  for (const e of entities) {
    const roles = [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress];
    for (const a of roles) if (a) roleToEntity.set(a.toLowerCase(), e.voter.toLowerCase());
  }
  // roleToVoter here maps a similarity key (submit addr) -> the entity voter, AND every role addr -> voter
  // (so the listing lookup by any registered address works).
  const roleToVoter = roleToEntity;
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
    const entityVoter = roleToEntity.get(r.voter.toLowerCase());
    const p = entityVoter ? nameByVoter.get(entityVoter) : undefined;
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
      variant: r.bestVariant, // which exchange-subset variant (full|top5|top10) fits best
    };
  });

  const maxRounds = rows.reduce((m, r) => Math.max(m, r.roundsObserved), 0);
  return NextResponse.json({ report, maxRounds });
}
