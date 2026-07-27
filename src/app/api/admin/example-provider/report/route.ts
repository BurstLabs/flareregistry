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

  const tRaw = Number(new URL(req.url).searchParams.get("threshold") ?? "0.5");
  const threshold = Number.isFinite(tRaw) ? Math.min(1, Math.max(0, tRaw)) : 0.5;

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

  // Admin display-name overrides + verified-custom flags.
  const labels = await prisma.detectionLabel.findMany({ where: { address: { in: keys } } });
  const labelByAddr = new Map(labels.map((l) => [l.address.toLowerCase(), l.label]));
  const knownCustomAddr = new Set(labels.filter((l) => l.knownCustom).map((l) => l.address.toLowerCase()));

  // Match the tab's baseline calibration: rescale the combined probability so a verified-custom provider
  // reads ~0, i.e. p' = max(0, (p - baseline)/(1 - baseline)) with baseline = max known-custom raw prob.
  // Without this the report would filter on the un-rescaled value and disagree with what the tab shows.
  const knownRaw = rows.filter((r) => knownCustomAddr.has(r.voter.toLowerCase()));
  const baseline = knownRaw.length ? Math.max(...knownRaw.map((r) => r.combinedProbability)) : 0;
  const rescale = (p: number) =>
    baseline > 0 && baseline < 1 ? Math.max(0, (p - baseline) / (1 - baseline)) : p;

  // Assemble.
  const all = rows.map((r) => {
    const ev = roleToEntity.get(r.voter.toLowerCase());
    const listing = ev ? listingByVoter.get(ev) : undefined;
    const info = ev ? infoByVoter.get(ev) : undefined;
    return {
      name: labelByAddr.get(r.voter.toLowerCase()) ?? listing?.name ?? "(unlisted)",
      url: listing?.url ?? "",
      submitAddress: r.voter,
      identity: ev ?? "",
      knownCustom: knownCustomAddr.has(r.voter.toLowerCase()),
      combinedProbability: rescale(r.combinedProbability),
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
  // Probable users: above threshold AND not verified-custom (never accuse a provider we KNOW is custom).
  const probable = all.filter((x) => !x.knownCustom && x.combinedProbability >= threshold);

  const totalWeightAll = all.reduce((s, x) => s + x.weightTokens, 0);
  const totalWeightProbable = probable.reduce((s, x) => s + x.weightTokens, 0);
  const sharePct = totalWeightAll > 0 ? (totalWeightProbable / totalWeightAll) * 100 : 0;

  // Build CSV. Summary lines are prefixed with # so they don't interfere with the data table.
  // esc() also neutralizes CSV FORMULA INJECTION: provider name/url come from public submissions, and
  // the file is opened in spreadsheets, so a leading = + - @ tab or CR would execute as a formula.
  // Prefix any such value with a single quote, then quote-wrap if it contains , " or newline.
  const esc = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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
    "rank", "provider", "combined_probability", "value_similarity", "co_excursion_excess",
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
