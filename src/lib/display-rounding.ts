// Rounding used wherever the reputation score is DISPLAYED.
//
// Shared rather than duplicated, because the provider panel and the published methodology page must
// round identically. They show the same weights and a reader moves between them expecting the same
// numbers; two independent copies of the rounding would eventually disagree, which on a page whose
// claim is that the figure is recomputable is worse than either choice on its own.
//
// EVERYTHING IS A WHOLE NUMBER. Decimals were precise and hard to read: a column of 40.2 / 24.8 /
// 3.7 / 6.8 / 4.1 asks a reader to do decimal arithmetic to check a figure they were invited to
// check. Whole numbers are what the panel is for. The precision is not lost, only unprinted: the
// score itself is unchanged and every underlying input is published.

import { BAND_FLOORS } from "./reputation";

/**
 * Round a set of values to whole numbers that sum EXACTLY to `target` (largest remainder).
 *
 * Rounding each value on its own does not preserve a sum. The model weights rescale by 100/90, and
 * rounding those independently gives 50 + 28 + 6 + 11 + 6 = 101 against a heading saying "out of
 * 100". Floor everything, then hand the leftover units to the values with the largest discarded
 * fractions: no value moves more than 1 from its true figure and the column always adds up.
 *
 * Ties are broken by original order, which is stable across renders, so the same provider does not
 * see a different split on a refresh.
 */
export function apportionWhole(values: number[], target: number): number[] {
  const out = values.map((v) => Math.floor(v + 1e-9));
  let left = Math.round(target) - out.reduce((a, b) => a + b, 0);
  const byFrac = values
    .map((v, i) => ({ i, frac: v - Math.floor(v + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byFrac.length && left > 0; k++, left--) out[byFrac[k].i]++;
  // Defensive: floating-point noise could overshoot. Take units back from the values that gained
  // least by rounding, so nothing is ever off by more than 1.
  for (let k = byFrac.length - 1; k >= 0 && left < 0; k--, left++) out[byFrac[k].i]--;
  return out;
}

/**
 * The score as a whole number: rounded, but NEVER across a band floor the score has not reached.
 *
 * Every band floor is an integer (Strong 95, Solid 85, Mixed 80). Plain rounding would print "80 out
 * of 100" for a provider on 79.6 sitting in Needs attention, whose next band begins at exactly 80,
 * so the headline would contradict the label beside it. Where that would happen the figure is held
 * one below the floor instead.
 *
 * This is not the old flooring, which understated every provider by up to a point. It rounds
 * normally everywhere except the half-point below a band boundary, which is the only place the
 * displayed number could assert something the score has not earned.
 */
export function displayScore(score: number): number {
  const rounded = Math.round(score);
  const crossed = BAND_FLOORS.map(([, f]) => f)
    .filter((f) => f > score && rounded >= f)
    .sort((a, b) => a - b)[0];
  return crossed != null ? crossed - 1 : rounded;
}

/**
 * The component weights as both pages show them: rescaled to sum to 100, then apportioned to whole
 * numbers so the printed column adds up exactly.
 *
 * `weights` must be in the same order as the rows being rendered.
 */
export function weightsOutOf100(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return weights.map(() => 0);
  return apportionWhole(
    weights.map((w) => (w * 100) / total),
    100
  );
}
