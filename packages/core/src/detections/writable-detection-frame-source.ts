import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionFrameRetentionOptions,
  DetectionFrameSourceVersionRange,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import { DetectionFrameRetentionMode as RetentionMode } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

const RANGE_EPSILON_SECONDS = 1e-6;

interface VersionedRange extends DetectionFrameSourceVersionRange {
  readonly version: number;
}

interface RangeWaiter {
  readonly range: DetectionFrameSourceVersionRange;
  reject(error: unknown): void;
  resolve(): void;
}

interface AvailableRange {
  endTime: number;
  startTime: number;
}

export function createWritableDetectionFrameSource(options: {
  readonly store: ColdDetectionFrameStore;
  readonly datasetId: string;
  readonly chunkDurationSeconds?: number;
  readonly retention?: DetectionFrameRetentionOptions;
}): WritableDetectionFrameSource {
  let summary: ColdDetectionFrameStoreWriteSummary | null = null;
  let version = 0;
  let allRangeVersion = 0;
  let destroyed = false;
  const changedRanges: VersionedRange[] = [];
  const availableRanges: AvailableRange[] = [];
  const waiters: RangeWaiter[] = [];

  const writeOptions = (frames: readonly DetectionFrame[]) => ({
    chunkDurationSeconds: options.chunkDurationSeconds,
    datasetId: options.datasetId,
    frames,
  });

  const recordRangeWrite = (
    nextSummary: ColdDetectionFrameStoreWriteSummary,
    changedRange: DetectionFrameSourceVersionRange,
  ) => {
    summary = nextSummary;
    version += 1;
    changedRanges.push({ ...changedRange, version });
    recordAvailableRange(changedRange, availableRanges);
    resolveCoveredWaiters();

    return nextSummary;
  };

  const recordAllRangesWrite = (
    nextSummary: ColdDetectionFrameStoreWriteSummary,
  ) => {
    summary = nextSummary;
    version += 1;
    allRangeVersion = version;
    changedRanges.length = 0;
    availableRanges.length = 0;

    if (nextSummary.startTime !== null && nextSummary.endTime !== null) {
      recordAvailableRange(
        {
          endTime: nextSummary.endTime,
          startTime: nextSummary.startTime,
        },
        availableRanges,
      );
    }

    resolveCoveredWaiters();

    return nextSummary;
  };

  return {
    datasetId: options.datasetId,

    async appendFrames(frames) {
      assertActive();

      const nextSummary = await options.store.appendFrames(
        writeOptions(frames),
      );
      assertActive();

      const changedRange = getDetectionFramesRange(frames);
      const retainedSummary = await applyRetention(nextSummary);
      assertActive();

      if (retainedSummary !== nextSummary) {
        return recordAllRangesWrite(retainedSummary);
      }

      if (!changedRange) {
        summary = nextSummary;
        return nextSummary;
      }

      return recordRangeWrite(nextSummary, changedRange);
    },

    async replaceFrames(frames) {
      assertActive();

      const nextSummary = await options.store.putFrames(writeOptions(frames));
      assertActive();
      const retainedSummary = await applyRetention(nextSummary);
      assertActive();

      return recordAllRangesWrite(retainedSummary);
    },

    async clear() {
      assertActive();

      await options.store.clearDataset(options.datasetId);
      assertActive();
      summary = null;
      version += 1;
      allRangeVersion = version;
      changedRanges.length = 0;
      availableRanges.length = 0;
    },

    async loadFrames(startTime, endTime) {
      assertActive();

      const loadedFrames = await options.store.loadFrames({
        datasetId: options.datasetId,
        endTime,
        startTime,
      });
      assertActive();

      return loadedFrames;
    },

    getSummary() {
      return summary ? { ...summary } : null;
    },

    getAvailableRanges() {
      return availableRanges.map((range) => ({ ...range }));
    },

    waitForRange(range) {
      if (destroyed) {
        return Promise.reject(createDestroyedError());
      }

      if (isRangeCovered(range, availableRanges)) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        waiters.push({ range, reject, resolve });
      });
    },

    getVersion(range) {
      if (!range) {
        return version;
      }

      return changedRanges.reduce(
        (rangeVersion, changedRange) =>
          rangesOverlap(range, changedRange)
            ? Math.max(rangeVersion, changedRange.version)
            : rangeVersion,
        allRangeVersion,
      );
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;

      for (const waiter of waiters) {
        waiter.reject(new Error("Detection frame source has been destroyed."));
      }

      waiters.length = 0;
      options.store.destroy?.();
    },
  };

  function assertActive() {
    if (destroyed) {
      throw createDestroyedError();
    }
  }

  async function applyRetention(
    nextSummary: ColdDetectionFrameStoreWriteSummary,
  ) {
    const retention = options.retention;

    if (
      retention === undefined ||
      !shouldApplyWindowRetention(retention) ||
      nextSummary.endTime === null
    ) {
      return nextSummary;
    }

    const retentionWindowSeconds = retention.windowSeconds;

    if (
      retentionWindowSeconds === undefined ||
      !Number.isFinite(retentionWindowSeconds) ||
      retentionWindowSeconds <= 0
    ) {
      throw new Error("retention.windowSeconds must be greater than 0.");
    }

    const retentionStartTime = Math.max(
      0,
      nextSummary.endTime - retentionWindowSeconds,
    );

    if (
      nextSummary.startTime !== null &&
      nextSummary.startTime + RANGE_EPSILON_SECONDS >= retentionStartTime
    ) {
      return nextSummary;
    }

    const retainedFrames = await options.store.loadFrames({
      datasetId: options.datasetId,
      endTime: nextSummary.endTime,
      startTime: retentionStartTime,
    });

    return options.store.putFrames(writeOptions(retainedFrames));
  }

  function resolveCoveredWaiters() {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];

      if (!waiter || !isRangeCovered(waiter.range, availableRanges)) {
        continue;
      }

      waiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

function createDestroyedError() {
  return new Error("Detection frame source has been destroyed.");
}

function shouldApplyWindowRetention(
  retention: DetectionFrameRetentionOptions | undefined,
) {
  return (
    retention?.mode === RetentionMode.PersistWindow ||
    retention?.mode === RetentionMode.MemoryOnly
  );
}

function getDetectionFramesRange(
  frames: readonly DetectionFrame[],
): DetectionFrameSourceVersionRange | null {
  if (frames.length === 0) {
    return null;
  }

  return frames.reduce(
    (range, frame) => ({
      endTime: Math.max(range.endTime, frame.endTime ?? frame.mediaTime),
      startTime: Math.min(range.startTime, frame.mediaTime),
    }),
    {
      endTime: Number.NEGATIVE_INFINITY,
      startTime: Number.POSITIVE_INFINITY,
    },
  );
}

function rangesOverlap(
  left: DetectionFrameSourceVersionRange,
  right: DetectionFrameSourceVersionRange,
) {
  return left.startTime <= right.endTime && right.startTime <= left.endTime;
}

function recordAvailableRange(
  range: DetectionFrameSourceVersionRange,
  availableRanges: AvailableRange[],
) {
  if (range.endTime < range.startTime) {
    return;
  }

  availableRanges.push({ ...range });
  availableRanges.sort((left, right) => left.startTime - right.startTime);

  let writeIndex = 0;

  for (const nextRange of availableRanges) {
    const currentRange = availableRanges[writeIndex - 1];

    if (
      currentRange &&
      nextRange.startTime <= currentRange.endTime + RANGE_EPSILON_SECONDS
    ) {
      currentRange.endTime = Math.max(currentRange.endTime, nextRange.endTime);
      continue;
    }

    availableRanges[writeIndex] = { ...nextRange };
    writeIndex += 1;
  }

  availableRanges.length = writeIndex;
}

function isRangeCovered(
  range: DetectionFrameSourceVersionRange,
  availableRanges: readonly DetectionFrameSourceVersionRange[],
) {
  return availableRanges.some(
    (availableRange) =>
      availableRange.startTime <= range.startTime + RANGE_EPSILON_SECONDS &&
      availableRange.endTime + RANGE_EPSILON_SECONDS >= range.endTime,
  );
}
