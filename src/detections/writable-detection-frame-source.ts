import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionFrameSourceVersionRange,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

interface VersionedRange extends DetectionFrameSourceVersionRange {
  readonly version: number;
}

export function createWritableDetectionFrameSource(options: {
  readonly store: ColdDetectionFrameStore;
  readonly datasetId: string;
  readonly chunkDurationSeconds?: number;
}): WritableDetectionFrameSource {
  let summary: ColdDetectionFrameStoreWriteSummary | null = null;
  let version = 0;
  let allRangeVersion = 0;
  const changedRanges: VersionedRange[] = [];

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

    return nextSummary;
  };

  const recordAllRangesWrite = (
    nextSummary: ColdDetectionFrameStoreWriteSummary,
  ) => {
    summary = nextSummary;
    version += 1;
    allRangeVersion = version;
    changedRanges.length = 0;

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
      options.store.destroy?.();
    },
  };
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
