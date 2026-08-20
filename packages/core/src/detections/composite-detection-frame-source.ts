import { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
import {
  DetectionFrameSelectionMode,
  type CompositeDetectionFrameSourceEntry,
  type CompositeDetectionFrameSourceOptions,
  type DetectionFrameLoadOptions,
  type DetectionFrameSource,
  type DetectionFrameSourceVersionRange,
  type DetectionFrameSelectionOptions,
} from "#types/detection-timeline";
import type {
  Detection,
  DetectionCoordinateSpace,
  DetectionFrame,
} from "#types/detections";
import {
  copySortedDetectionFrames,
  selectDetectionFrame,
} from "#utils/detection-frames";
import { projectDetectionFrames } from "#utils/detection-projection";

interface NormalizedCompositeSource {
  readonly declarationIndex: number;
  readonly id: string;
  readonly order: number;
  readonly requiredForPlayback: boolean;
  readonly source: DetectionFrameSource;
  readonly sync?: DetectionFrameSelectionOptions;
}

interface LoadedCompositeSource extends NormalizedCompositeSource {
  readonly frames: readonly DetectionFrame[];
}

export function createCompositeDetectionFrameSource(
  options: CompositeDetectionFrameSourceOptions,
): DetectionFrameSource {
  const sources = normalizeCompositeSources(options.sources);

  return {
    async loadFrames(
      startTime: number,
      endTime: number,
      loadOptions?: DetectionFrameLoadOptions,
    ) {
      const target = loadOptions?.coordinateSpace;
      const loadedSources = await Promise.all(
        sources.map(async (source) => {
          const frames = copySortedDetectionFrames(
            await source.source.loadFrames(startTime, endTime, loadOptions),
          );

          return {
            ...source,
            // Composition flattens child detections into one frame, which can
            // only carry one coordinate space. Each child is projected here,
            // while its own `coordinateSpace` is still attached to its own
            // detections, so children inferred at different sizes compose
            // correctly. Masks keep their intrinsic dimensions.
            frames: target ? projectDetectionFrames(frames, target) : frames,
          };
        }),
      );

      if (
        options.selectionMode === DetectionFrameSelectionMode.NearestFrameIndex
      ) {
        const nearestFrames = composeNearestFrameIndexFrames(
          loadedSources,
          startTime,
          endTime,
          options,
          target,
        );

        if (nearestFrames) {
          return nearestFrames;
        }
      }

      return composeIntervalFrames(
        loadedSources,
        startTime,
        endTime,
        options,
        target,
      );
    },

    async waitForRange(range) {
      await Promise.all(
        sources
          .filter((source) => source.requiredForPlayback)
          .map((source) => source.source.waitForRange?.(range)),
      );
    },

    getAvailableRanges() {
      return mergeRanges(
        sources.flatMap((source) => source.source.getAvailableRanges?.() ?? []),
      );
    },

    getVersion(range) {
      return sources.reduce(
        (version, source) => version + (source.source.getVersion?.(range) ?? 0),
        0,
      );
    },

    destroy() {
      for (const source of sources) {
        source.source.destroy?.();
      }
    },
  };
}

function normalizeCompositeSources(
  entries: readonly CompositeDetectionFrameSourceEntry[],
): readonly NormalizedCompositeSource[] {
  const sourceIds = new Set<string>();

  return entries
    .map((entry, declarationIndex) => {
      if (sourceIds.has(entry.id)) {
        throw new Error(`Duplicate detection source id: ${entry.id}.`);
      }

      sourceIds.add(entry.id);

      const inputCount = [
        entry.frames !== undefined,
        entry.source !== undefined,
      ].filter(Boolean).length;

      if (inputCount !== 1) {
        throw new Error(
          `Detection source ${entry.id} must provide exactly one input: frames or source.`,
        );
      }

      return {
        declarationIndex,
        id: entry.id,
        order: entry.order ?? 0,
        requiredForPlayback: entry.requiredForPlayback !== false,
        source:
          entry.source ?? createArrayDetectionFrameSource(entry.frames ?? []),
        sync: entry.sync,
      };
    })
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.declarationIndex - right.declarationIndex,
    );
}

function composeIntervalFrames(
  sources: readonly LoadedCompositeSource[],
  startTime: number,
  endTime: number,
  options: DetectionFrameSelectionOptions,
  coordinateSpace?: DetectionCoordinateSpace,
) {
  const boundaryTimes = new Set<number>([startTime]);

  for (const source of sources) {
    for (const frame of source.frames) {
      if (frame.mediaTime >= startTime && frame.mediaTime < endTime) {
        boundaryTimes.add(frame.mediaTime);
      }

      if (
        frame.endTime !== undefined &&
        frame.endTime > startTime &&
        frame.endTime < endTime
      ) {
        boundaryTimes.add(frame.endTime);
      }
    }
  }

  const sortedBoundaryTimes = [...boundaryTimes].sort(
    (left, right) => left - right,
  );
  const frames: DetectionFrame[] = [];

  for (const [boundaryIndex, mediaTime] of sortedBoundaryTimes.entries()) {
    if (mediaTime < startTime || mediaTime >= endTime) {
      continue;
    }

    const nextBoundaryTime = sortedBoundaryTimes[boundaryIndex + 1] ?? endTime;
    const endTimeForFrame = Math.min(nextBoundaryTime, endTime);
    const frame = composeFrameAtTime(
      sources,
      mediaTime,
      endTimeForFrame,
      { ...options, selectionMode: DetectionFrameSelectionMode.Interval },
      undefined,
      coordinateSpace,
    );

    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

function composeNearestFrameIndexFrames(
  sources: readonly LoadedCompositeSource[],
  startTime: number,
  endTime: number,
  options: DetectionFrameSelectionOptions,
  coordinateSpace?: DetectionCoordinateSpace,
) {
  const frameRate = options.frameRate;

  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) {
    return null;
  }

  const indexedFrames = sources.flatMap((source) =>
    source.frames.filter((frame) => frame.frameIndex !== undefined),
  );
  const firstIndexedFrame = indexedFrames[0];

  if (!firstIndexedFrame || firstIndexedFrame.frameIndex === undefined) {
    return null;
  }

  const originTime =
    options.frameIndexOriginTime ??
    firstIndexedFrame.mediaTime - firstIndexedFrame.frameIndex / frameRate;
  const frameIndexes = [
    ...new Set(
      indexedFrames
        .map((frame) => frame.frameIndex)
        .filter((frameIndex): frameIndex is number => frameIndex !== undefined),
    ),
  ].sort((left, right) => left - right);
  const frames: DetectionFrame[] = [];

  for (const frameIndex of frameIndexes) {
    const mediaTime = originTime + frameIndex / frameRate;

    if (mediaTime < startTime || mediaTime >= endTime) {
      continue;
    }

    const frame = composeFrameAtTime(
      sources,
      mediaTime,
      Math.min(mediaTime + 1 / frameRate, endTime),
      {
        ...options,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      },
      frameIndex,
      coordinateSpace,
    );

    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

function composeFrameAtTime(
  sources: readonly LoadedCompositeSource[],
  mediaTime: number,
  endTime: number,
  options: DetectionFrameSelectionOptions,
  frameIndex?: number,
  coordinateSpace?: DetectionCoordinateSpace,
): DetectionFrame | undefined {
  const detections: Detection[] = [];
  const activeFrameIndexes: number[] = [];

  for (const source of sources) {
    const activeFrame = selectDetectionFrame(source.frames, mediaTime, {
      ...options,
      ...source.sync,
    });

    if (!activeFrame) {
      continue;
    }

    if (activeFrame.frameIndex !== undefined) {
      activeFrameIndexes.push(activeFrame.frameIndex);
    }

    activeFrame.detections.forEach((detection, sourceDetectionIndex) => {
      detections.push(
        copyDetectionWithSource(detection, source.id, sourceDetectionIndex),
      );
    });
  }

  if (detections.length === 0) {
    return undefined;
  }

  return {
    detections,
    endTime,
    frameIndex:
      frameIndex ?? resolveComposedFrameIndex(activeFrameIndexes) ?? undefined,
    mediaTime,
    // Children were projected before composition, so a composed frame is
    // already in the coordinate space the renderer presents.
    ...(coordinateSpace ? { coordinateSpace } : {}),
  };
}

function copyDetectionWithSource(
  detection: Detection,
  sourceId: string,
  sourceDetectionIndex: number,
): Detection {
  return {
    ...detection,
    mask: detection.mask ? { ...detection.mask } : undefined,
    metadata: detection.metadata ? { ...detection.metadata } : undefined,
    rect: detection.rect ? { ...detection.rect } : undefined,
    sourceDetectionIndex,
    sourceId,
  };
}

function resolveComposedFrameIndex(frameIndexes: readonly number[]) {
  if (frameIndexes.length === 0) {
    return undefined;
  }

  const firstFrameIndex = frameIndexes[0];

  return frameIndexes.every((frameIndex) => frameIndex === firstFrameIndex)
    ? firstFrameIndex
    : undefined;
}

function mergeRanges(
  ranges: readonly DetectionFrameSourceVersionRange[],
): readonly DetectionFrameSourceVersionRange[] {
  const sortedRanges = [...ranges].sort(
    (left, right) => left.startTime - right.startTime,
  );
  const mergedRanges: DetectionFrameSourceVersionRange[] = [];

  for (const range of sortedRanges) {
    const lastRange = mergedRanges.at(-1);

    if (!lastRange || range.startTime > lastRange.endTime) {
      mergedRanges.push({ ...range });
      continue;
    }

    mergedRanges[mergedRanges.length - 1] = {
      startTime: lastRange.startTime,
      endTime: Math.max(lastRange.endTime, range.endTime),
    };
  }

  return mergedRanges;
}
