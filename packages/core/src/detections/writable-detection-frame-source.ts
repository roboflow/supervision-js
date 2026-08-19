import type {
  ColdDetectionFrameStoreWriteSummary,
  DetectionFrameRetentionOptions,
  DetectionFrameSourceVersionRange,
  LiveWritableDetectionFrameSource,
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
): LiveWritableDetectionFrameSource {
  const liveHoldSeconds = resolveLiveHoldSeconds(options.live?.holdSeconds);
  let summary: ColdDetectionFrameStoreWriteSummary | null = null;
  let latestFrame: DetectionFrame | null = null;
  let heldLiveFrame: DetectionFrame | null = null;
  // Newest live `mediaTime` accepted so far. It survives retention so a late
  // result cannot reopen coverage the source already moved past.
  let liveFrontierTime: number | null = null;
  // Newest media time actually covered by producer-declared data. Live frames
  // are written with a synthetic hold end, so the summary end time cannot be
  // used to place the retention window without pushing it into the future.
  let coverageFrontierTime: number | null = null;
  let writeQueue: Promise<unknown> = Promise.resolve();
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

      return enqueueWrite(async () => {
        const nextSummary = await options.store.appendFrames(
          writeOptions(frames),
        );
        assertActive();
        recordLatestFrame(frames);
        recordCoverageFrontierFromFrames(frames);

        return retainAndRecord(nextSummary, getDetectionFrameRanges(frames));
      });
    },

    async appendLiveFrame(frame) {
      assertActive();

      return enqueueWrite(async () => {
        if (isStaleLiveFrame(frame)) {
          // A result older than the live frontier no longer describes what is
          // on screen. Writing it would reopen coverage the source already
          // closed, so the newest causal frame simply wins.
          return summary ? { ...summary } : createEmptyWriteSummary();
        }

        const framesToWrite = createLiveFrameWrite(frame);
        const nextSummary = await options.store.appendFrames(
          writeOptions(framesToWrite),
        );
        assertActive();
        heldLiveFrame = framesToWrite.at(-1) ?? null;
        liveFrontierTime = Math.max(
          liveFrontierTime ?? frame.mediaTime,
          frame.mediaTime,
        );
        recordLatestFrame(framesToWrite);
        // The hold end is a placeholder for "still current", not covered data.
        recordCoverageFrontier(getFrameEndTime(frame));

        return retainAndRecord(
          nextSummary,
          getDetectionFrameRanges(framesToWrite),
        );
      });
    },

    async finalizeCoverage(endTime) {
      assertActive();

      if (!Number.isFinite(endTime)) {
        throw new RangeError("finalizeCoverage requires a finite endTime.");
      }

      return enqueueWrite(async () => {
        const frameToFinalize = latestFrame;

        if (
          !frameToFinalize ||
          // A frame that starts at or after the end of media cannot describe a
          // non-empty terminal interval.
          frameToFinalize.mediaTime >= endTime ||
          getFrameEndTime(frameToFinalize) === endTime
        ) {
          return summary ? { ...summary } : null;
        }

        const previousEndTime = getFrameEndTime(frameToFinalize);
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

        coverageFrontierTime = endTime;

        const finalSummary = await retainAndRecord(nextSummary, [
          {
            endTime: Math.max(endTime, previousEndTime),
            startTime: frameToFinalize.mediaTime,
          },
        ]);

        // Closing a held live frame shortens coverage. Reported availability
        // has to shrink with it, or a playback gate would still believe the
        // source covers time past the end of media.
        clipAvailableRangesAfter(endTime);

        return finalSummary;
      });
    },

    async replaceFrames(frames) {
      assertActive();

      return enqueueWrite(async () => {
        const nextSummary = await options.store.putFrames(writeOptions(frames));
        assertActive();
        latestFrame = null;
        heldLiveFrame = null;
        liveFrontierTime = null;
        coverageFrontierTime = null;
        recordLatestFrame(frames);
        recordCoverageFrontierFromFrames(frames);
        const retention = await applyRetention(nextSummary);
        assertActive();

        return recordAllRangesWrite(
          retention.kind === "unchanged" ? nextSummary : retention.summary,
        );
      });
    },

    async clear() {
      assertActive();

      await enqueueWrite(async () => {
        await options.store.clearDataset(options.datasetId);
        assertActive();
        summary = null;
        latestFrame = null;
        heldLiveFrame = null;
        liveFrontierTime = null;
        coverageFrontierTime = null;
        version += 1;
        allRangeVersion = version;
        journalFloorVersion = version;
        changedRanges.length = 0;
        availableRanges.length = 0;
      });
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

      return getRangeVersion(range);
    },

    getChangesSince(previousVersion, ranges) {
      const relevantVersion = ranges.reduce(
        (rangeVersion, range) => Math.max(rangeVersion, getRangeVersion(range)),
        getReloadFloorVersion(),
      );

      if (relevantVersion <= previousVersion) {
        return {
          ranges: [],
          requiresReload: false,
          version: relevantVersion,
        };
      }

      if (previousVersion < getReloadFloorVersion()) {
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
   * Oldest version the journal can still describe incrementally. Anything
   * older has to reload, because replacement, clearing, or journal compaction
   * dropped the intervening changes.
   */
  function getReloadFloorVersion() {
    return Math.max(allRangeVersion, journalFloorVersion);
  }

  function getRangeVersion(range: DetectionFrameSourceVersionRange) {
    return changedRanges.reduce(
      (rangeVersion, changedRange) =>
        rangesOverlap(range, changedRange)
          ? Math.max(rangeVersion, changedRange.version)
          : rangeVersion,
      getReloadFloorVersion(),
    );
  }

  /**
   * Runs mutating writes one at a time.
   *
   * Every write reads the held live frame, the latest frame, and the coverage
   * frontier before it awaits storage. Without serialization two concurrent
   * live appends would both observe the pre-write state and both stay open,
   * which is exactly the stale overlay live semantics exist to prevent.
   */
  function enqueueWrite<TResult>(
    run: () => Promise<TResult>,
  ): Promise<TResult> {
    const result = writeQueue.then(() => {
      assertActive();

      return run();
    });

    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  function isStaleLiveFrame(frame: DetectionFrame) {
    if (liveFrontierTime === null || frame.mediaTime > liveFrontierTime) {
      return false;
    }

    // A frame at the frontier that shares the held frame's identity is a
    // revision of the current result, not a late duplicate of an older one.
    return !(
      heldLiveFrame && haveSameDetectionFrameIdentity(heldLiveFrame, frame)
    );
  }

  function recordCoverageFrontier(endTime: number) {
    coverageFrontierTime =
      coverageFrontierTime === null
        ? endTime
        : Math.max(coverageFrontierTime, endTime);
  }

  function recordCoverageFrontierFromFrames(frames: readonly DetectionFrame[]) {
    for (const frame of frames) {
      recordCoverageFrontier(getFrameEndTime(frame));
    }
  }

  function clipAvailableRangesAfter(endTime: number) {
    let writeIndex = 0;

    for (const range of availableRanges) {
      if (range.startTime >= endTime) {
        continue;
      }

      availableRanges[writeIndex] = {
        endTime: Math.min(range.endTime, endTime),
        startTime: range.startTime,
      };
      writeIndex += 1;
    }

    availableRanges.length = writeIndex;
  }

  function createEmptyWriteSummary(): ColdDetectionFrameStoreWriteSummary {
    return {
      chunkCount: 0,
      chunkDurationSeconds: options.chunkDurationSeconds ?? 1,
      datasetId: options.datasetId,
      detectionCount: 0,
      endTime: null,
      frameCount: 0,
      startTime: null,
    };
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

    // Place the window against real producer coverage. A live frame held open
    // for `holdSeconds` reports a summary end far in the future, and anchoring
    // eviction there would evict everything the producer just wrote.
    const retentionStartTime = Math.max(
      0,
      Math.min(
        coverageFrontierTime ?? nextSummary.endTime,
        nextSummary.endTime,
      ) - retentionWindowSeconds,
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

    // Stale results are rejected before this point, so a held frame that is
    // neither the same frame nor already closed always ends strictly later.
    if (
      !heldFrame ||
      haveSameDetectionFrameIdentity(heldFrame, openFrame) ||
      getFrameEndTime(heldFrame) <= frame.mediaTime
    ) {
      return [openFrame];
    }

    return [{ ...heldFrame, endTime: frame.mediaTime }, openFrame];
  }

  function recordLatestFrame(frames: readonly DetectionFrame[]) {
    for (const frame of frames) {
      if (
        !latestFrame ||
        compareDetectionFrames(frame, latestFrame) > 0 ||
        // A write that shares the tracked frame's identity replaces its stored
        // record. Keeping the superseded contents here would let a later
        // `finalizeCoverage` write them back over the revision.
        haveSameDetectionFrameIdentity(frame, latestFrame)
      ) {
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
