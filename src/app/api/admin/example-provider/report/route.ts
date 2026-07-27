import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/example-provider/report?threshold=0.5
// Downloadable CSV report of PROBABLE example-provider users (combined probability >= threshold),
// ranked, with on-chain weight and all pertinent detection data, plus a summary header. Admin-only.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const threshold = Math.min(1, Math.max(0, Number(new URL(req.url).searchParams.get("threshold") ?? "0.5")));

  const rows = await prisma.providerSimilarity.findMany({
    orderBy: { combinedProbability: "desc" },
  });

  // Resolve voter (submit addr) -> provider name + on-chain weight, via the 5-role-address join.
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
      voter: true, delegationAddress: true, submitAddress: true,
      submitSignaturesAddress: true, signingPolicyAddress: true,
      wNatWeight: true, feeBips: true, managementGroup: true,
    },
  });
  const roleToEntity = new Map<string, string>();
  const infoByVoter = new Map<string, { weiWeight: string | null; feeBips: number | null; mg: boolean }>();
  for (const e of entities) {
    for (const a of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]) {
      if (a) roleToEntity.set(a.toLowerCase(), e.voter.toLowerCase());
    }
    infoByVoter.set(e.voter.toLowerCase(), { weiWeight: e.wNatWeight, feeBips: e.feeBips, mg: e.managementGroup });
  }
  const addrs = [...roleToEntity.keys()];
  const listings = await prisma.providerAddress.findMany({
    where: { address: { in: addrs } },
    select: { address: true, provider: { select: { name: true, url: true, source: true } } },
  });
  const listingByVoter = new Map<string, { name: string; url: string; source: string }>();
  for (const l of listings) {
    const v = roleToEntity.get(l.address.toLowerCase());
    if (v && !listingByVoter.has(v)) listingByVoter.set(v, l.provider);
  }

  const weiToTokens = (s: string | null) => (s ? Number(BigInt(s) / 10n ** 15n) / 1000 : 0);

  // Admin display-name overrides.
  const labels = await prisma.detectionLabel.findMany({ where: { address: { in: keys } } });
  const labelByAddr = new Map(labels.map((l) => [l.address.toLowerCase(), l.label]));

  // Assemble + filter to probable users.
  const all = rows.map((r) => {
    const ev = roleToEntity.get(r.voter.toLowerCase());
    const listing = ev ? listingByVoter.get(ev) : undefined;
    const info = ev ? infoByVoter.get(ev) : undefined;
    return {
      name: labelByAddr.get(r.voter.toLowerCase()) ?? listing?.name ?? "(unlisted)",
      url: listing?.url ?? "",
      submitAddress: r.voter,
      identity: ev ?? "",
      combinedProbability: r.combinedProbability,
      valueSimilarity: r.refSimilarityMean,
      coExcursionRate: r.coExcursionRate,
      coExcursionN: r.coExcursionN,
      bestVariant: r.bestVariant ?? "",
      accuracyDev: r.fieldDeviationMean,
      weightTokens: weiToTokens(info?.weiWeight ?? null),
      feePercent: info?.feeBips != null ? info.feeBips / 100 : null,
      managementGroup: info?.mg ?? false,
      confidence: r.confidence,
      rounds: r.roundsObserved,
    };
  });
  const probable = all.filter((x) => x.combinedProbability >= threshold);

  const totalWeightAll = all.reduce((s, x) => s + x.weightTokens, 0);
  const totalWeightProbable = probable.reduce((s, x) => s + x.weightTokens, 0);
  const sharePct = totalWeightAll > 0 ? (totalWeightProbable / totalWeightAll) * 100 : 0;

  // Build CSV. Summary lines are prefixed with # so they don't interfere with the data table.
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push(`# Flare Registry - Probable example-provider users report`);
  lines.push(`# Network: Flare`);
  lines.push(`# Probability threshold: ${threshold}`);
  lines.push(`# Providers scored: ${all.length}`);
  lines.push(`# Probable users (>= threshold): ${probable.length}`);
  lines.push(`# Total network weight (scored): ${Math.round(totalWeightAll).toLocaleString("en-US")}`);
  lines.push(`# Weight held by probable users: ${Math.round(totalWeightProbable).toLocaleString("en-US")} (${sharePct.toFixed(2)}% of scored)`);
  lines.push(`# NOTE: suspicion score, not proof. For human review only; not for automated action.`);
  lines.push("");
  const cols = [
    "rank", "provider", "combined_probability", "value_similarity", "co_excursion_rate",
    "co_excursion_n", "best_variant", "accuracy_dev", "weight_tokens", "weight_share_pct",
    "fee_percent", "management_group", "confidence", "rounds", "submit_address", "identity_address", "url",
  ];
  lines.push(cols.join(","));
  probable.forEach((x, i) => {
    lines.push([
      i + 1,
      esc(x.name),
      x.combinedProbability.toFixed(4),
      x.valueSimilarity.toFixed(4),
      x.coExcursionRate.toFixed(4),
      x.coExcursionN,
      x.bestVariant,
      x.accuracyDev.toFixed(4),
      Math.round(x.weightTokens),
      totalWeightAll > 0 ? ((x.weightTokens / totalWeightAll) * 100).toFixed(3) : "0",
      x.feePercent != null ? x.feePercent.toFixed(2) : "",
      x.managementGroup ? "yes" : "no",
      x.confidence.toFixed(3),
      x.rounds,
      x.submitAddress,
      x.identity,
      esc(x.url),
    ].join(","));
  });

  const csv = lines.join("\n");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="example-provider-report-${stamp}.csv"`,
    },
  });
}
