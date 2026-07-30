// Shared example-provider detection maths.
//
// This lives in one place on purpose. The Detection tab and the CSV report previously each carried their
// OWN copy of the probability derivation, which is how they drifted apart: after P was rebased onto the
// error-profile fingerprint the tab computed the fingerprint fresh while the report still exported the
// stale value-similarity number from the DB, so the CSV disagreed with the screen it was downloaded from.
// Both now call computeFingerprints().

import type { ProviderSimilarity } from "@prisma/client";

/** Median of a numeric array. */
export function med(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pearson correlation; NaN when either side is degenerate or too short to mean anything. */
export function pearson(x: number[], y: number[]): number {
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

export type RefProfiles = Record<string, Record<string, number>>;

export interface FingerprintResult {
  /** voter (submit address, lowercased) -> de-meaned error-profile correlation with the yardstick. */
  corrByVoter: Map<string, number>;
  /** voter -> reference CONFIG whose error profile it matches best. */
  variantByVoter: Map<string, string>;
  /** fingerprint -> calibrated probability, monotonic by construction. */
  fpProbability: (fp: number | null | undefined) => number;
  /** Cross-config anchor fingerprints (the attainable "is an example provider" bar). */
  anchorFps: number[];
  anchorMean: number;
  fieldMean: number;
  fpGap: number;
}

/**
 * Error-profile correlation - the implementation fingerprint.
 *
 * Each provider (and each of our reference instances) carries an EW per-feed vector of
 * ln|deviation from consensus|. Correlating those raw vectors is dominated by FEED DIFFICULTY (illiquid
 * feeds are hard for everyone), which put a verified-custom provider at rank 7. So subtract each feed's
 * difficulty baseline (median across providers) first; what remains is implementation-specific structure.
 *
 * The POSITIVE CLASS is our other-config reference instances scored against the yardstick: each is a
 * genuine example provider whose exchange config differs, i.e. the realistic attainable bar. Same-config
 * instances are excluded because they are byte-identical twins and would set the bar at 1.0, which is
 * exactly what made the old value-similarity metric flag nobody.
 */
export function computeFingerprints(
  rows: Pick<ProviderSimilarity, "voter" | "feedErrorsJson">[],
  allRefProfiles: RefProfiles
): FingerprintResult {
  const refInstanceIds = Object.keys(allRefProfiles ?? {});
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
  const variantByVoter = new Map<string, string>();
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
      let best: { v: string; c: number } | null = null;
      for (const inst of refInstanceIds) {
        const ic = corrTo(allRefProfiles[inst], p);
        if (!Number.isFinite(ic)) continue;
        const v = inst.split(":")[0];
        if (!best || ic > best.c) best = { v, c: ic };
      }
      if (best) variantByVoter.set(voter, best.v);
    }
  }

  // Calibrate fingerprint -> probability with a monotonic logistic between the FIELD level and the
  // cross-config ANCHOR level. Monotonic by construction, so a higher fingerprint always reads higher.
  const fieldFps = [...corrByVoter.values()];
  const anchorMean = anchorFps.length ? anchorFps.reduce((a, b) => a + b, 0) / anchorFps.length : NaN;
  const fieldMean = fieldFps.length ? med(fieldFps) : NaN;
  const fpGap = anchorMean - fieldMean;
  const fpProbability = (fp: number | null | undefined): number => {
    if (fp == null || !Number.isFinite(fp)) return 0;
    if (!Number.isFinite(fpGap) || !(fpGap > 1e-6) || anchorFps.length < 2) return 0;
    const mid = (anchorMean + fieldMean) / 2;
    const k = 6 / fpGap;
    return 1 / (1 + Math.exp(-k * (fp - mid)));
  };

  return { corrByVoter, variantByVoter, fpProbability, anchorFps, anchorMean, fieldMean, fpGap };
}
