const FALLBACK_HARDWARE_CONCURRENCY = 4;

/**
 * Automatic mask preparation intentionally uses a small pool. RLE decode and
 * PNG ID-mask creation are CPU-heavy enough to benefit from parallelism, but
 * worker count also increases memory pressure and can compete with media
 * decode. Explicit caller requests are allowed higher, but still bounded.
 */
export const AUTO_MASK_PREPARATION_WORKER_LIMIT = 4;
export const REQUESTED_MASK_PREPARATION_WORKER_LIMIT = 8;
export const MIN_MASK_PREPARATION_WORKER_COUNT = 1;

export function resolveMaskPreparationWorkerCount(
  options: {
    readonly hardwareConcurrency?: number;
    readonly requestedWorkerCount?: number;
  } = {},
) {
  if (
    options.requestedWorkerCount !== undefined &&
    Number.isFinite(options.requestedWorkerCount)
  ) {
    return clampWorkerCount(
      Math.floor(options.requestedWorkerCount),
      REQUESTED_MASK_PREPARATION_WORKER_LIMIT,
    );
  }

  const hardwareConcurrency = Number.isFinite(options.hardwareConcurrency)
    ? (options.hardwareConcurrency ?? FALLBACK_HARDWARE_CONCURRENCY)
    : FALLBACK_HARDWARE_CONCURRENCY;
  const autoWorkerCount = Math.floor(hardwareConcurrency / 2);

  return clampWorkerCount(autoWorkerCount, AUTO_MASK_PREPARATION_WORKER_LIMIT);
}

export function getBrowserMaskPreparationWorkerCount(
  requestedWorkerCount: number | undefined,
) {
  return resolveMaskPreparationWorkerCount({
    hardwareConcurrency:
      typeof navigator === "undefined"
        ? undefined
        : navigator.hardwareConcurrency,
    requestedWorkerCount,
  });
}

function clampWorkerCount(workerCount: number, maxWorkerCount: number) {
  return Math.min(
    maxWorkerCount,
    Math.max(MIN_MASK_PREPARATION_WORKER_COUNT, workerCount),
  );
}
