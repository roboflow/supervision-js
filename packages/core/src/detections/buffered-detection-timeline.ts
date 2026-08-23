import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
  type DetectionBufferOptions,
  type DetectionBufferPrepareOptions,
  type DetectionBufferState,
  type DetectionFrameSource,
  type DetectionFrameSourceVersionRange,
  type DetectionTimelineContext,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  detectionFrameOverlapsRange,
  selectDetectionFrame,
} from "#utils/detection-frames";

const DEFAULT_BUFFER_AHEAD_SECONDS = 5;
const DEFAULT_BUFFER_BEHIND_SECONDS = 0.5;
/**
 * Share of the ahead window that must still lead the playhead when the next
 * window is fetched.
 *
 * A window fetched only once the playhead reaches its end leaves the playhead
 * uncovered for exactly as long as the fetch takes, every time, so annotations
 * blink out once per window at a steady rate. Fetching while the current window
 * still answers means the load lands behind a picture that never lost them.
 */
const REFILL_LEAD_FRACTION = 0.5;
const MIN_REFILL_LEAD_SECONDS = 1;

interface DetectionBufferLoadPlan {
  readonly endTime: number;
  readonly sourceRanges: readonly DetectionFrameSourceVersionRange[];
  readonly startTime: number;
}

const bufferedFrameSnapshots = new WeakMap<
  BufferedDetectionTimeline,
  () => readonly DetectionFrame[]
>();

/**
 * Returns the timeline-owned hot-buffer snapshot without copying it.
 *
 * This is an internal platform-adapter fast path. Public callers should use
 * `getBufferedFrames()`, which preserves the existing defensive-copy contract.
 */
export function getBufferedDetectionTimelineFrameSnapshot(
  timeline: BufferedDetectionTimeline,
): readonly DetectionFrame[] {
  return (
    bufferedFrameSnapshots.get(timeline)?.() ?? timeline.getBufferedFrames()
  );
}

export function createBufferedDetectionTimeline(
  options: {
    readonly source: DetectionFrameSource;
  } & DetectionBufferOptions,
): BufferedDetectionTimeline {
  const bufferAheadSeconds =
    options.bufferAheadSeconds ?? DEFAULT_BUFFER_AHEAD_SECONDS;
  const bufferBehindSeconds =
    options.bufferBehindSeconds ?? DEFAULT_BUFFER_BEHIND_SECONDS;
  const refreshIntervalSeconds =
    options.refreshIntervalSeconds === undefined
      ? null
      : Math.max(0, options.refreshIntervalSeconds);
  const playbackGate = options.playbackGate;
  const refillLeadSeconds =
    bufferAheadSeconds <= 0
      ? 0
      : Math.min(
          bufferAheadSeconds,
          Math.max(
            MIN_REFILL_LEAD_SECONDS,
            bufferAheadSeconds * REFILL_LEAD_FRACTION,
          ),
        );

  let buffer: DetectionFrame[] = [];
  let state = createIdleDetectionBufferState();
  let destroyed = false;
  let loadId = 0;
  let bufferedSourceVersion: number | null = null;
  let bufferedVersionRange: {
    readonly startTime: number;
    readonly endTime: number;
  } | null = null;
  let timelineContext: DetectionTimelineContext = {
    duration: null,
    loop: false,
  };
  let inFlight:
    | {
        readonly id: number;
        readonly startTime: number;
        readonly endTime: number;
        /** Playhead the window was anchored on, on the comparable clock. */
        readonly mediaTime: number;
        readonly sourceVersion: number;
        readonly promise: Promise<void>;
      }
    | undefined;
  let incrementalRefresh: Promise<void> | undefined;
  let pendingPrefetch:
    { readonly loadId: number; readonly mediaTime: number } | undefined;
  let prefetchPump: Promise<void> | undefined;
  const listeners = new Set<() => void>();

  const notifyBufferChanged = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const getSourceVersion = (
    ranges?: readonly DetectionFrameSourceVersionRange[],
  ) => {
    if (!ranges) {
      return options.source.getVersion?.() ?? 0;
    }

    return ranges.reduce(
      (version, range) =>
        Math.max(version, options.source.getVersion?.(range) ?? 0),
      0,
    );
  };
  const isBufferFresh = () =>
    bufferedVersionRange !== null &&
    bufferedSourceVersion === getSourceVersion(getBufferedSourceRanges());

  const getLoadRange = (mediaTime: number) => {
    const comparableMediaTime = getComparableMediaTime(mediaTime);
    const startTime = comparableMediaTime - bufferBehindSeconds;
    const endTime = comparableMediaTime + bufferAheadSeconds;

    return createLoadPlan(startTime, endTime);
  };

  const loadWindow = (mediaTime: number) => {
    const comparableMediaTime = getComparableMediaTime(mediaTime);
    const { endTime, sourceRanges, startTime } = getLoadRange(mediaTime);
    const versionRange = { endTime, startTime };
    const sourceVersion = getSourceVersion(sourceRanges);

    if (inFlight && inFlight.sourceVersion === sourceVersion) {
      if (
        rangeContains(inFlight.startTime, inFlight.endTime, startTime, endTime)
      ) {
        return inFlight.promise;
      }

      // A load already in flight that still covers where the playhead is going
      // answers the same question a fresh one would. Playback moves the anchor
      // every frame, so a window superseded on anchor equality alone is
      // superseded on every frame of its own flight: the fetch is thrown away
      // and the wait restarts, which is how a gap grows instead of closing.
      if (
        refillLeadSeconds > 0 &&
        comparableMediaTime >= inFlight.mediaTime &&
        comparableMediaTime + refillLeadSeconds <=
          inFlight.mediaTime + bufferAheadSeconds
      ) {
        return inFlight.promise;
      }
    }

    const currentLoadId = loadId + 1;

    loadId = currentLoadId;
    state = {
      ...state,
      errorMessage: null,
      requestedEndTime: endTime,
      requestedStartTime: startTime,
      status: DetectionBufferStatus.Loading,
    };

    const promise = Promise.all(
      sourceRanges.map((range) =>
        options.source.loadFrames(range.startTime, range.endTime),
      ),
    )
      .then((frameRanges) => {
        if (destroyed || currentLoadId !== loadId) {
          return;
        }

        const committedSourceVersion = getSourceVersion(sourceRanges);
        const loadedBuffer = copySortedDetectionFrames(frameRanges.flat());

        buffer =
          bufferedSourceVersion !== null &&
          bufferedSourceVersion === committedSourceVersion
            ? reuseBufferedFrameSnapshots(buffer, loadedBuffer)
            : loadedBuffer;
        bufferedVersionRange = versionRange;
        bufferedSourceVersion = committedSourceVersion;
        state = {
          bufferEndTime: endTime,
          bufferStartTime: startTime,
          detectionCount: countDetections(buffer),
          errorMessage: null,
          frameCount: buffer.length,
          requestedEndTime: endTime,
          requestedStartTime: startTime,
          status: DetectionBufferStatus.Ready,
        };
        notifyBufferChanged();
      })
      .catch((error: unknown) => {
        if (!destroyed && currentLoadId === loadId) {
          state = {
            ...state,
            errorMessage: getErrorMessage(error),
            status: DetectionBufferStatus.Error,
          };
        }

        throw error;
      })
      .finally(() => {
        if (inFlight?.id === currentLoadId) {
          inFlight = undefined;
        }
      });

    inFlight = {
      endTime,
      id: currentLoadId,
      mediaTime: comparableMediaTime,
      promise,
      sourceVersion,
      startTime,
    };

    return promise;
  };

  /**
   * Restates the window in the lap the playhead is on.
   *
   * A window planned near the end of a looping source runs past the loop
   * point, so once playback wraps, a host comparing the window against the
   * media clock reads a range that starts after the time it is holding. The
   * offset removed here is a whole number of laps, which is what
   * `getComparableMediaTime` already treats as the same position, so
   * membership and the frames on screen are untouched.
   */
  const anchorWindowToPlayhead = (mediaTime: number) => {
    const duration = timelineContext.duration;

    if (
      !isLoopingTimeline() ||
      duration === null ||
      state.bufferStartTime === null ||
      state.bufferEndTime === null
    ) {
      return;
    }

    const laps = Math.round(
      (getComparableMediaTime(mediaTime) - mediaTime) / duration,
    );

    if (laps === 0) {
      return;
    }

    state = {
      ...state,
      bufferEndTime: state.bufferEndTime - laps * duration,
      bufferStartTime: state.bufferStartTime - laps * duration,
    };
    notifyBufferChanged();
  };

  const isBuffered = (mediaTime: number) => {
    const comparableMediaTime = getComparableMediaTime(mediaTime);

    return (
      isBufferFresh() &&
      state.bufferStartTime !== null &&
      state.bufferEndTime !== null &&
      comparableMediaTime >= state.bufferStartTime &&
      comparableMediaTime <= state.bufferEndTime
    );
  };

  const isInsideBufferedRange = (mediaTime: number) => {
    const comparableMediaTime = getComparableMediaTime(mediaTime);

    return (
      bufferedVersionRange !== null &&
      state.bufferStartTime !== null &&
      state.bufferEndTime !== null &&
      comparableMediaTime >= state.bufferStartTime &&
      comparableMediaTime <= state.bufferEndTime
    );
  };

  const getRemainingLead = (mediaTime: number) =>
    state.bufferEndTime === null
      ? null
      : state.bufferEndTime - getComparableMediaTime(mediaTime);

  /**
   * Fetches the next window while the current one still answers, so the load
   * lands behind annotations that never went away.
   */
  const refillRollingWindow = (mediaTime: number) => {
    if (destroyed || refillLeadSeconds <= 0) {
      return;
    }

    const remainingLead = getRemainingLead(mediaTime);

    if (remainingLead === null || remainingLead > refillLeadSeconds) {
      return;
    }

    const { endTime, startTime } = getLoadRange(mediaTime);

    // A window already spanning everything the source can offer has nowhere to
    // advance to, so its lead only shrinks from here. Refetching it would
    // repeat for every remaining frame of playback and buy no coverage.
    if (
      startTime === state.bufferStartTime &&
      endTime === state.bufferEndTime
    ) {
      return;
    }

    void loadWindow(mediaTime).catch(() => undefined);
  };

  const refreshBuffer = async (mediaTime: number) => {
    if (isBuffered(mediaTime)) {
      refillRollingWindow(mediaTime);
      return;
    }

    if (
      isInsideBufferedRange(mediaTime) &&
      bufferedSourceVersion !== null &&
      options.source.getChangesSince
    ) {
      if (!incrementalRefresh) {
        incrementalRefresh = applyIncrementalChanges().finally(() => {
          incrementalRefresh = undefined;
        });
      }

      await incrementalRefresh;

      if (isBuffered(mediaTime)) {
        return;
      }

      return refreshBuffer(mediaTime);
    }

    await loadWindow(mediaTime);
  };

  const shouldPrefetch = (mediaTime: number) => {
    if (!isBuffered(mediaTime)) {
      return true;
    }

    if (shouldRefreshRollingWindow(mediaTime)) {
      return true;
    }

    if (state.bufferEndTime === null || bufferAheadSeconds <= 0) {
      return false;
    }

    return (
      getComparableMediaTime(mediaTime) + bufferAheadSeconds / 2 >=
      state.bufferEndTime
    );
  };

  const timeline: BufferedDetectionTimeline = {
    async prepare(mediaTime, prepareOptions) {
      if (destroyed) {
        return;
      }

      if (shouldWaitForPlaybackGate(prepareOptions)) {
        await waitForPlaybackGate(mediaTime, prepareOptions);

        if (destroyed) {
          return;
        }
      }

      await refreshBuffer(mediaTime);
      anchorWindowToPlayhead(mediaTime);
    },

    prefetch(mediaTime) {
      if (destroyed || !shouldPrefetch(mediaTime)) {
        return;
      }

      pendingPrefetch = { loadId, mediaTime };
      pumpPrefetchQueue();
    },

    selectFrame(mediaTime) {
      if (!isBuffered(mediaTime)) {
        return undefined;
      }

      return selectDetectionFrame(
        buffer,
        getSourceMediaTime(mediaTime),
        options,
      );
    },

    setTimelineContext(context) {
      timelineContext = context;
      bufferedSourceVersion = null;
      bufferedVersionRange = null;
    },

    getBufferedFrames() {
      return copySortedDetectionFrames(buffer);
    },

    getState() {
      return { ...state };
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      listeners.clear();
      pendingPrefetch = undefined;
      buffer = [];
      bufferedSourceVersion = null;
      bufferedVersionRange = null;
      state = {
        ...state,
        bufferEndTime: null,
        bufferStartTime: null,
        detectionCount: 0,
        frameCount: 0,
        status: DetectionBufferStatus.Destroyed,
      };
      options.source.destroy?.();
    },
  };

  bufferedFrameSnapshots.set(timeline, () => buffer);

  return timeline;

  function pumpPrefetchQueue() {
    if (destroyed || prefetchPump) {
      return;
    }

    prefetchPump = drainPrefetchQueue().finally(() => {
      prefetchPump = undefined;

      if (!destroyed && pendingPrefetch) {
        pumpPrefetchQueue();
      }
    });
  }

  async function drainPrefetchQueue() {
    while (!destroyed && pendingPrefetch) {
      if (inFlight) {
        await inFlight.promise.catch(() => undefined);
        continue;
      }

      const request = pendingPrefetch;

      pendingPrefetch = undefined;

      if (request.loadId !== loadId) {
        continue;
      }

      const { mediaTime } = request;

      if (!shouldPrefetch(mediaTime)) {
        continue;
      }

      await (
        shouldRefreshRollingWindow(mediaTime)
          ? loadWindow(mediaTime)
          : refreshBuffer(mediaTime)
      ).catch(() => undefined);
    }
  }

  async function applyIncrementalChanges() {
    if (
      destroyed ||
      bufferedSourceVersion === null ||
      !options.source.getChangesSince
    ) {
      return;
    }

    const sourceRanges = getBufferedSourceRanges();
    const incrementalLoadId = loadId;
    const incrementalVersionRange = bufferedVersionRange;
    const changes = options.source.getChangesSince(
      bufferedSourceVersion,
      sourceRanges,
    );

    if (changes.requiresReload) {
      bufferedSourceVersion = null;
      return;
    }

    if (changes.ranges.length === 0) {
      bufferedSourceVersion = changes.version;
      return;
    }

    const changedRanges = getOverlappingRanges(changes.ranges, sourceRanges);

    if (changedRanges.length === 0) {
      bufferedSourceVersion = changes.version;
      return;
    }

    try {
      const changedFrameRanges = await Promise.all(
        changedRanges.map((range) =>
          options.source.loadFrames(range.startTime, range.endTime),
        ),
      );

      if (
        destroyed ||
        loadId !== incrementalLoadId ||
        bufferedVersionRange !== incrementalVersionRange
      ) {
        return;
      }

      buffer = mergeIncrementalFrames(
        buffer,
        changedFrameRanges.flat(),
        changedRanges,
      );
      bufferedSourceVersion = changes.version;
      state = {
        ...state,
        detectionCount: countDetections(buffer),
        errorMessage: null,
        frameCount: buffer.length,
        status: DetectionBufferStatus.Ready,
      };
      notifyBufferChanged();
    } catch (error) {
      if (!destroyed) {
        state = {
          ...state,
          errorMessage: getErrorMessage(error),
          status: DetectionBufferStatus.Error,
        };
      }

      throw error;
    }
  }

  function shouldWaitForPlaybackGate(
    prepareOptions: DetectionBufferPrepareOptions | undefined,
  ) {
    return (
      prepareOptions?.gatePlayback === true &&
      playbackGate?.enabled === true &&
      Boolean(options.source.waitForRange)
    );
  }

  async function waitForPlaybackGate(
    mediaTime: number,
    prepareOptions: DetectionBufferPrepareOptions | undefined,
  ) {
    if (!playbackGate?.enabled || !options.source.waitForRange) {
      return;
    }

    const requiredAheadSeconds = Math.max(
      0,
      playbackGate.requiredAheadSeconds ?? 0,
    );
    const comparableMediaTime = getComparableMediaTime(mediaTime);
    const endTime = getRequiredCoverageEndTime({
      // A looping window counts past the end of media and wraps into the
      // replay, so clamping it to duration would ask for less than it needs.
      duration: isLoopingTimeline() ? null : prepareOptions?.duration,
      firstTimestamp: prepareOptions?.firstTimestamp,
      mediaTime: comparableMediaTime,
      requiredAheadSeconds,
    });

    if (endTime <= comparableMediaTime) {
      return;
    }

    const coveragePlan = createLoadPlan(comparableMediaTime, endTime);

    state = {
      ...state,
      errorMessage: null,
      requestedEndTime: coveragePlan.endTime,
      requestedStartTime: coveragePlan.startTime,
      status: DetectionBufferStatus.Loading,
    };

    try {
      await Promise.all(
        coveragePlan.sourceRanges.map((range) =>
          options.source.waitForRange?.(range),
        ),
      );
    } catch (error) {
      if (!destroyed) {
        state = {
          ...state,
          errorMessage: getErrorMessage(error),
          status: DetectionBufferStatus.Error,
        };
      }

      throw error;
    }
  }

  function shouldRefreshRollingWindow(mediaTime: number) {
    if (
      refreshIntervalSeconds === null ||
      refreshIntervalSeconds <= 0 ||
      state.bufferStartTime === null ||
      state.bufferEndTime === null
    ) {
      return false;
    }

    const { endTime, startTime } = getLoadRange(mediaTime);

    return (
      Math.abs(startTime - state.bufferStartTime) >= refreshIntervalSeconds ||
      Math.abs(endTime - state.bufferEndTime) >= refreshIntervalSeconds
    );
  }

  function createLoadPlan(
    requestedStartTime: number,
    requestedEndTime: number,
  ): DetectionBufferLoadPlan {
    const startTime = Math.min(requestedStartTime, requestedEndTime);
    const endTime = Math.max(startTime, requestedEndTime);

    if (!isLoopingTimeline()) {
      const clampedStartTime = Math.max(0, startTime);
      const clampedEndTime = Math.max(clampedStartTime, endTime);

      return {
        endTime: clampedEndTime,
        sourceRanges: [
          {
            endTime: clampedEndTime,
            startTime: clampedStartTime,
          },
        ],
        startTime: clampedStartTime,
      };
    }

    const duration = timelineContext.duration ?? 0;

    if (endTime - startTime >= duration) {
      return {
        endTime: duration,
        sourceRanges: [{ endTime: duration, startTime: 0 }],
        startTime: 0,
      };
    }

    // Both ends move by the same whole number of laps, so the window keeps its
    // span and its source ranges while its start reads on the media clock: a
    // window counted in the laps playback accumulated is one no host can hold
    // against a current time.
    const laps = Math.floor(startTime / duration);

    return {
      endTime: endTime - laps * duration,
      sourceRanges: getLoopingSourceRanges(startTime, endTime, duration),
      startTime: startTime - laps * duration,
    };
  }

  function getBufferedSourceRanges() {
    if (!bufferedVersionRange) {
      return [];
    }

    return createLoadPlan(
      bufferedVersionRange.startTime,
      bufferedVersionRange.endTime,
    ).sourceRanges;
  }

  function isLoopingTimeline() {
    return (
      timelineContext.loop &&
      timelineContext.duration !== null &&
      timelineContext.duration > 0
    );
  }

  function getComparableMediaTime(mediaTime: number) {
    if (
      !isLoopingTimeline() ||
      state.bufferStartTime === null ||
      state.bufferEndTime === null ||
      timelineContext.duration === null
    ) {
      return mediaTime;
    }

    const duration = timelineContext.duration;

    // The representative of mediaTime (mod duration) anchored at the window
    // start. The mapping must depend only on where the window sits, never on
    // how many laps playback has accumulated, or membership drifts away from
    // what the buffer actually holds. A time less than one lap past the
    // anchor never wraps, so ordinary forward playback cannot ratchet.
    return (
      state.bufferStartTime +
      modulo(mediaTime - state.bufferStartTime, duration)
    );
  }

  function getSourceMediaTime(mediaTime: number) {
    if (!isLoopingTimeline() || timelineContext.duration === null) {
      return mediaTime;
    }

    if (mediaTime >= 0 && mediaTime <= timelineContext.duration) {
      return mediaTime;
    }

    return modulo(mediaTime, timelineContext.duration);
  }
}

export function createIdleDetectionBufferState(): DetectionBufferState {
  return {
    bufferEndTime: null,
    bufferStartTime: null,
    detectionCount: 0,
    errorMessage: null,
    frameCount: 0,
    requestedEndTime: null,
    requestedStartTime: null,
    status: DetectionBufferStatus.Idle,
  };
}

function rangeContains(
  outerStart: number,
  outerEnd: number,
  innerStart: number,
  innerEnd: number,
) {
  return outerStart <= innerStart && innerEnd <= outerEnd;
}

function countDetections(frames: readonly DetectionFrame[]) {
  return frames.reduce((total, frame) => total + frame.detections.length, 0);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Detection buffer load failed.";
}

function getRequiredCoverageEndTime(options: {
  readonly duration?: number | null;
  readonly firstTimestamp?: number;
  readonly mediaTime: number;
  readonly requiredAheadSeconds: number;
}) {
  const requestedEndTime = options.mediaTime + options.requiredAheadSeconds;

  if (options.duration === null || options.duration === undefined) {
    return requestedEndTime;
  }

  return Math.min(
    requestedEndTime,
    (options.firstTimestamp ?? 0) + Math.max(options.duration, 0),
  );
}

function getLoopingSourceRanges(
  startTime: number,
  endTime: number,
  duration: number,
): readonly DetectionFrameSourceVersionRange[] {
  const normalizedStartTime = modulo(startTime, duration);
  const normalizedEndTime = modulo(endTime, duration);
  const startCycle = Math.floor(startTime / duration);
  const endCycle = Math.floor(endTime / duration);

  if (startCycle === endCycle) {
    return [{ endTime: normalizedEndTime, startTime: normalizedStartTime }];
  }

  const ranges: DetectionFrameSourceVersionRange[] = [];

  if (normalizedStartTime < duration) {
    ranges.push({ endTime: duration, startTime: normalizedStartTime });
  }

  if (normalizedEndTime > 0) {
    ranges.push({ endTime: normalizedEndTime, startTime: 0 });
  }

  return ranges;
}

function modulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

function getOverlappingRanges(
  changedRanges: readonly DetectionFrameSourceVersionRange[],
  bufferedRanges: readonly DetectionFrameSourceVersionRange[],
) {
  const intersections: DetectionFrameSourceVersionRange[] = [];

  for (const changedRange of changedRanges) {
    for (const bufferedRange of bufferedRanges) {
      const startTime = Math.max(
        changedRange.startTime,
        bufferedRange.startTime,
      );
      const endTime = Math.min(changedRange.endTime, bufferedRange.endTime);

      if (startTime <= endTime) {
        intersections.push({ endTime, startTime });
      }
    }
  }

  return intersections;
}

function mergeIncrementalFrames(
  currentFrames: readonly DetectionFrame[],
  changedFrames: readonly DetectionFrame[],
  changedRanges: readonly DetectionFrameSourceVersionRange[],
) {
  const framesByIdentity = new Map<string, DetectionFrame>();

  for (const frame of currentFrames) {
    if (
      changedRanges.some((range) =>
        detectionFrameOverlapsRange(frame, range.startTime, range.endTime),
      )
    ) {
      continue;
    }

    framesByIdentity.set(getDetectionFrameIdentity(frame), frame);
  }

  for (const frame of changedFrames) {
    framesByIdentity.set(getDetectionFrameIdentity(frame), frame);
  }

  return Array.from(framesByIdentity.values()).sort(compareDetectionFrames);
}

function reuseBufferedFrameSnapshots(
  currentFrames: readonly DetectionFrame[],
  loadedFrames: readonly DetectionFrame[],
) {
  const currentFramesByIdentity = new Map(
    currentFrames.map((frame) => [getDetectionFrameIdentity(frame), frame]),
  );

  return loadedFrames.map(
    (frame) =>
      currentFramesByIdentity.get(getDetectionFrameIdentity(frame)) ?? frame,
  );
}

function getDetectionFrameIdentity(frame: DetectionFrame) {
  return frame.frameIndex === undefined
    ? `time:${frame.mediaTime}`
    : `index:${frame.frameIndex}`;
}

function compareDetectionFrames(left: DetectionFrame, right: DetectionFrame) {
  if (left.mediaTime !== right.mediaTime) {
    return left.mediaTime - right.mediaTime;
  }

  return (left.frameIndex ?? 0) - (right.frameIndex ?? 0);
}
