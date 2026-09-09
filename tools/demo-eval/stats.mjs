/* The two summary numbers every scenario reports through, in one place so the
 * report cannot answer the same question four ways. */

/**
 * The value at `fraction` of `values`, nearest-rank, or `null` when there is
 * nothing to take a percentile of. Null is what the surrounding fields already
 * say for an empty sample, and it is what the baseline reads as not-measured;
 * a zero there is a measurement nobody made, and comparing against it hides
 * whatever the scenario failed to observe.
 *
 * Sorts a copy, so a caller holding a sorted array pays a sorted-input sort and
 * one holding raw samples cannot get a percentile of an unsorted list.
 */
export function percentile(values, fraction, digits) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const value = sorted[Math.min(rank, sorted.length) - 1];
  return digits === undefined ? value : round(value, digits);
}

export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
