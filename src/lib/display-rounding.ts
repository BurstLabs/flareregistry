// Rounding used wherever the reputation score is DISPLAYED.
//
// Shared rather than duplicated, because the provider panel and the published methodology page must
// round identically. They show the same weights and a reader moves between them expecting the same
// numbers; two independent copies of "round to one decimal" would eventually disagree, which on a
// page whose claim is that the figure is recomputable is worse than either choice on its own.

/**
 * Round a set of values to one decimal so they sum EXACTLY to `target` (largest remainder).
 *
 * Rounding each value independently does not preserve a sum. The model weights rescale by 100/90 and
 * three of the five land on .5556 or .7778, so all three round up: the column printed 50.0 + 27.8 +
 * 5.6 + 11.1 + 5.6 = 100.1 beside a heading saying "out of 100".
 *
 * Floor everything to a tenth, then hand the leftover tenths to the values with the largest discarded
 * fractions. No value moves more than 0.1 from its true figure, and the column always adds up.
 */
export function apportionTenths(values: number[], target: number): number[] {
  const tenths = values.map((v) => v * 10);
  const out = tenths.map((t) => Math.floor(t + 1e-9));
  let left = Math.round(target * 10) - out.reduce((a, b) => a + b, 0);
  const byFrac = tenths
    .map((t, i) => ({ i, frac: t - Math.floor(t + 1e-9) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < byFrac.length && left > 0; k++, left--) out[byFrac[k].i]++;
  // Defensive: floating-point noise could overshoot. Take tenths back from the values that gained
  // least by rounding, so nothing is ever off by more than 0.1.
  for (let k = byFrac.length - 1; k >= 0 && left < 0; k--, left++) out[byFrac[k].i]--;
  return out.map((x) => x / 10);
}

/**
 * A score to one decimal, TRUNCATED rather than rounded.
 *
 * Every band floor is an integer (Strong 95, Solid 85, Mixed 80). toFixed(1) rounds, so a provider on
 * 94.95 would read "95.0 out of 100" while labelled Solid, and the headline would contradict the band
 * beside it. Truncating cannot cross a floor the score has not actually reached: 94.95 shows 94.9.
 * Costs at most 0.09 of understatement.
 */
export const show1 = (x: number) => (Math.floor(x * 10 + 1e-9) / 10).toFixed(1);

/**
 * The component weights as a provider page shows them: rescaled so they sum to 100, and apportioned
 * so the printed column adds up.
 *
 * `weights` must be in the same order as the rows being rendered.
 */
export function weightsOutOf100(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return weights.map(() => 0);
  return apportionTenths(
    weights.map((w) => (w * 100) / total),
    100
  );
}
