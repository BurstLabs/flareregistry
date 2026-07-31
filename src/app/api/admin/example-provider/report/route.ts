import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { computeFingerprints, latticeStats, type RefProfiles } from "@/lib/detection";

export const dynamic = "force-dynamic";

// GET /api/admin/example-provider/report?minLift=1.6
// Downloadable CSV report of candidate example-provider users, selected on TICK-GRID LIFT, ranked, with
// on-chain weight and the rest of the detection data, plus a summary header. Admin-only.
//
// Selection used to be `combinedProbability >= threshold`, i.e. the fingerprint-derived probability.
// That was removed: it is reference-anchored, its anchor drifts, and 6 of its top 20 were providers the
// tick-grid screen formally excludes, so the download named providers the rest of the tool cleared. The
// probability and fingerprint are still EXPORTED as columns for the record; they just no longer decide
// who appears.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  // Accept the legacy ?threshold= too, reinterpreted as a lift, so an old bookmark cannot silently
  // select on a scale that no longer exists.
  const sp = new URL(req.url).searchParams;
  const raw = Number(sp.get("minLift") ?? sp.get("threshold") ?? "1.6");
  const minLift = Number.isFinite(raw) ? Math.min(10, Math.max(0, raw)) : 1.6;

  const rows = await prisma.providerSimilarity.findMany({ where: { network: "flare" } });

  // Compute P exactly the way the Detection tab does. This used to export the STORED
  // `combinedProbability`, which is the legacy value-similarity number the scorer writes; after P was
  // rebased onto the error-profile fingerprint the CSV silently disagreed with the screen it was
  // downloaded from. Same function, same inputs, same answer.
  const cursorRow = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  const allRefProfiles = (cursorRow?.refFeedErrorsJson ?? {}) as RefProfiles;
  const { corrByVoter, variantByVoter, fpProbability, anchorMean, fieldMean } = computeFingerprints(
    rows,
    allRefProfiles
  );

  // Resolve voter (submit addr) -> provider name + on-chain weight, via the 5-role-address join.
  const keys = rows.map((r) => r.voter.toLowerCase());
  const entities = await prisma.providerOnchain.findMany({
    // NETWORK-SCOPED. Without this the OR-over-five-role-addresses pulls Songbird rows too: operators
    // reuse the same role addresses across networks, so roleToEntity collided and last-write-wins handed
    // the Flare tab a SONGBIRD identity and Songbird weight. Measured: Catenalytica read 239,529,194
    // (its Songbird figure) instead of 889,905,496. Same bug class as the Ugly Kitty feed mismatch.
    where: {
      network: "flare",
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

  // NO baseline rescaling here either - it was a MAX over a small noisy set used as a DIVISOR, so a
  // single lucky round for one verified-custom provider could empty this report entirely. The
  // known-custom level is reported in the CSV header as context instead.

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
      combinedProbability: fpProbability(corrByVoter.get(r.voter.toLowerCase())),
      fingerprint: corrByVoter.get(r.voter.toLowerCase()) ?? null,
      lattice: latticeStats(r),
      bestVariant: variantByVoter.get(r.voter.toLowerCase()) ?? r.bestVariant ?? "",
      accuracyDev: r.fieldDeviationMean,
      weightTokens: weiToTokens(info?.weiWeight ?? null),
      feePercent: info?.feeBips != null ? info.feeBips / 100 : null,
      managementGroup: info?.mg ?? false,
      confidence: r.confidence,
      rounds: r.roundsObserved,
    };
  });
  // Candidates: tick-grid lift at or above the cut, NOT formally excluded by the screen, and not
  // verified-custom (never name a provider we KNOW is custom). A null lift means "no measurement yet",
  // which must never silently qualify someone for a report that names them.
  const probable = all
    .filter(
      (x) =>
        !x.knownCustom &&
        !x.lattice.ruledOut &&
        x.lattice.lift != null &&
        x.lattice.lift >= minLift
    )
    .sort((a, b) => (b.lattice.lift ?? 0) - (a.lattice.lift ?? 0));
  const knownCustomLevel = all.filter((x) => x.knownCustom).reduce<number | null>(
    (m, x) => (x.combinedProbability != null && (m == null || x.combinedProbability > m) ? x.combinedProbability : m),
    null
  );

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
  lines.push(`# Flare Registry - example-provider CANDIDATES report (Flare)`);
  lines.push(`# Selected on TICK-GRID LIFT >= ${minLift.toFixed(2)}x, excluding providers the screen ruled out`);
  lines.push(`# Scale: field = 1.00x by construction | our own example-provider instances = 1.44x-2.33x`);
  lines.push(`#        verified-custom control = 0.52x | exclusion applies when the upper bound < 1.30x`);
  lines.push(`# Providers scored: ${all.length}`);
  lines.push(`# Candidates (>= ${minLift.toFixed(2)}x): ${probable.length}`);
  lines.push(`# Total network weight (scored): ${Math.round(totalWeightAll).toLocaleString("en-US")}`);
  lines.push(`# Weight held by candidates: ${Math.round(totalWeightProbable).toLocaleString("en-US")} (${sharePct.toFixed(2)}% of scored)`);
  lines.push(`# combined_probability / fingerprint are RETAINED FOR THE RECORD ONLY and are NOT used to`);
  lines.push(`#   select this list: both are reference-anchored, their anchor drifts, and 6 of their top`);
  lines.push(`#   20 were providers the tick-grid screen formally excludes.`);
  lines.push(`#   (fingerprint calibration at export: field=${Number.isFinite(fieldMean) ? fieldMean.toFixed(4) : "n/a"} anchor=${Number.isFinite(anchorMean) ? anchorMean.toFixed(4) : "n/a"}; highest P among verified-custom=${knownCustomLevel != null ? knownCustomLevel.toFixed(4) : "n/a"})`);
  lines.push(`# NOTE: a high lift is NOT proof - any median-of-prints implementation reads above the`);
  lines.push(`#   field, including our own verified-custom control. Human review only; never automated.`);
  lines.push("");
  const cols = [
    "rank", "provider", "combined_probability", "fingerprint", "tick_grid_lift", "tick_grid_lift_upper",
    "tick_grid_z", "tick_grid_trials", "tick_grid_ruled_out", "best_variant", "accuracy_dev",
    "weight_tokens", "weight_share_pct", "fee_percent", "management_group", "confidence", "rounds",
    "submit_address", "identity_address", "url",
  ];
  lines.push(cols.join(","));
  probable.forEach((x, i) => {
    lines.push([
      i + 1,
      esc(x.name),
      x.combinedProbability != null ? x.combinedProbability.toFixed(4) : "",
      x.fingerprint != null ? x.fingerprint.toFixed(4) : "",
      x.lattice.lift != null ? x.lattice.lift.toFixed(3) : "",
      x.lattice.liftUpper != null ? x.lattice.liftUpper.toFixed(3) : "",
      x.lattice.z != null ? x.lattice.z.toFixed(1) : "",
      x.lattice.trials,
      x.lattice.ruledOut ? "yes" : "no",
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
