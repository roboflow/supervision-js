import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreLoadOptions,
  ColdDetectionFrameStoreWriteOptions,
  ColdDetectionFrameStoreWriteSummary,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  detectionFrameOverlapsRange,
} from "#utils/detection-frames";

const DEFAULT_CHUNK_DURATION_SECONDS = 1;

interface MemoryDetectionDataset {
  readonly chunkDurationSeconds: number;
  readonly frames: readonly DetectionFrame[];
}

export function createMemoryColdDetectionFrameStore(): ColdDetectionFrameStore {
  const datasets = new Map<string, MemoryDetectionDataset>();
  let destroyed = false;

  return {
    async putFrames(options) {
      assertActive();

      const chunkDurationSeconds = resolveChunkDurationSeconds(options);
      const frames = copySortedDetectionFrames(options.frames);

      datasets.set(options.datasetId, {
        chunkDurationSeconds,
        frames,
      });

      return createWriteSummary({
        chunkDurationSeconds,
        datasetId: options.datasetId,
        frames,
      });
    },

    async appendFrames(options) {
      assertActive();

      const existingDataset = datasets.get(options.datasetId);
      const chunkDurationSeconds = resolveChunkDurationSeconds(
        options,
        existingDataset,
      );
      const frames = copySortedDetectionFrames(options.frames);
      const mergedFrames = copySortedDetectionFrames(
        dedupeDetectionFrames([...(existingDataset?.frames ?? []), ...frames]),
      );

      datasets.set(options.datasetId, {
        chunkDurationSeconds,
        frames: mergedFrames,
      });

      return createWriteSummary({
        chunkDurationSeconds,
        datasetId: options.datasetId,
        frames: mergedFrames,
      });
    },

    async loadFrames(options: ColdDetectionFrameStoreLoadOptions) {
      assertActive();

      const dataset = datasets.get(options.datasetId);

      if (!dataset) {
        return [];
      }

      const startTime = Math.max(0, options.startTime);
      const endTime = Math.max(startTime, options.endTime);

      return copySortedDetectionFrames(
        dataset.frames.filter((frame) =>
          detectionFrameOverlapsRange(frame, startTime, endTime),
        ),
      );
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

function createWriteSummary(options: {
  readonly datasetId: string;
  readonly frames: readonly DetectionFrame[];
  readonly chunkDurationSeconds: number;
}): ColdDetectionFrameStoreWriteSummary {
  const firstFrame = options.frames[0];
  const lastFrame = options.frames.at(-1);

  return {
    chunkCount: countChunks(options.frames, options.chunkDurationSeconds),
    chunkDurationSeconds: options.chunkDurationSeconds,
    datasetId: options.datasetId,
    detectionCount: options.frames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    ),
    endTime: lastFrame ? (lastFrame.endTime ?? lastFrame.mediaTime) : null,
    frameCount: options.frames.length,
    startTime: firstFrame?.mediaTime ?? null,
  };
}

function countChunks(
  frames: readonly DetectionFrame[],
  chunkDurationSeconds: number,
) {
  const chunkIndexes = new Set<number>();

  for (const frame of frames) {
    const startIndex = getChunkIndex(frame.mediaTime, chunkDurationSeconds);
    const endIndex =
      frame.endTime === undefined
        ? startIndex
        : Math.max(
            startIndex,
            Math.ceil(frame.endTime / chunkDurationSeconds) - 1,
          );

    for (let index = startIndex; index <= endIndex; index += 1) {
      chunkIndexes.add(index);
    }
  }

  return chunkIndexes.size;
}

function getChunkIndex(mediaTime: number, chunkDurationSeconds: number) {
  return Math.floor(mediaTime / chunkDurationSeconds);
}

function dedupeDetectionFrames(frames: readonly DetectionFrame[]) {
  const dedupedFrames = new Map<string, DetectionFrame>();

  for (const frame of frames) {
    dedupedFrames.set(getDetectionFrameDedupeKey(frame), frame);
  }

  return Array.from(dedupedFrames.values());
}

function getDetectionFrameDedupeKey(frame: DetectionFrame) {
  return frame.frameIndex === undefined
    ? `time:${frame.mediaTime}`
    : `index:${frame.frameIndex}`;
}
