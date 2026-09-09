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
  readonly requiredForCoverage: boolean;
  readonly source: DetectionFrameSource;
  readonly sync?: DetectionFrameSelectionOptions;
}

interface LoadedCompositeSource extends NormalizedCompositeSource {
  readonly frames: readonly DetectionFrame[];
}

interface GridCompositeSource extends LoadedCompositeSource {
  readonly framesByIndex: ReadonlyMap<number, DetectionFrame>;
}

interface GridSlot {
  readonly frameIndex?: number;
  readonly mediaTime: number;
}

interface IndexedGridSlot extends GridSlot {
  readonly frameIndex: number;
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
          .filter((source) => source.requiredForCoverage)
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
        requiredForCoverage: entry.requiredForCoverage !== false,
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
      coordinateSpace,
    );

    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

/**
 * One composed frame per inference grid index the children wrote, and one per
 * child frame that carries no index.
 *
 * Children are paired on the index their producer labelled, and the composed
 * frame keeps the media time they reported for it. `frameRate` states the grid
 * a producer was asked for, not the one the clip plays at, and a slower clip
 * answers consecutive indexes with the same decoded sample: a timeline placed
 * by that rate then asks for a time two indexes share, which can only ever
 * reach one of them and leaves the other's detections stranded. Pairing on the
 * index reaches every one and keeps each frame's detections on the frame they
 * were computed for.
 *
 * A frame carrying no index has no grid position to be paired on, so it
 * composes at its own media time, and every child answers there with whatever
 * it has standing. That is how a child sitting on a grid index keeps its
 * detections on screen while an unindexed frame from another child overlaps it.
 * The composed frame carries no index of its own, because only part of what it
 * holds sits on the grid.
 */
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

  const gridSources = sources.map((source) => ({
    ...source,
    framesByIndex: indexFramesByFrameIndex(source, options),
  }));
  const indexedSlots = mergeGridSlots(gridSources);

  if (indexedSlots.length === 0) {
    return null;
  }

  const gridStep = measureGridStep(indexedSlots) ?? 1 / frameRate;
  const slots: readonly GridSlot[] = [
    ...indexedSlots,
    ...mergeUnindexedGridSlots(gridSources, indexedSlots),
  ];
  const frames: DetectionFrame[] = [];

  for (const slot of slots) {
    if (slot.mediaTime < startTime || slot.mediaTime >= endTime) {
      continue;
    }

    const frame = composeFrameAtGridSlot(
      gridSources,
      slot,
      Math.min(slot.mediaTime + gridStep, endTime),
      {
        ...options,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      },
      coordinateSpace,
    );

    if (frame) {
      frames.push(frame);
    }
  }

  return frames.sort((left, right) => left.mediaTime - right.mediaTime);
}

function indexFramesByFrameIndex(
  source: LoadedCompositeSource,
  options: DetectionFrameSelectionOptions,
): ReadonlyMap<number, DetectionFrame> {
  const framesByIndex = new Map<number, DetectionFrame>();
  const selectionMode = source.sync?.selectionMode ?? options.selectionMode;

  if (selectionMode !== DetectionFrameSelectionMode.NearestFrameIndex) {
    return framesByIndex;
  }

  for (const frame of source.frames) {
    if (frame.frameIndex !== undefined) {
      framesByIndex.set(frame.frameIndex, frame);
    }
  }

  return framesByIndex;
}

/**
 * Where each grid index sits in the media, taken as the earliest time any child
 * reported for it. Children on one grid watched the same source frame, and the
 * earliest of their answers is where that frame starts.
 */
function mergeGridSlots(
  sources: readonly GridCompositeSource[],
): IndexedGridSlot[] {
  const mediaTimes = new Map<number, number>();

  for (const source of sources) {
    for (const [frameIndex, frame] of source.framesByIndex) {
      const mediaTime = mediaTimes.get(frameIndex);

      if (mediaTime === undefined || frame.mediaTime < mediaTime) {
        mediaTimes.set(frameIndex, frame.mediaTime);
      }
    }
  }

  return [...mediaTimes]
    .map(([frameIndex, mediaTime]) => ({ frameIndex, mediaTime }))
    .sort((left, right) => left.frameIndex - right.frameIndex);
}

/**
 * Where a frame no producer labelled sits: at the media time it reported, which
 * is the only handle it has.
 */
function mergeUnindexedGridSlots(
  sources: readonly GridCompositeSource[],
  indexedSlots: readonly IndexedGridSlot[],
): GridSlot[] {
  const indexedSlotTimes = new Set(indexedSlots.map((slot) => slot.mediaTime));
  const mediaTimes = new Set<number>();

  for (const source of sources) {
    for (const frame of source.frames) {
      if (
        frame.frameIndex === undefined &&
        !indexedSlotTimes.has(frame.mediaTime)
      ) {
        mediaTimes.add(frame.mediaTime);
      }
    }
  }

  return [...mediaTimes]
    .sort((left, right) => left - right)
    .map((mediaTime) => ({ mediaTime }));
}

/**
 * How long one grid index stands, read off the slots across the widest index
 * span they cover. A clip whose real rate differs from `frameRate` would end
 * every composed frame a little short or a little long of where the next index
 * is due, and that error accumulates for as long as the clip plays.
 */
function measureGridStep(gridSlots: readonly IndexedGridSlot[]) {
  const firstSlot = gridSlots[0];
  const lastSlot = gridSlots[gridSlots.length - 1];
  const indexSpan = lastSlot.frameIndex - firstSlot.frameIndex;
  const step = (lastSlot.mediaTime - firstSlot.mediaTime) / indexSpan;

  return indexSpan > 0 && Number.isFinite(step) && step > 0 ? step : undefined;
}

function composeFrameAtGridSlot(
  sources: readonly GridCompositeSource[],
  slot: GridSlot,
  endTime: number,
  options: DetectionFrameSelectionOptions,
  coordinateSpace?: DetectionCoordinateSpace,
): DetectionFrame | undefined {
  const detections: Detection[] = [];

  for (const source of sources) {
    const activeFrame = selectGridSlotFrame(source, slot, options);

    if (!activeFrame) {
      continue;
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
    frameIndex: slot.frameIndex,
    mediaTime: slot.mediaTime,
    // Children were projected before composition, so a composed frame is
    // already in the coordinate space the renderer presents.
    ...(coordinateSpace ? { coordinateSpace } : {}),
  };
}

/**
 * What one child has to say at a slot.
 *
 * A child that wrote this index answers with the frame it wrote for it, however
 * far its own media time sits from the slot's. A child on the grid that never
 * wrote this index answers only with a frame of its own that carries no index
 * and is standing here: its neighbouring indexes describe media the slot is not
 * on, and lending one of those would put those detections on a frame they were
 * not computed for.
 */
function selectGridSlotFrame(
  source: GridCompositeSource,
  slot: GridSlot,
  options: DetectionFrameSelectionOptions,
): DetectionFrame | undefined {
  const pairedFrame =
    slot.frameIndex === undefined
      ? undefined
      : source.framesByIndex.get(slot.frameIndex);

  if (pairedFrame) {
    return pairedFrame;
  }

  const selectedFrame = selectDetectionFrame(source.frames, slot.mediaTime, {
    ...options,
    ...source.sync,
  });
  const isGridChildAtIndexedSlot =
    source.framesByIndex.size > 0 && slot.frameIndex !== undefined;

  return isGridChildAtIndexedSlot && selectedFrame?.frameIndex !== undefined
    ? undefined
    : selectedFrame;
}

function composeFrameAtTime(
  sources: readonly LoadedCompositeSource[],
  mediaTime: number,
  endTime: number,
  options: DetectionFrameSelectionOptions,
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
    frameIndex: resolveComposedFrameIndex(activeFrameIndexes) ?? undefined,
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
