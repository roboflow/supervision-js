import type {
  ColdDetectionFrameStoreWriteSummary,
  DetectionFrameRetentionOptions,
  DetectionFrameSourceVersionRange,
  WritableDetectionFrameSource,
  WritableDetectionFrameSourceOptions,
} from "#types/detection-timeline";
import { DetectionFrameRetentionMode as RetentionMode } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

const RANGE_EPSILON_SECONDS = 1e-6;
const MAX_CHANGED_RANGE_JOURNAL_LENGTH = 512;
const DEFAULT_LIVE_HOLD_SECONDS = 60;

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

type RetentionResult =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "pruned";
      readonly prunedRange: DetectionFrameSourceVersionRange;
      readonly summary: ColdDetectionFrameStoreWriteSummary;
    }
  | {
      readonly kind: "rewritten";
      readonly summary: ColdDetectionFrameStoreWriteSummary;
    };

export function createWritableDetectionFrameSource(
  options: WritableDetectionFrameSourceOptions,
): WritableDetectionFrameSource {
  const liveHoldSeconds = resolveLiveHoldSeconds(options.live?.holdSeconds);
  let summary: ColdDetectionFrameStoreWriteSummary | null = null;
  let latestFrame: DetectionFrame | null = null;
  let heldLiveFrame: DetectionFrame | null = null;
  let version = 0;
  let allRangeVersion = 0;
  let journalFloorVersion = 0;
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
    changedSourceRanges: readonly DetectionFrameSourceVersionRange[],
    prunedRange?: DetectionFrameSourceVersionRange,
  ) => {
    summary = nextSummary;
    version += 1;

    for (const changedRange of changedSourceRanges) {
      changedRanges.push({ ...changedRange, version });
      recordAvailableRange(changedRange, availableRanges);
    }

    if (prunedRange) {
      // Evicting old history is a change to that range only. Recording it
      // alongside the append keeps a buffered timeline patching two small
      // ranges instead of invalidating and rebuilding everything it retains.
      changedRanges.push({ ...prunedRange, version });
      dropAvailableRangesBefore(prunedRange.endTime, availableRanges);
    }

    compactChangedRangeJournal();
    resolveCoveredWaiters();

    return nextSummary;
  };

  const recordAllRangesWrite = (
    nextSummary: ColdDetectionFrameStoreWriteSummary,
  ) => {
    summary = nextSummary;
    version += 1;
    allRangeVersion = version;
    journalFloorVersion = version;
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
      recordLatestFrame(frames);

      return retainAndRecord(nextSummary, getDetectionFrameRanges(frames));
    },

    async appendLiveFrame(frame) {
      assertActive();

      const framesToWrite = createLiveFrameWrite(frame);
      const nextSummary = await options.store.appendFrames(
        writeOptions(framesToWrite),
      );
      assertActive();
      heldLiveFrame = framesToWrite.at(-1) ?? null;
      recordLatestFrame(framesToWrite);

      return retainAndRecord(
        nextSummary,
        getDetectionFrameRanges(framesToWrite),
      );
    },

    async finalizeCoverage(endTime) {
      assertActive();

      if (!Number.isFinite(endTime)) {
        throw new RangeError("finalizeCoverage requires a finite endTime.");
      }

      const frameToFinalize = latestFrame;

      if (
        !frameToFinalize ||
        getFrameEndTime(frameToFinalize) >= endTime ||
        frameToFinalize.mediaTime > endTime
      ) {
        return summary ? { ...summary } : null;
      }

      const finalizedFrame = { ...frameToFinalize, endTime };
      const nextSummary = await options.store.appendFrames(
        writeOptions([finalizedFrame]),
      );
      assertActive();
      latestFrame = finalizedFrame;

      if (
        heldLiveFrame &&
        haveSameDetectionFrameIdentity(heldLiveFrame, finalizedFrame)
      ) {
        heldLiveFrame = finalizedFrame;
      }

      return retainAndRecord(nextSummary, [
        { endTime, startTime: frameToFinalize.mediaTime },
      ]);
    },

    async replaceFrames(frames) {
      assertActive();

      const nextSummary = await options.store.putFrames(writeOptions(frames));
      assertActive();
      latestFrame = null;
      heldLiveFrame = null;
      recordLatestFrame(frames);
      const retention = await applyRetention(nextSummary);
      assertActive();

      return recordAllRangesWrite(
        retention.kind === "unchanged" ? nextSummary : retention.summary,
      );
    },

    async clear() {
      assertActive();

      await options.store.clearDataset(options.datasetId);
      assertActive();
      summary = null;
      latestFrame = null;
      heldLiveFrame = null;
      version += 1;
      allRangeVersion = version;
      journalFloorVersion = version;
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
        Math.max(allRangeVersion, journalFloorVersion),
      );
    },

    getChangesSince(previousVersion, ranges) {
      const relevantVersion = ranges.reduce(
        (rangeVersion, range) =>
          Math.max(
            rangeVersion,
            changedRanges.reduce(
              (changedVersion, changedRange) =>
                rangesOverlap(range, changedRange)
                  ? Math.max(changedVersion, changedRange.version)
                  : changedVersion,
              Math.max(allRangeVersion, journalFloorVersion),
            ),
          ),
        Math.max(allRangeVersion, journalFloorVersion),
      );

      if (relevantVersion <= previousVersion) {
        return {
          ranges: [],
          requiresReload: false,
          version: relevantVersion,
        };
      }

      if (
        previousVersion < allRangeVersion ||
        previousVersion < journalFloorVersion
      ) {
        return {
          ranges: [],
          requiresReload: true,
          version: relevantVersion,
        };
      }

      const changedSourceRanges = changedRanges
        .filter(
          (changedRange) =>
            changedRange.version > previousVersion &&
            ranges.some((range) => rangesOverlap(range, changedRange)),
        )
        .map(({ endTime, startTime }) => ({ endTime, startTime }));

      return {
        ranges: mergeRanges(changedSourceRanges),
        requiresReload: false,
        version: relevantVersion,
      };
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

  /**
   * Applies retention and records the result as an incremental change when the
   * store can prune in place, or as a full rewrite when it cannot.
   */
  async function retainAndRecord(
    nextSummary: ColdDetectionFrameStoreWriteSummary,
    changedSourceRanges: readonly DetectionFrameSourceVersionRange[],
  ) {
    const retention = await applyRetention(nextSummary);
    assertActive();

    if (retention.kind === "rewritten") {
      return recordAllRangesWrite(retention.summary);
    }

    if (retention.kind === "unchanged") {
      if (changedSourceRanges.length === 0) {
        summary = nextSummary;
        return nextSummary;
      }

      return recordRangeWrite(nextSummary, changedSourceRanges);
    }

    forgetFramesBefore(retention.prunedRange.endTime);

    return recordRangeWrite(
      retention.summary,
      changedSourceRanges,
      retention.prunedRange,
    );
  }

  async function applyRetention(
    nextSummary: ColdDetectionFrameStoreWriteSummary,
  ): Promise<RetentionResult> {
    const retention = options.retention;

    if (
      retention === undefined ||
      !shouldApplyWindowRetention(retention) ||
      nextSummary.endTime === null
    ) {
      return { kind: "unchanged" };
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
      return { kind: "unchanged" };
    }

    if (options.store.pruneFrames) {
      return {
        kind: "pruned",
        prunedRange: {
          endTime: retentionStartTime,
          startTime: nextSummary.startTime ?? 0,
        },
        summary: await options.store.pruneFrames({
          datasetId: options.datasetId,
          startTime: retentionStartTime,
        }),
      };
    }

    // Stores without in-place pruning still get a correct retention window,
    // at the cost of reloading and rewriting everything they keep.
    const retainedFrames = await options.store.loadFrames({
      datasetId: options.datasetId,
      endTime: nextSummary.endTime,
      startTime: retentionStartTime,
    });

    return {
      kind: "rewritten",
      summary: await options.store.putFrames(writeOptions(retainedFrames)),
    };
  }

  /**
   * Builds the one or two frames a live append writes: the newest frame held
   * open, plus the previously held frame closed where the newest begins.
   */
  function createLiveFrameWrite(frame: DetectionFrame) {
    const openFrame: DetectionFrame = {
      ...frame,
      endTime: Math.max(
        frame.endTime ?? frame.mediaTime,
        frame.mediaTime + liveHoldSeconds,
      ),
    };
    const heldFrame = heldLiveFrame;

    if (
      !heldFrame ||
      haveSameDetectionFrameIdentity(heldFrame, openFrame) ||
      getFrameEndTime(heldFrame) <= frame.mediaTime ||
      // A live frame that is not strictly newer cannot close its predecessor
      // without collapsing it to a zero-length interval.
      heldFrame.mediaTime >= frame.mediaTime
    ) {
      return [openFrame];
    }

    return [{ ...heldFrame, endTime: frame.mediaTime }, openFrame];
  }

  function recordLatestFrame(frames: readonly DetectionFrame[]) {
    for (const frame of frames) {
      if (!latestFrame || compareDetectionFrames(frame, latestFrame) > 0) {
        latestFrame = frame;
      }
    }
  }

  function forgetFramesBefore(startTime: number) {
    if (latestFrame && getFrameEndTime(latestFrame) < startTime) {
      latestFrame = null;
    }

    if (heldLiveFrame && getFrameEndTime(heldLiveFrame) < startTime) {
      heldLiveFrame = null;
    }
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

  function compactChangedRangeJournal() {
    const overflow = changedRanges.length - MAX_CHANGED_RANGE_JOURNAL_LENGTH;

    if (overflow <= 0) {
      return;
    }

    const removedRanges = changedRanges.splice(0, overflow);
    journalFloorVersion = Math.max(
      journalFloorVersion,
      removedRanges.at(-1)?.version ?? 0,
    );
  }
}

function createDestroyedError() {
  return new Error("Detection frame source has been destroyed.");
}

function resolveLiveHoldSeconds(holdSeconds: number | undefined) {
  if (holdSeconds === undefined) {
    return DEFAULT_LIVE_HOLD_SECONDS;
  }

  if (!Number.isFinite(holdSeconds) || holdSeconds <= 0) {
    throw new RangeError("live.holdSeconds must be greater than 0.");
  }

  return holdSeconds;
}

function getFrameEndTime(frame: DetectionFrame) {
  return frame.endTime ?? frame.mediaTime;
}

function haveSameDetectionFrameIdentity(
  left: DetectionFrame,
  right: DetectionFrame,
) {
  return left.frameIndex === undefined || right.frameIndex === undefined
    ? left.frameIndex === right.frameIndex && left.mediaTime === right.mediaTime
    : left.frameIndex === right.frameIndex;
}

function compareDetectionFrames(left: DetectionFrame, right: DetectionFrame) {
  if (left.mediaTime !== right.mediaTime) {
    return left.mediaTime - right.mediaTime;
  }

  return (left.frameIndex ?? 0) - (right.frameIndex ?? 0);
}

function dropAvailableRangesBefore(
  startTime: number,
  availableRanges: AvailableRange[],
) {
  let writeIndex = 0;

  for (const range of availableRanges) {
    if (range.endTime <= startTime) {
      continue;
    }

    availableRanges[writeIndex] = {
      endTime: range.endTime,
      startTime: Math.max(range.startTime, startTime),
    };
    writeIndex += 1;
  }

  availableRanges.length = writeIndex;
}

function shouldApplyWindowRetention(
  retention: DetectionFrameRetentionOptions | undefined,
) {
  return (
    retention?.mode === RetentionMode.PersistWindow ||
    retention?.mode === RetentionMode.MemoryOnly
  );
}

function getDetectionFrameRanges(
  frames: readonly DetectionFrame[],
): readonly DetectionFrameSourceVersionRange[] {
  return mergeRanges(
    frames.map((frame) => ({
      endTime: frame.endTime ?? frame.mediaTime,
      startTime: frame.mediaTime,
    })),
  );
}

function rangesOverlap(
  left: DetectionFrameSourceVersionRange,
  right: DetectionFrameSourceVersionRange,
) {
  return left.startTime <= right.endTime && right.startTime <= left.endTime;
}

function mergeRanges(
  ranges: readonly DetectionFrameSourceVersionRange[],
): readonly DetectionFrameSourceVersionRange[] {
  const sortedRanges = ranges
    .map((range) => ({ ...range }))
    .sort((left, right) => left.startTime - right.startTime);
  const mergedRanges: Array<{ endTime: number; startTime: number }> = [];

  for (const range of sortedRanges) {
    const previousRange = mergedRanges.at(-1);

    if (
      previousRange &&
      range.startTime <= previousRange.endTime + RANGE_EPSILON_SECONDS
    ) {
      previousRange.endTime = Math.max(previousRange.endTime, range.endTime);
      continue;
    }

    mergedRanges.push({ ...range });
  }

  return mergedRanges;
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
