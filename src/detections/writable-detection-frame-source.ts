import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionFrameSourceVersionRange,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
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
      const nextSummary = await options.store.appendFrames(
        writeOptions(frames),
      );
      const changedRange = getDetectionFramesRange(frames);

      return changedRange
        ? recordRangeWrite(nextSummary, changedRange)
        : nextSummary;
    },

    async replaceFrames(frames) {
      return recordAllRangesWrite(
        await options.store.putFrames(writeOptions(frames)),
      );
    },

    async clear() {
      await options.store.clearDataset(options.datasetId);
      summary = null;
      version += 1;
      allRangeVersion = version;
      changedRanges.length = 0;
      availableRanges.length = 0;
    },

    loadFrames(startTime, endTime) {
      return options.store.loadFrames({
        datasetId: options.datasetId,
        endTime,
        startTime,
      });
    },

    getSummary() {
      return summary ? { ...summary } : null;
    },

    getAvailableRanges() {
      return availableRanges.map((range) => ({ ...range }));
    },

    waitForRange(range) {
      if (destroyed) {
        return Promise.reject(
          new Error("Detection frame source has been destroyed."),
        );
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
