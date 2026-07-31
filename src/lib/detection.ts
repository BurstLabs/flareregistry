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

/**
 * TICK-GRID (value lattice) evidence.
 *
 * The example provider's weightedMedian() returns an observed trade print verbatim, so its value sits on
 * some venue's tick grid, whereas anything that averages or rounds lands elsewhere. The scorer measures
 * how often a provider's encoded value is divisible by a coarse venue tick, against the PER-ROUND
 * LEAVE-ONE-OUT field rate for that same (feed, tick) cell.
 *
 * The null is empirical, NOT the arithmetic 1/T. An earlier version used 1/T and was wrong by ~2x,
 * because T=10 and T=100 carry 99.8% of the mass, so the test is really "has at most d-1 decimal places"
 * - satisfied by any implementation that rounds, at a rate set by where the price sits that round rather
 * than by the provider. Conditioning on the round fixes the centring and removes most of the dependence.
 *
 * lift = hits / expected, where 1.0 is now "behaves like the field this round", by construction.
 * Measured: field 1.00, top cluster 1.8x-2.1x, verified-custom Burst FTSO 0.54x, verified-custom
 * 1FTSO 1.47x.
 *
 * IMPORTANT: this is a ONE-SIDED screen. A low lift is strong evidence AGAINST running the example
 * provider. A high lift is NOT proof FOR it, because any median-of-prints implementation also echoes a
 * print, which is exactly why verified-custom 1FTSO sits above the field. Use it to exclude, never to
 * accuse.
 */
export interface LatticeStats {
  /** hits / expected; 1.0 = the field's own rate for the same cells. */
  lift: number | null;
  /** (hits - expected) / sqrt(inflated var). Evidence strength, not a calibrated p-value. */
  z: number | null;
  /** Upper confidence bound on lift. The exclusion decision is made on THIS, not on z. */
  liftUpper: number | null;
  hits: number;
  trials: number;
  /** Enough evidence to say this provider is below the example-provider level. */
  ruledOut: boolean;
}

/** Minimum trials before the screen may rule anyone out (~12 rounds; 84 cells per round). */
export const LATTICE_MIN_TRIALS = 1000;
/**
 * Variance inflation for residual dependence. The leave-one-out null removes the round-level common
 * factor, but trials within a feed remain nested (a hit at T=100 forces a hit at T=10; measured ~1.08x
 * on variance) and there is some serial correlation across rounds. 1.5 is a deliberate safety margin:
 * it widens the confidence bound, so it can only make the screen SLOWER to exclude someone, never faster.
 */
export const LATTICE_VAR_INFLATION = 1.5;
/** z for the one-sided upper bound (~99%). */
const LATTICE_Z_UPPER = 2.33;
/**
 * A provider is excluded when even the upper bound of its lift stays below this. The example-provider
 * level measures 1.8x-2.1x and the field is 1.0x by construction, so 1.3 sits well clear of both.
 * Unlike a fixed z cut this is bounded: as trials grow the bound converges on the true lift, so a
 * genuinely low-lift provider stays excluded forever instead of ageing out of the flag.
 */
export const LATTICE_LIFT_EXCLUDE = 1.3;

/**
 * PER-CELL HIT-PATTERN MATCH - the discriminator among providers the screen does NOT exclude.
 *
 * Aggregate lift cannot rank those providers: it is confounded by config size (our own reference configs
 * span 1.44x to 2.33x) and by the fact that any median-of-prints implementation reads high. But WHICH
 * (feed, tick) cells a provider over-hits is determined by its VENUE LIST, so correlating its per-cell
 * excess profile against our reference instances answers the sharper question: does it over-hit the same
 * cells a real example provider does?
 *
 * Measured over 25 live rounds, with the control expectations stated BEFORE looking:
 *   ref vs ref (same code, different configs)      r = 0.624 mean
 *   1FTSO   (verified custom, median-of-prints)    r = 0.396   <- the elevation threshold
 *   Burst FTSO (verified custom)                   r = -0.432
 * The field splits with a sharp cliff between +0.230 and -0.118, and everything the tick-grid screen
 * excludes lands on the negative side.
 *
 * Still not proof. It compares against OUR replica, so it inherits some dependence on that replica being
 * representative. It is far more defensible than the removed error-profile fingerprint because it
 * compares DISCRETE venue-grid hit patterns rather than value distances, and because it has validated
 * controls at both ends rather than none.
 */
// Thresholds are set from the verified-custom control WITH MARGIN. 1FTSO has measured 0.396 and 0.423
// across two windows, so a cut at 0.396 would have shown a provider we KNOW is custom as elevated.
export const PATTERN_KNOWN_CUSTOM = 0.45; // safely above the observed control range
export const PATTERN_STRONG = 0.55; // clearly above it; providers top out near 0.73, our refs 0.80-0.87
/**
 * Rounds of per-cell data before the correlation may be banded or classified.
 *
 * This is NOT the same maturity question as LATTICE_MIN_TRIALS. A correlation between noisy profiles is
 * ATTENUATED TOWARD ZERO, so at low round counts every r is biased down and thresholds calibrated on
 * mature data over-demote. Measured directly: at 10 rounds the verified-custom control read 0.268 and
 * Scintilla 0.479; at 24 rounds the same providers read 0.423 and 0.726. FTSOCAN and Ankr swapped
 * classes between the two. The aggregate lift gate was already long satisfied (7527 trials vs a 1000
 * minimum) and said nothing about this, so without its own gate the tab shows class labels that shuffle.
 */
export const PATTERN_MIN_ROUNDS = 20;

export type PatternBand = "strong" | "elevated" | "baseline" | "none";


export interface PatternMatch {
  /** Correlation with the mean reference profile. */
  r: number | null;
  /** Reference CONFIG whose hit pattern it matches best, and that correlation. */
  bestConfig: string | null;
  bestR: number | null;
  band: PatternBand;
  /** Rounds of per-cell data behind r. */
  rounds: number;
  /** False until `rounds` reaches PATTERN_MIN_ROUNDS; r is shown but not banded or classified. */
  mature: boolean;
}

function corrOver(keys: string[], a: Record<string, number>, b: Record<string, number>): number {
  const xs: number[] = [], ys: number[] = [];
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x); ys.push(y);
  }
  return pearson(xs, ys);
}

/**
 * @param cells      this provider's accumulated per-cell excess profile
 * @param refCells   { instanceId: profile } for our reference instances
 * @param ruledOut   providers the one-sided screen already excluded get no band at all
 */
export function patternMatch(
  cells: Record<string, number> | null,
  refCells: Record<string, Record<string, number>>,
  ruledOut: boolean,
  rounds = 0
): PatternMatch {
  const mature = rounds >= PATTERN_MIN_ROUNDS;
  const empty: PatternMatch = { r: null, bestConfig: null, bestR: null, band: "none", rounds, mature };
  if (!cells || typeof cells !== "object") return empty;
  const instances = Object.keys(refCells ?? {});
  if (!instances.length) return empty;

  // Union of cell keys seen by the reference, so a provider is scored on the same axes.
  const keys = new Set<string>();
  for (const inst of instances) for (const k of Object.keys(refCells[inst] ?? {})) keys.add(k);
  const keyList = [...keys].filter((k) => Number.isFinite(cells[k]));
  if (keyList.length < 20) return empty;

  const mean: Record<string, number> = {};
  for (const k of keyList) {
    let s = 0, n = 0;
    for (const inst of instances) {
      const v = refCells[inst]?.[k];
      if (Number.isFinite(v)) { s += v; n++; }
    }
    if (n) mean[k] = s / n;
  }
  const r = corrOver(keyList, cells, mean);

  let bestConfig: string | null = null, bestR: number | null = null;
  for (const inst of instances) {
    const c = corrOver(keyList, cells, refCells[inst] ?? {});
    if (!Number.isFinite(c)) continue;
    if (bestR == null || c > bestR) { bestR = c; bestConfig = inst.split(":")[0]; }
  }

  // No band until the profile is mature (r is attenuated toward zero while it is not), and never for a
  // provider the one-sided screen already excluded, regardless of r.
  const band: PatternBand = ruledOut || !mature || !Number.isFinite(r)
    ? "none"
    : r >= PATTERN_STRONG
      ? "strong"
      : r >= PATTERN_KNOWN_CUSTOM
        ? "elevated"
        : "baseline";
  return { r: Number.isFinite(r) ? r : null, bestConfig, bestR, band, rounds, mature };
}

/**
 * USDC CONFIG SIGNATURE - the only discriminator that survived adversarial verification, and the only
 * one here that needs no reference instance, no field baseline and no calibration.
 *
 * The example provider's shipped feeds.json prices USDC/USD from five USDC/USDT order books and then
 * multiplies by the provider's OWN USDT/USD median. USDC/USDT ticks at 1e-4, so for anyone running that
 * config, USDC_USD / USDT_USD must be an integer multiple of 1e-4. Quoting USDC from native USD books
 * imposes no such constraint.
 *
 * Measured across three windows, one of them 12 days before the others:
 *   our reference instances  0.504 - 1.000
 *   candidate cluster        0.536 - 1.000   (51 of 51 classifications, no exceptions)
 *   1FTSO   (VERIFIED CUSTOM)  0.095 / 0.127 / 0.152   -> custom in 3 of 3
 *   Burst   (VERIFIED CUSTOM)  identical to 1FTSO      -> custom in 3 of 3
 *   field bulk               0.055 - 0.245
 * Robustness: the tolerance is not fitted (hit rates are identical at 0.02 and 0.05); a placebo grid
 * constant of 1.3e4 collapses the candidates to ~0.1; and recomputing a candidate against the FIELD
 * median USDT instead of its own drops it 0.579 -> 0.268, exactly as the mechanism predicts.
 *
 * READ IT AS A CONFIG SIGNATURE, NOT AN IMPLEMENTATION DETECTOR. Within identical example-provider code
 * our own fleet spans 0.504 to 1.000 purely by which USDC books are configured, so a provider running
 * stock code whose USDC venues are geo-blocked or down scores low and looks custom. That is not
 * hypothetical: Digital Dynamix reads 0.14-0.26 on the grid while agreeing byte-exactly with the
 * candidate cluster on 78% of cells. The correlation gate exists to catch exactly that case.
 */
export const USDC_GRID_EXAMPLE = 0.35; // at or above: consistent with the shipped USDC config
export const USDC_CORR_GATE = 0.2; // a derived USDC inherits USDT's variation
/** Rounds required before the signature is reported at all. */
export const USDC_MIN_ROUNDS = 300;

export type ConfigSignature = "example-config" | "non-example-config" | "unclear" | "pending";

export interface UsdcSignature {
  /** Fraction of rounds where USDC/USDT landed on the 1e-4 grid. */
  grid: number | null;
  /** Correlation between the provider's own USDC and USDT series. */
  corr: number | null;
  rounds: number;
  verdict: ConfigSignature;
}

export function usdcSignature(row: {
  usdcGridHits: number;
  usdcGridN: number;
  usdcSumX: number;
  usdcSumY: number;
  usdcSumXY: number;
  usdcSumXX: number;
  usdcSumYY: number;
}): UsdcSignature {
  const n = row.usdcGridN;
  // NOTE: deliberately NO "minimum distinct USDC values" guard. An earlier form of this rule required 5+
  // distinct values and, in a window where USDC/USD was pinned, refused to classify 25 of 100 providers
  // including both controls. The statistic is a per-round Bernoulli, not a variance estimate, so it does
  // not need spread. Removing the guard raised cross-window agreement from 63.5% to 86.5%.
  if (!n || n < USDC_MIN_ROUNDS) {
    return { grid: n ? row.usdcGridHits / n : null, corr: null, rounds: n, verdict: "pending" };
  }
  const grid = row.usdcGridHits / n;
  const cov = row.usdcSumXY - (row.usdcSumX * row.usdcSumY) / n;
  const vx = row.usdcSumXX - (row.usdcSumX * row.usdcSumX) / n;
  const vy = row.usdcSumYY - (row.usdcSumY * row.usdcSumY) / n;
  const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;

  // Above the grid threshold, the USDC series is arithmetically tied to the provider's own USDT, which
  // is the shipped config's behaviour. Below it, the correlation gate separates "quotes USDC natively"
  // (genuinely a different config) from "runs example code with a different USDC book" - the latter
  // still shows USDT-derived variation and must NOT be called custom.
  const verdict: ConfigSignature =
    grid >= USDC_GRID_EXAMPLE
      ? "example-config"
      : corr != null && corr >= USDC_CORR_GATE
        ? "unclear"
        : "non-example-config";
  return { grid, corr, rounds: n, verdict };
}

export function latticeStats(row: {
  latticeHits: number;
  latticeExpected: number;
  latticeVar: number;
  latticeTrials: number;
}): LatticeStats {
  const { latticeHits: h, latticeExpected: e, latticeVar: v, latticeTrials: n } = row;
  if (!n || !(e > 0)) {
    return { lift: null, z: null, liftUpper: null, hits: h ?? 0, trials: n ?? 0, ruledOut: false };
  }
  const sd = v > 0 ? Math.sqrt(v * LATTICE_VAR_INFLATION) : 0;
  const z = sd > 0 ? (h - e) / sd : null;
  const liftUpper = (h + LATTICE_Z_UPPER * sd) / e;
  return {
    lift: h / e,
    z,
    liftUpper,
    hits: h,
    trials: n,
    ruledOut: n >= LATTICE_MIN_TRIALS && liftUpper < LATTICE_LIFT_EXCLUDE,
  };
}

export interface FingerprintResult {
  /** voter (submit address, lowercased) -> de-meaned error-profile correlation with the yardstick. */
  corrByVoter: Map<string, number>;
  /** voter -> reference CONFIG whose error profile it matches best. */
  variantByVoter: Map<string, string>;
  /**
   * fingerprint -> calibrated probability, monotonic by construction. Returns NULL (not 0) when the
   * calibration is unavailable: a probability of 0 is a positive claim that a provider is definitely not
   * an example provider, which is not what "we could not calibrate" means, and returning 0 here would
   * silently zero the whole tab and empty the CSV - the same failure removed from the baseline rescale.
   */
  fpProbability: (fp: number | null | undefined) => number | null;
  /** False when the anchor/field calibration could not be built; surface this rather than showing 0%. */
  calibrated: boolean;
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
  const calibrated = Number.isFinite(fpGap) && fpGap > 1e-6 && anchorFps.length >= 2;
  const fpProbability = (fp: number | null | undefined): number | null => {
    if (!calibrated) return null;
    if (fp == null || !Number.isFinite(fp)) return null;
    const mid = (anchorMean + fieldMean) / 2;
    const k = 6 / fpGap;
    return 1 / (1 + Math.exp(-k * (fp - mid)));
  };

  return {
    corrByVoter, variantByVoter, fpProbability, calibrated,
    anchorFps, anchorMean, fieldMean, fpGap,
  };
}

/**
 * COMBINED CLASS from the two axes. This is the point of having both.
 *
 * Lift measures LEVEL (does this provider echo raw prints at all). Pattern is a Pearson correlation and
 * therefore scale-invariant, so it measures SHAPE (does it echo them on the same cells, i.e. from the
 * same venue list). Measured correlation between the two across the non-excluded providers is 0.419, so
 * they carry substantially independent information.
 *
 * The decisive case: our full-config reference reads lift 1.50-1.51x, and verified-custom 1FTSO reads
 * lift 1.50x. On level alone they are INDISTINGUISHABLE. On shape they are not remotely close: our
 * references sit at r = 0.84-0.85, 1FTSO at 0.42. Only the combination separates them.
 *
 *   "excluded"      low lift            -> does not echo prints at all
 *   "other-median"  high lift, low r    -> echoes prints from a DIFFERENT venue set, i.e. a custom
 *                                          median-of-prints implementation. 1FTSO lives here.
 *   "candidate"     high lift, high r   -> echoes prints from the SAME venue set as the example provider
 *   "pending"       not enough data yet
 */
export type DetectionClass = "excluded" | "other-median" | "candidate" | "pending";

export function detectionClass(lat: LatticeStats, pat: PatternMatch): DetectionClass {
  if (lat.ruledOut) return "excluded";
  // `pat.mature` is the gate that matters here: the lift side is satisfied thousands of trials before the
  // correlation stops being attenuated, so without it every class label churns for the first ~20 rounds.
  if (lat.lift == null || lat.trials < LATTICE_MIN_TRIALS || pat.r == null || !pat.mature) return "pending";
  return pat.r >= PATTERN_KNOWN_CUSTOM ? "candidate" : "other-median";
}
