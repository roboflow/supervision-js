export interface TimingSummary {
  readonly runs: number;
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

export function summarize(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];

  return {
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: at(0.5),
    min: sorted[0],
    p95: at(0.95),
    runs: sorted.length,
  };
}
