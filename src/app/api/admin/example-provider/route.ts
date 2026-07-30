import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/example-provider
// The example-provider similarity report (Flare only): each registered provider's rolling similarity to
// our reference example-provider instances, its calibrated probability, and its accuracy (deviation from
// the field consensus). Admin-only; this is a suspicion score, NOT proof - see the pipeline docs.
// Median of a numeric array.
function med(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Pearson correlation.
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 8) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sx = 0, sy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    sx += a * a; sy += b * b; sxy += a * b;
  }
  return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : NaN;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const rows = await prisma.providerSimilarity.findMany({
    orderBy: { refSimilarityMean: "desc" },
  });

  // ERROR-PROFILE CORRELATION - the implementation fingerprint. Each provider (and our reference) carries
  // an EW per-feed vector of ln|deviation from consensus|. Correlating those raw vectors is dominated by
  // FEED DIFFICULTY (illiquid feeds are hard for everyone), which put a verified-custom provider at rank 7.
  // So we subtract each feed's difficulty baseline (the median across providers) first; what remains is
  // implementation-specific structure. Measured effect: verified-custom controls fall to rank 37 and 55 of
  // 95, and a tight top cluster separates at 0.93-0.95 with a clear gap below.
  const cursorRow = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  // refFeedErrorsJson is keyed by instance id: { "full:1": {feed: lnDev}, "top3:1": {...}, ... }
  const allRefProfiles = (cursorRow?.refFeedErrorsJson ?? {}) as Record<string, Record<string, number>>;
  const refInstanceIds = Object.keys(allRefProfiles);
  const yardstickId = refInstanceIds.find((k) => k.startsWith("full")) ?? refInstanceIds[0];
  const refProfile = yardstickId ? allRefProfiles[yardstickId] : null;
  const profiles = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const p = r.feedErrorsJson as Record<string, number> | null;
    if (p && typeof p === "object") profiles.set(r.voter.toLowerCase(), p);
  }
  // Feed difficulty baseline: median across providers of each feed's accumulated log-deviation.
  const difficulty = new Map<string, number>();
  if (refProfile) {
    const feedNames = new Set<string>(Object.keys(refProfile));
    for (const p of profiles.values()) for (const k of Object.keys(p)) feedNames.add(k);
    for (const f of feedNames) {
      const vals: number[] = [];
      for (const p of profiles.values()) if (Number.isFinite(p[f])) vals.push(p[f]);
      if (vals.length >= 20) difficulty.set(f, med(vals));
    }
  }
  // Correlate any profile against the yardstick, both de-meaned by feed difficulty.
  const corrTo = (p: Record<string, number>, ref: Record<string, number>): number => {
    const xs: number[] = [], ys: number[] = [];
    for (const [f, d] of difficulty) {
      const pv = p[f], rv = ref[f];
      if (!Number.isFinite(pv) || !Number.isFinite(rv)) continue;
      xs.push(pv - d);
      ys.push(rv - d);
    }
    return pearson(xs, ys);
  };
  const corrByVoter = new Map<string, number>();
  // POSITIVE CLASS for the fingerprint: our OTHER-CONFIG reference instances scored against the
  // yardstick. Each is a genuine example provider whose exchange config differs from it - the realistic,
  // attainable bar. Same-config instances are excluded: they are byte-identical twins and would put the
  // bar at 1.0, which is what made the old similarity metric flag nobody.
  const anchorFps: number[] = [];
  if (refProfile && difficulty.size >= 15) {
    const yardVariant = (yardstickId ?? "").split(":")[0];
    for (const inst of refInstanceIds) {
      if (inst.split(":")[0] === yardVariant) continue;
      const c = corrTo(allRefProfiles[inst], refProfile);
      if (Number.isFinite(c)) anchorFps.push(c);
    }
    for (const [voter, p] of profiles) {
      const c = corrTo(p, refProfile);
      if (Number.isFinite(c)) corrByVoter.set(voter, c);
    }
  }
  // Which reference CONFIG a provider's error profile matches best - a far more meaningful "Variant" than
  // the old one, which was picked by the broken value-similarity metric.
  const variantByVoter = new Map<string, string>();
  if (refProfile && difficulty.size >= 15) {
    for (const [voter, p] of profiles) {
      let best: { v: string; c: number } | null = null;
      for (const inst of refInstanceIds) {
        const c = corrTo(allRefProfiles[inst], p);
        if (!Number.isFinite(c)) continue;
        const v = inst.split(":")[0];
        if (!best || c > best.c) best = { v, c };
      }
      if (best) variantByVoter.set(voter, best.v);
    }
  }
  // Calibrate fingerprint -> probability with the same monotonic logistic used before, but between the
  // FIELD's fingerprint level and the cross-config ANCHOR level. Monotonic in the fingerprint by
  // construction, so a higher fingerprint always means a higher probability.
  const fieldFps = [...corrByVoter.values()];
  const anchorMean = anchorFps.length ? anchorFps.reduce((a, b) => a + b, 0) / anchorFps.length : NaN;
  const fieldMean = fieldFps.length ? med(fieldFps) : NaN;
  const fpGap = anchorMean - fieldMean;
  const fpProbability = (fp: number | null): number => {
    if (fp == null || !Number.isFinite(fp)) return 0;
    if (!Number.isFinite(fpGap) || !(fpGap > 1e-6) || anchorFps.length < 2) return 0;
    const mid = (anchorMean + fieldMean) / 2;
    const k = 6 / fpGap;
    return 1 / (1 + Math.exp(-k * (fp - mid)));
  };

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
      wNatWeight: true,
    },
  });
  // Map: each role address of an entity -> a stable entity key (its voter). Then map the SIMILARITY row's
  // stored address to that entity key, so we can look up the listing.
  const roleToEntity = new Map<string, string>();
  // Entity voter -> its on-chain wNat weight (wei-scale decimal string), for the weight column.
  const weightByVoter = new Map<string, string | null>();
  for (const e of entities) {
    const roles = [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress];
    for (const a of roles) if (a) roleToEntity.set(a.toLowerCase(), e.voter.toLowerCase());
    weightByVoter.set(e.voter.toLowerCase(), e.wNatWeight);
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

  // Admin display-name overrides + verified-custom flags.
  const labels = await prisma.detectionLabel.findMany({ where: { address: { in: keys } } });
  const labelByAddr = new Map(labels.map((l) => [l.address.toLowerCase(), l.label]));
  const knownCustomAddr = new Set(labels.filter((l) => l.knownCustom).map((l) => l.address.toLowerCase()));

  const report = rows.map((r) => {
    const entityVoter = roleToEntity.get(r.voter.toLowerCase());
    const p = entityVoter ? nameByVoter.get(entityVoter) : undefined;
    const override = labelByAddr.get(r.voter.toLowerCase());
    const knownCustom = knownCustomAddr.has(r.voter.toLowerCase());
    // On-chain wNat weight in whole tokens (wei-scale string / 1e18). Number is fine for display scale.
    const weiStr = entityVoter ? weightByVoter.get(entityVoter) : null;
    const weight = weiStr ? Number(BigInt(weiStr) / 10n ** 15n) / 1000 : null;
    return {
      voter: r.voter,
      name: override ?? p?.name ?? null,
      url: p?.url ?? null,
      source: p?.source ?? null,
      weight, // on-chain vote power (wNat weight), whole tokens
      similarity: r.refSimilarityMean,
      variance: r.refSimilarityVar,
      accuracy: r.fieldDeviationMean, // deviation from field consensus (lower = more accurate)
      probability: r.probability,
      // P is now the FINGERPRINT-based probability, confidence-gated by observed rounds.
      combinedProbability: r.confidence * fpProbability(corrByVoter.get(r.voter.toLowerCase()) ?? null),
      combinedProbabilityRaw: (r.confidence * fpProbability(corrByVoter.get(r.voter.toLowerCase()) ?? null)) as number,
      coExcursionRate: r.coExcursionRate, // same-direction spike rate with our reference (0..1)
      coExcursionN: r.coExcursionN, // joint excursion opportunities observed
      // Implementation fingerprint: de-meaned error-profile correlation with our reference. This is now
      // the signal P is built on; the old value-similarity metric is retained in the DB but not surfaced,
      // because our reference sits 6.3x outside the provider cloud so it discriminated nothing.
      errorProfileCorr: corrByVoter.get(r.voter.toLowerCase()) ?? null,
      errorProfileN: r.errorProfileN,
      confidence: r.confidence,
      rounds: r.roundsObserved,
      variant: variantByVoter.get(r.voter.toLowerCase()) ?? null, // config whose ERROR PROFILE fits best
      knownCustom, // verified NOT the example provider (trusted negative)
    };
  });

  const maxRounds = rows.reduce((m, r) => Math.max(m, r.roundsObserved), 0);

  // BASELINE CALIBRATION against verified customs: a confirmed-custom provider should read ~0%. The raw
  // combined probability has a non-zero floor early on (poorly-scaled posterior + noisy-OR), so rescale
  // so the known-custom level maps to 0 and 1 stays 1: p' = max(0, (p - baseline) / (1 - baseline)).
  // This expresses "how much MORE suspicious than a provider we KNOW is custom" - the honest scale.
  const knownRowsRaw = report.filter((x) => x.knownCustom);
  const baseline =
    knownRowsRaw.length > 0
      ? Math.max(...knownRowsRaw.map((x) => x.combinedProbability))
      : 0;
  if (baseline > 0 && baseline < 1) {
    for (const x of report) {
      x.combinedProbability = Math.max(0, (x.combinedProbabilityRaw - baseline) / (1 - baseline));
    }
  }

  // Live false-positive check: of the verified-custom providers, how many the detector would still flag
  // above 0.5 combined probability (on the RAW scale, before baseline rescaling). A non-zero rate means
  // the detector is over-firing - a calibration warning, not an accusation of those providers.
  const knownRows = report.filter((x) => x.knownCustom);
  const falsePositives = knownRows.filter((x) => x.combinedProbabilityRaw >= 0.5);
  const fpRate = knownRows.length ? falsePositives.length / knownRows.length : null;
  return NextResponse.json({
    report,
    maxRounds,
    knownCustomCount: knownRows.length,
    falsePositiveRate: fpRate,
    falsePositiveNames: falsePositives.map((x) => x.name),
  });
}
