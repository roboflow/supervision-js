const FALLBACK_HARDWARE_CONCURRENCY = 4;
const MAX_AUTO_MASK_PREPARATION_WORKER_COUNT = 4;
const MAX_REQUESTED_MASK_PREPARATION_WORKER_COUNT = 8;
const MIN_MASK_PREPARATION_WORKER_COUNT = 1;

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
      MAX_REQUESTED_MASK_PREPARATION_WORKER_COUNT,
    );
  }

  const hardwareConcurrency = Number.isFinite(options.hardwareConcurrency)
    ? (options.hardwareConcurrency ?? FALLBACK_HARDWARE_CONCURRENCY)
    : FALLBACK_HARDWARE_CONCURRENCY;
  const autoWorkerCount = Math.floor(hardwareConcurrency / 2);

  return clampWorkerCount(
    autoWorkerCount,
    MAX_AUTO_MASK_PREPARATION_WORKER_COUNT,
  );
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
