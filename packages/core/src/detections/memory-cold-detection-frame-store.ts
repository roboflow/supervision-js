import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreLoadOptions,
  ColdDetectionFrameStorePruneOptions,
  ColdDetectionFrameStoreWriteOptions,
  ColdDetectionFrameStoreWriteSummary,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  detectionFrameOverlapsRange,
} from "#utils/detection-frames";

const DEFAULT_CHUNK_DURATION_SECONDS = 1;

interface StoredDetectionFrame {
  readonly chunkIndexes: readonly number[];
  readonly frame: DetectionFrame;
}

interface MemoryDetectionDataset {
  readonly chunkDurationSeconds: number;
  readonly frameKeysByChunk: Map<number, Set<string>>;
  readonly framesByKey: Map<string, StoredDetectionFrame>;
  detectionCount: number;
  endTime: number | null;
  startTime: number | null;
}

export function createMemoryColdDetectionFrameStore(): ColdDetectionFrameStore {
  const datasets = new Map<string, MemoryDetectionDataset>();
  let destroyed = false;

  return {
    async putFrames(options) {
      assertActive();

      const dataset = createDataset(resolveChunkDurationSeconds(options));

      upsertFrames(dataset, copySortedDetectionFrames(options.frames));
      datasets.set(options.datasetId, dataset);

      return createWriteSummary(options.datasetId, dataset);
    },

    async appendFrames(options) {
      assertActive();

      const existingDataset = datasets.get(options.datasetId);
      const chunkDurationSeconds = resolveChunkDurationSeconds(
        options,
        existingDataset,
      );
      const dataset = existingDataset ?? createDataset(chunkDurationSeconds);

      upsertFrames(dataset, copySortedDetectionFrames(options.frames));
      datasets.set(options.datasetId, dataset);

      return createWriteSummary(options.datasetId, dataset);
    },

    async loadFrames(options: ColdDetectionFrameStoreLoadOptions) {
      assertActive();

      const dataset = datasets.get(options.datasetId);

      if (!dataset) {
        return [];
      }

      const startTime = Math.max(0, options.startTime);
      const endTime = Math.max(startTime, options.endTime);
      const frameKeys = new Set<string>();
      const startChunkIndex = getChunkIndex(
        startTime,
        dataset.chunkDurationSeconds,
      );
      const endChunkIndex = getChunkIndex(
        endTime,
        dataset.chunkDurationSeconds,
      );

      for (
        let chunkIndex = startChunkIndex;
        chunkIndex <= endChunkIndex;
        chunkIndex += 1
      ) {
        for (const frameKey of dataset.frameKeysByChunk.get(chunkIndex) ?? []) {
          frameKeys.add(frameKey);
        }
      }

      const frames = Array.from(frameKeys)
        .map((frameKey) => dataset.framesByKey.get(frameKey)?.frame)
        .filter(
          (frame): frame is DetectionFrame =>
            frame !== undefined &&
            detectionFrameOverlapsRange(frame, startTime, endTime),
        );

      return copySortedDetectionFrames(frames);
    },

    async pruneFrames(options: ColdDetectionFrameStorePruneOptions) {
      assertActive();

      const dataset = datasets.get(options.datasetId);

      if (!dataset) {
        return createWriteSummary(
          options.datasetId,
          createDataset(DEFAULT_CHUNK_DURATION_SECONDS),
        );
      }

      pruneDatasetBefore(dataset, options.startTime);

      return createWriteSummary(options.datasetId, dataset);
    },

    async clearDataset(datasetId) {
      assertActive();
      datasets.delete(datasetId);
    },

    destroy() {
      destroyed = true;
      datasets.clear();
    },
  };

  function assertActive() {
    if (destroyed) {
      throw new Error("Memory cold detection frame store has been destroyed.");
    }
  }
}

function createDataset(chunkDurationSeconds: number): MemoryDetectionDataset {
  return {
    chunkDurationSeconds,
    detectionCount: 0,
    endTime: null,
    frameKeysByChunk: new Map(),
    framesByKey: new Map(),
    startTime: null,
  };
}

function upsertFrames(
  dataset: MemoryDetectionDataset,
  frames: readonly DetectionFrame[],
) {
  let shouldRecalculateBounds = false;

  for (const frame of frames) {
    const frameKey = getDetectionFrameDedupeKey(frame);
    const existingFrame = dataset.framesByKey.get(frameKey);

    if (existingFrame) {
      removeStoredFrame(dataset, frameKey, existingFrame);
      shouldRecalculateBounds ||= replacementCanShrinkBounds(
        dataset,
        existingFrame.frame,
        frame,
      );
    }

    const chunkIndexes = getFrameChunkIndexes(
      frame,
      dataset.chunkDurationSeconds,
    );

    dataset.framesByKey.set(frameKey, { chunkIndexes, frame });
    dataset.detectionCount += frame.detections.length;
    dataset.startTime = Math.min(
      dataset.startTime ?? frame.mediaTime,
      frame.mediaTime,
    );
    dataset.endTime = Math.max(
      dataset.endTime ?? getFrameEndTime(frame),
      getFrameEndTime(frame),
    );

    for (const chunkIndex of chunkIndexes) {
      const frameKeys = dataset.frameKeysByChunk.get(chunkIndex) ?? new Set();

      frameKeys.add(frameKey);
      dataset.frameKeysByChunk.set(chunkIndex, frameKeys);
    }
  }

  if (shouldRecalculateBounds) {
    recalculateBounds(dataset);
  }
}

function removeStoredFrame(
  dataset: MemoryDetectionDataset,
  frameKey: string,
  storedFrame: StoredDetectionFrame,
) {
  dataset.framesByKey.delete(frameKey);
  dataset.detectionCount -= storedFrame.frame.detections.length;

  for (const chunkIndex of storedFrame.chunkIndexes) {
    const frameKeys = dataset.frameKeysByChunk.get(chunkIndex);

    frameKeys?.delete(frameKey);

    if (frameKeys?.size === 0) {
      dataset.frameKeysByChunk.delete(chunkIndex);
    }
  }
}

/**
 * Drops frames that end before `startTime`.
 *
 * Only chunks at or below the retention boundary are visited, and the new
 * start bound is read from the lowest surviving chunk, so eviction costs work
 * proportional to the evicted range rather than to retained history.
 */
function pruneDatasetBefore(
  dataset: MemoryDetectionDataset,
  startTime: number,
) {
  const boundaryChunkIndex = getChunkIndex(
    Math.max(0, startTime),
    dataset.chunkDurationSeconds,
  );
  let didRemoveFrame = false;

  for (const chunkIndex of Array.from(dataset.frameKeysByChunk.keys())) {
    if (chunkIndex > boundaryChunkIndex) {
      continue;
    }

    for (const frameKey of Array.from(
      dataset.frameKeysByChunk.get(chunkIndex) ?? [],
    )) {
      const storedFrame = dataset.framesByKey.get(frameKey);

      if (!storedFrame || isFrameRetainedFrom(storedFrame.frame, startTime)) {
        continue;
      }

      removeStoredFrame(dataset, frameKey, storedFrame);
      didRemoveFrame = true;
    }
  }

  if (!didRemoveFrame) {
    return;
  }

  if (dataset.framesByKey.size === 0) {
    dataset.startTime = null;
    dataset.endTime = null;
    return;
  }

  // Every frame is registered in the chunk its `mediaTime` falls in, so the
  // earliest retained frame lives in the lowest remaining chunk. Removing
  // frames can only raise the start bound; `endTime` is unchanged because only
  // frames ending before `startTime` were dropped.
  dataset.startTime = getEarliestChunkStartTime(dataset);
}

/**
 * Mirrors `detectionFrameOverlapsRange` so pruning keeps exactly the frames a
 * load from `startTime` would return.
 */
function isFrameRetainedFrom(frame: DetectionFrame, startTime: number) {
  return frame.endTime === undefined
    ? frame.mediaTime >= startTime
    : frame.endTime > startTime;
}

function getEarliestChunkStartTime(dataset: MemoryDetectionDataset) {
  let earliestChunkIndex: number | null = null;

  for (const chunkIndex of dataset.frameKeysByChunk.keys()) {
    if (earliestChunkIndex === null || chunkIndex < earliestChunkIndex) {
      earliestChunkIndex = chunkIndex;
    }
  }

  let startTime: number | null = null;

  for (const frameKey of dataset.frameKeysByChunk.get(
    earliestChunkIndex ?? 0,
  ) ?? []) {
    const storedFrame = dataset.framesByKey.get(frameKey);

    if (!storedFrame) {
      continue;
    }

    startTime = Math.min(
      startTime ?? storedFrame.frame.mediaTime,
      storedFrame.frame.mediaTime,
    );
  }

  return startTime;
}

function replacementCanShrinkBounds(
  dataset: MemoryDetectionDataset,
  previousFrame: DetectionFrame,
  nextFrame: DetectionFrame,
) {
  return (
    (dataset.startTime === previousFrame.mediaTime &&
      nextFrame.mediaTime > previousFrame.mediaTime) ||
    (dataset.endTime === getFrameEndTime(previousFrame) &&
      getFrameEndTime(nextFrame) < getFrameEndTime(previousFrame))
  );
}

function recalculateBounds(dataset: MemoryDetectionDataset) {
  let startTime: number | null = null;
  let endTime: number | null = null;

  for (const { frame } of dataset.framesByKey.values()) {
    startTime = Math.min(startTime ?? frame.mediaTime, frame.mediaTime);
    endTime = Math.max(
      endTime ?? getFrameEndTime(frame),
      getFrameEndTime(frame),
    );
  }

  dataset.startTime = startTime;
  dataset.endTime = endTime;
}

function resolveChunkDurationSeconds(
  options: ColdDetectionFrameStoreWriteOptions,
  existingDataset?: MemoryDetectionDataset,
) {
  const chunkDurationSeconds =
    options.chunkDurationSeconds ??
    existingDataset?.chunkDurationSeconds ??
    DEFAULT_CHUNK_DURATION_SECONDS;

  if (chunkDurationSeconds <= 0) {
    throw new Error("chunkDurationSeconds must be greater than 0.");
  }

  if (
    existingDataset &&
    options.chunkDurationSeconds !== undefined &&
    options.chunkDurationSeconds !== existingDataset.chunkDurationSeconds
  ) {
    throw new Error(
      "chunkDurationSeconds must match the existing detection dataset.",
    );
  }

  return chunkDurationSeconds;
}

function createWriteSummary(
  datasetId: string,
  dataset: MemoryDetectionDataset,
): ColdDetectionFrameStoreWriteSummary {
  return {
    chunkCount: dataset.frameKeysByChunk.size,
    chunkDurationSeconds: dataset.chunkDurationSeconds,
    datasetId,
    detectionCount: dataset.detectionCount,
    endTime: dataset.endTime,
    frameCount: dataset.framesByKey.size,
    startTime: dataset.startTime,
  };
}

function getFrameChunkIndexes(
  frame: DetectionFrame,
  chunkDurationSeconds: number,
) {
  const startIndex = getChunkIndex(frame.mediaTime, chunkDurationSeconds);
  const endIndex = Math.max(
    startIndex,
    Math.ceil(getFrameEndTime(frame) / chunkDurationSeconds) - 1,
  );

  return Array.from(
    { length: endIndex - startIndex + 1 },
    (_, offset) => startIndex + offset,
  );
}

function getFrameEndTime(frame: DetectionFrame) {
  return frame.endTime ?? frame.mediaTime;
}

function getChunkIndex(mediaTime: number, chunkDurationSeconds: number) {
  return Math.floor(mediaTime / chunkDurationSeconds);
}

function getDetectionFrameDedupeKey(frame: DetectionFrame) {
  return frame.frameIndex === undefined
    ? `time:${frame.mediaTime}`
    : `index:${frame.frameIndex}`;
}
