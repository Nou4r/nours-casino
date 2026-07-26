/**
 * Plinko payout tables and board mathematics.
 *
 * Every table is symmetric, has exactly `rows + 1` buckets, and is calibrated so
 * that the expected return under a fair binomial drop sits at ~99% (a 1% house
 * edge). Run `calculateRTP(rows, risk)` to check any table at runtime.
 */

/** @typedef {'low' | 'medium' | 'high'} Risk */

export const MIN_ROWS = 8;
export const MAX_ROWS = 16;

/** Risk levels in increasing order of variance. @type {readonly Risk[]} */
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** Selectable row counts, ascending. @type {readonly number[]} */
export const ROW_OPTIONS = Object.freeze(
  Array.from({ length: MAX_ROWS - MIN_ROWS + 1 }, (_, i) => MIN_ROWS + i),
);

const freezeTable = (table) => {
  for (const byRows of Object.values(table)) {
    for (const payouts of Object.values(byRows)) Object.freeze(payouts);
    Object.freeze(byRows);
  }
  return Object.freeze(table);
};

/**
 * Payout multipliers indexed as `MULTIPLIERS[risk][rows]`, left bucket first.
 *
 * Low risk keeps nearly every drop close to break-even; high risk strips the
 * centre down to 0.2x and pushes the whole edge into the outermost buckets,
 * which is where the 1000x on 16 rows comes from.
 *
 * @type {Readonly<Record<Risk, Readonly<Record<number, readonly number[]>>>>}
 */
export const MULTIPLIERS = freezeTable({
  low: {
    8: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    9: [5.6, 2, 1.6, 1, 0.7, 0.7, 1, 1.6, 2, 5.6],
    10: [8.9, 3, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 3, 8.9],
    11: [8.4, 3, 1.9, 1.3, 1, 0.7, 0.7, 1, 1.3, 1.9, 3, 8.4],
    12: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    13: [8.1, 4, 3, 1.9, 1.2, 0.9, 0.7, 0.7, 0.9, 1.2, 1.9, 3, 4, 8.1],
    14: [7.1, 4, 1.9, 1.4, 1.3, 1.1, 1, 0.5, 1, 1.1, 1.3, 1.4, 1.9, 4, 7.1],
    15: [15, 8, 3, 2, 1.5, 1.1, 1, 0.7, 0.7, 1, 1.1, 1.5, 2, 3, 8, 15],
    16: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
  },
  medium: {
    8: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    9: [18, 4, 1.7, 0.9, 0.5, 0.5, 0.9, 1.7, 4, 18],
    10: [22, 5, 2, 1.4, 0.6, 0.4, 0.6, 1.4, 2, 5, 22],
    11: [24, 6, 3, 1.8, 0.7, 0.5, 0.5, 0.7, 1.8, 3, 6, 24],
    12: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    13: [43, 13, 6, 3, 1.3, 0.7, 0.4, 0.4, 0.7, 1.3, 3, 6, 13, 43],
    14: [58, 15, 7, 4, 1.9, 1, 0.5, 0.2, 0.5, 1, 1.9, 4, 7, 15, 58],
    15: [88, 18, 11, 5, 3, 1.3, 0.5, 0.3, 0.3, 0.5, 1.3, 3, 5, 11, 18, 88],
    16: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
  },
  high: {
    8: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
    9: [43, 7, 2, 0.6, 0.2, 0.2, 0.6, 2, 7, 43],
    10: [76, 10, 3, 0.9, 0.3, 0.2, 0.3, 0.9, 3, 10, 76],
    11: [120, 14, 5.2, 1.4, 0.4, 0.2, 0.2, 0.4, 1.4, 5.2, 14, 120],
    12: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
    13: [260, 37, 11, 4, 1, 0.2, 0.2, 0.2, 0.2, 1, 4, 11, 37, 260],
    14: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2, 0.2, 0.3, 1.9, 5, 18, 56, 420],
    15: [620, 83, 27, 8, 3, 0.5, 0.2, 0.2, 0.2, 0.2, 0.5, 3, 8, 27, 83, 620],
    16: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
});

/**
 * Clamp a row count into the supported range and round it to an integer.
 * @param {number} rows
 * @returns {number}
 */
export function normalizeRows(rows) {
  const n = Math.round(Number(rows));
  if (!Number.isFinite(n)) return MIN_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, n));
}

/**
 * Coerce arbitrary input to a known risk level.
 * @param {string} risk
 * @returns {Risk}
 */
export function normalizeRisk(risk) {
  const key = String(risk).toLowerCase();
  return RISK_LEVELS.includes(/** @type {Risk} */ (key)) ? /** @type {Risk} */ (key) : 'medium';
}

/**
 * Payout multipliers for a board, ordered left bucket to right bucket.
 *
 * Returns the frozen canonical row — cheap to call repeatedly, but copy it
 * before mutating.
 *
 * @param {number} rows Peg rows, 8-16 (clamped).
 * @param {Risk} risk Risk level (defaults to medium if unrecognised).
 * @returns {readonly number[]} Array of length `rows + 1`.
 */
export function getMultipliers(rows, risk) {
  return MULTIPLIERS[normalizeRisk(risk)][normalizeRows(rows)];
}

/** Memoised binomial distributions, keyed by row count. @type {Map<number, readonly number[]>} */
const probsCache = new Map();

/**
 * Probability of landing in each bucket for a fair board.
 *
 * Bucket `k` is reached by any path with exactly `k` right-bounces, so the
 * distribution is Binomial(rows, 1/2): `C(rows, k) / 2^rows`.
 *
 * @param {number} rows Peg rows, 8-16 (clamped).
 * @returns {readonly number[]} Frozen array of length `rows + 1` summing to 1.
 */
export function calculateBinomialProbs(rows) {
  const n = normalizeRows(rows);
  const cached = probsCache.get(n);
  if (cached) return cached;

  const total = 2 ** n;
  const out = new Array(n + 1);
  // Rolling Pascal's-triangle coefficient: C(n,k+1) = C(n,k) * (n-k) / (k+1).
  let coefficient = 1;
  for (let k = 0; k <= n; k++) {
    out[k] = coefficient / total;
    coefficient = (coefficient * (n - k)) / (k + 1);
  }

  const frozen = Object.freeze(out);
  probsCache.set(n, frozen);
  return frozen;
}

/**
 * Expected return per unit wagered for a board, e.g. `0.99` for a 1% edge.
 * @param {number} rows
 * @param {Risk} risk
 * @returns {number}
 */
export function calculateRTP(rows, risk) {
  const payouts = getMultipliers(rows, risk);
  const probs = calculateBinomialProbs(rows);
  let rtp = 0;
  for (let i = 0; i < payouts.length; i++) rtp += probs[i] * payouts[i];
  return rtp;
}

/**
 * Largest payout available on a board — handy for UI headline copy.
 * @param {number} rows
 * @param {Risk} risk
 * @returns {number}
 */
export function getMaxMultiplier(rows, risk) {
  return getMultipliers(rows, risk)[0];
}
