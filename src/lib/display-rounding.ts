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
 * The same apportionment, but no cell may exceed its own ceiling, and the leftover units go where
 * they keep each row's NUMBER agreeing with its own BAR.
 *
 * Two bugs live here, and they are the same bug pointing in opposite directions.
 *
 * The first: the provider page prints two columns per component, points earned and points available,
 * and each was apportioned INDEPENDENTLY. Both columns summed correctly and neither was wrong alone,
 * but the two roundings need not agree, so a component at full marks could gain a unit in one column
 * and lose one in the other. The page showed "Implementation independence ... 6 / 5 pts".
 *
 * The second, which the ceiling alone did not catch: a row can be printed far BELOW its bar. Validator
 * uptime at 99.91% showed "3 / 4 pts", which reads as 75%. Its true value was 3.396 points out of a
 * true maximum of 3.399, the two differing by exactly the 0.09% of uptime missed. The maximum column
 * had a spare unit and rounded 3.399 up to 4; the points column's spare units went to rows with larger
 * discarded fractions and 3.396 floored to 3. Nothing was wrong with either column's arithmetic. The
 * row was simply unreadable, and on a page whose claim is that the figure can be recomputed, a full
 * bar beside "3 / 4" is the reader's first reason to stop trusting it.
 *
 * So the remainder is no longer handed out by largest discarded fraction. It goes to whichever
 * placement leaves the WORST row misstating its own bar by as little as possible, ties broken by the
 * total misstatement across all rows. On the figures that produced "3 / 4" that moves validator uptime
 * to 4 / 4 (bar 99.91%, off by 0.1pp) and the worst row in the table from 24.9pp out to 8.0pp.
 *
 * Someone still absorbs the rounding: the units are whole and the column must total the score. The
 * choice is only ever WHERE, and sending it to the row it distorts least is the one answer a reader
 * can check against the bar in front of them.
 *
 * `ratios` is what each bar draws. Omit it and the old largest-remainder behaviour is used, which is
 * right for a column with no bars beside it.
 */
export function apportionCapped(
  values: number[],
  target: number,
  caps: number[],
  ratios?: number[]
): number[] {
  const out = values.map((v, i) => Math.min(Math.floor(v + 1e-9), caps[i]));
  let left = Math.round(target) - out.reduce((a, b) => a + b, 0);
  const byFrac = values
    .map((v, i) => ({ i, frac: v - Math.floor(v + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  // Overshoot from floating-point noise: take units back from whoever gained least, as before.
  if (left < 0) {
    for (let k = byFrac.length - 1; k >= 0 && left < 0; k--, left++) out[byFrac[k].i]--;
    return out;
  }
  if (left === 0) return out;

  if (ratios) {
    // How far a row's printed fraction sits from the fraction its bar draws, in percentage points.
    const gaps = (cells: number[]) =>
      cells.map((v, i) => (caps[i] ? Math.abs(v / caps[i] - ratios[i]) * 100 : 0));
    const cost = (cells: number[]) => {
      const g = gaps(cells);
      return { worst: Math.max(...g), total: g.reduce((a, b) => a + b, 0) };
    };

    // Every way to place the leftover units within the headroom, scored exactly. The search is
    // tiny by construction: flooring loses under one unit per row, so `left` is always smaller
    // than the number of rows, and there are six of those. The budget is a guard against a future
    // caller with a wider table, not a live concern; it falls through to the greedy pass below.
    let best: { cells: number[]; worst: number; total: number } | null = null;
    let budget = 20_000;
    const cur = [...out];
    const place = (i: number, rem: number) => {
      if (budget-- <= 0) return;
      if (i === cur.length) {
        if (rem !== 0) return;
        const c = cost(cur);
        if (!best || c.worst < best.worst - 1e-9 || (Math.abs(c.worst - best.worst) <= 1e-9 && c.total < best.total - 1e-9)) {
          best = { cells: [...cur], ...c };
        }
        return;
      }
      const room = Math.min(rem, caps[i] - cur[i]);
      for (let add = 0; add <= room; add++) {
        cur[i] += add;
        place(i + 1, rem - add);
        cur[i] -= add;
      }
    };
    place(0, left);
    if (best) return (best as { cells: number[] }).cells;

    // Budget exhausted: greedy, one unit at a time to whichever placement most reduces the worst row.
    while (left > 0) {
      let pick = -1;
      let pickCost: { worst: number; total: number } | null = null;
      for (let i = 0; i < out.length; i++) {
        if (out[i] >= caps[i]) continue;
        out[i]++;
        const c = cost(out);
        out[i]--;
        if (!pickCost || c.worst < pickCost.worst - 1e-9 || (Math.abs(c.worst - pickCost.worst) <= 1e-9 && c.total < pickCost.total - 1e-9)) {
          pickCost = c;
          pick = i;
        }
      }
      if (pick < 0) break; // every row at its ceiling
      out[pick]++;
      left--;
    }
    return out;
  }

  // No bars to agree with: largest remainder, skipping anything already at its ceiling. Repeated
  // passes because a skipped cell must not consume the unit it could not take.
  let progress = true;
  while (left > 0 && progress) {
    progress = false;
    for (const { i } of byFrac) {
      if (left <= 0) break;
      if (out[i] < caps[i]) {
        out[i]++;
        left--;
        progress = true;
      }
    }
  }
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
