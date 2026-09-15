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
import { isRangeCovered } from "#utils/detection-ranges";
import { startWaitBound } from "#utils/wait-bound";
import {
  copyDetectionFrame,
  copySortedDetectionFrames,
  detectionFrameOverlapsRange,
  selectDetectionFrame,
  validateDetectionFrames,
} from "#utils/detection-frames";

const DEFAULT_BUFFER_AHEAD_SECONDS = 10;
const DEFAULT_BUFFER_BEHIND_SECONDS = 5;
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
/**
 * How long a playback gate holds before it gives up on coverage.
 *
 * The gate waits on a producer, and a producer that has failed, stalled, or
 * fallen far behind is indistinguishable from one that is about to answer. Past
 * this a frozen picture is the worse of the two outcomes, so the frame is
 * presented with whatever detections exist.
 */
const DEFAULT_PLAYBACK_GATE_MAX_WAIT_SECONDS = 10;

/**
 * How far ahead of the playhead a load reaches.
 *
 * At a one-second chunking the lead is a dozen chunk requests on the same link
 * the video is read over, and only the chunk under the playhead carries the
 * frame the picture is waiting to draw. `covering` asks for that one; the lead
 * follows once it lands.
 */
type DetectionBufferLead = "covering" | "full";

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
  let timelineFirstTimestamp = 0;
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
  /** Source version the gate last gave up on, or null while it still waits. */
  let abandonedGateSourceVersion: number | null = null;
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
  const isLoadingEnabled = () =>
    typeof options.enabled === "function"
      ? options.enabled()
      : options.enabled !== false;
  const isBufferFresh = () =>
    bufferedVersionRange !== null &&
    bufferedSourceVersion === getSourceVersion(getBufferedSourceRanges());

  const getLoadRange = (
    mediaTime: number,
    lead: DetectionBufferLead = "full",
  ) => {
    const comparableMediaTime = getComparableMediaTime(mediaTime);
    const startTime = comparableMediaTime - bufferBehindSeconds;
    const endTime =
      comparableMediaTime + (lead === "full" ? bufferAheadSeconds : 0);

    return createLoadPlan(startTime, endTime);
  };

  const loadWindow = (
    mediaTime: number,
    lead: DetectionBufferLead = "full",
  ) => {
    const comparableMediaTime = getComparableMediaTime(mediaTime);
    const { endTime, sourceRanges, startTime } = getLoadRange(mediaTime, lead);
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
        const loadedFrames = frameRanges.flat();

        buffer =
          bufferedSourceVersion !== null &&
          bufferedSourceVersion === committedSourceVersion
            ? reuseBufferedFrameSnapshots(buffer, loadedFrames)
            : copySortedDetectionFrames(loadedFrames);
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

    if (lead === "covering") {
      // Chained past the clearing of `inFlight`, which would otherwise be
      // handed back to the widening load as a window that already answers.
      void promise
        .then(() => {
          if (!destroyed && currentLoadId === loadId) {
            void loadWindow(mediaTime).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }

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

    const loopSpan = duration - timelineFirstTimestamp;

    const laps = Math.round(
      (getComparableMediaTime(mediaTime) - mediaTime) / loopSpan,
    );

    if (laps === 0) {
      return;
    }

    state = {
      ...state,
      bufferEndTime: state.bufferEndTime - laps * loopSpan,
      bufferStartTime: state.bufferStartTime - laps * loopSpan,
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

  const inFlightCovers = (mediaTime: number) => {
    if (!inFlight) {
      return true;
    }

    const comparableMediaTime = getComparableMediaTime(mediaTime);
    return (
      comparableMediaTime >= inFlight.startTime &&
      comparableMediaTime <= inFlight.endTime
    );
  };

  const supersedeLoadOutside = (mediaTime: number) => {
    if (!inFlight || inFlightCovers(mediaTime)) {
      return;
    }

    const keepsCurrentBuffer = isBuffered(mediaTime);
    loadId += 1;
    inFlight = undefined;
    if (keepsCurrentBuffer) {
      state = {
        ...state,
        errorMessage: null,
        requestedEndTime: state.bufferEndTime,
        requestedStartTime: state.bufferStartTime,
        status: DetectionBufferStatus.Ready,
      };
      notifyBufferChanged();
    }
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

  const refreshBuffer = async (
    mediaTime: number,
    lead: DetectionBufferLead = "full",
  ) => {
    if (isBuffered(mediaTime)) {
      // A backwards navigation may land in the retained buffer while a rolling
      // prefetch for the old playhead is about to replace it. The navigation
      // is current truth; do not let that older load evict its detections after
      // the frame has been accepted.
      supersedeLoadOutside(mediaTime);
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

      return refreshBuffer(mediaTime, lead);
    }

    await loadWindow(mediaTime, lead);
  };

  /**
   * Whether the next window is worth fetching while the current one still
   * answers, so the load lands behind annotations that never went away.
   */
  const shouldPrefetch = (mediaTime: number) => {
    if (!isLoadingEnabled()) {
      return false;
    }

    if (!isBuffered(mediaTime)) {
      return true;
    }

    if (shouldRefreshRollingWindow(mediaTime)) {
      return true;
    }

    if (state.bufferEndTime === null || bufferAheadSeconds <= 0) {
      return false;
    }

    if (
      getComparableMediaTime(mediaTime) + bufferAheadSeconds / 2 <
      state.bufferEndTime
    ) {
      return false;
    }

    const { endTime, startTime } = getLoadRange(mediaTime);

    // A window already spanning everything the source can offer has nowhere to
    // advance to, so its lead only shrinks from here. Refetching it would
    // repeat for every remaining frame of playback and buy no coverage.
    return (
      startTime !== state.bufferStartTime || endTime !== state.bufferEndTime
    );
  };

  const timeline: BufferedDetectionTimeline = {
    async prepare(mediaTime, prepareOptions) {
      if (destroyed || !isLoadingEnabled()) {
        return;
      }

      adoptFirstTimestamp(prepareOptions?.firstTimestamp);
      const navigationMediaTime = getNavigationMediaTime(mediaTime);

      if (shouldWaitForPlaybackGate(prepareOptions)) {
        await waitForPlaybackGate(navigationMediaTime, prepareOptions);

        if (destroyed) {
          return;
        }
      }

      await refreshBuffer(navigationMediaTime);
      anchorWindowToPlayhead(navigationMediaTime);
    },

    needsBufferPrepare(mediaTime) {
      const navigationMediaTime = getNavigationMediaTime(mediaTime);

      return (
        !destroyed &&
        isLoadingEnabled() &&
        (!isInsideBufferedRange(navigationMediaTime) ||
          !inFlightCovers(navigationMediaTime))
      );
    },

    needsPlaybackGateWait(mediaTime, prepareOptions) {
      adoptFirstTimestamp(prepareOptions?.firstTimestamp);
      const navigationMediaTime = getNavigationMediaTime(mediaTime);

      if (
        destroyed ||
        !isLoadingEnabled() ||
        !playbackGate?.enabled ||
        !options.source.waitForRange ||
        !options.source.getAvailableRanges ||
        hasAbandonedGate()
      ) {
        return false;
      }

      const availableRanges = options.source.getAvailableRanges();

      return !createPlaybackGateCoveragePlan(
        navigationMediaTime,
        prepareOptions,
      ).sourceRanges.every((range) => isRangeCovered(range, availableRanges));
    },

    prefetch(mediaTime) {
      if (destroyed || !isLoadingEnabled()) {
        return;
      }

      const navigationMediaTime = getNavigationMediaTime(mediaTime);

      anchorWindowToPlayhead(navigationMediaTime);
      supersedeLoadOutside(navigationMediaTime);

      if (!shouldPrefetch(navigationMediaTime)) {
        return;
      }

      pendingPrefetch = { loadId, mediaTime: navigationMediaTime };
      pumpPrefetchQueue();
    },

    selectFrame(mediaTime) {
      const navigationMediaTime = getNavigationMediaTime(mediaTime);

      if (!isInsideBufferedRange(navigationMediaTime)) {
        return undefined;
      }

      return selectDetectionFrame(
        buffer,
        getSourceMediaTime(navigationMediaTime),
        options,
      );
    },

    setTimelineContext(context) {
      timelineContext = context;
      adoptFirstTimestamp(context.firstTimestamp);
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

      // A playhead the window does not reach is a jump rather than the window
      // rolling forward, and the frame under it is the one thing the picture
      // cannot draw without. A window that still spans it, however stale, is
      // missing no such frame.
      const lead: DetectionBufferLead = isInsideBufferedRange(mediaTime)
        ? "full"
        : "covering";

      await (
        isBuffered(mediaTime) || shouldRefreshRollingWindow(mediaTime)
          ? loadWindow(mediaTime, lead)
          : refreshBuffer(mediaTime, lead)
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

  function createPlaybackGateCoveragePlan(
    mediaTime: number,
    prepareOptions: DetectionBufferPrepareOptions | undefined,
  ) {
    const requiredAheadSeconds = Math.max(
      0,
      playbackGate?.requiredAheadSeconds ?? 0,
    );
    const comparableMediaTime = Math.max(
      timelineFirstTimestamp,
      getComparableMediaTime(mediaTime),
    );
    const endTime = getRequiredCoverageEndTime({
      // A looping window counts past the end of media and wraps into the
      // replay, so clamping it to duration would ask for less than it needs.
      duration: isLoopingTimeline() ? null : prepareOptions?.duration,
      firstTimestamp: timelineFirstTimestamp,
      mediaTime: comparableMediaTime,
      requiredAheadSeconds,
    });

    // A lead clamped away at the end of media, or asked for as zero, still
    // leaves the frame under the playhead to wait for.
    return createLoadPlan(
      comparableMediaTime,
      Math.max(comparableMediaTime, endTime),
    );
  }

  function hasAbandonedGate() {
    return (
      abandonedGateSourceVersion !== null &&
      getSourceVersion() <= abandonedGateSourceVersion
    );
  }

  async function waitForPlaybackGate(
    mediaTime: number,
    prepareOptions: DetectionBufferPrepareOptions | undefined,
  ) {
    if (!playbackGate?.enabled || !options.source.waitForRange) {
      return;
    }

    if (hasAbandonedGate()) {
      return;
    }

    const coveragePlan = createPlaybackGateCoveragePlan(
      mediaTime,
      prepareOptions,
    );

    state = {
      ...state,
      errorMessage: null,
      requestedEndTime: coveragePlan.endTime,
      requestedStartTime: coveragePlan.startTime,
      status: DetectionBufferStatus.AwaitingCoverage,
    };

    try {
      const covered = await waitForSourceCoverage(
        coveragePlan.sourceRanges,
        Math.max(
          0,
          playbackGate.maxWaitSeconds ?? DEFAULT_PLAYBACK_GATE_MAX_WAIT_SECONDS,
        ),
      );

      abandonedGateSourceVersion =
        covered || !options.source.getVersion ? null : getSourceVersion();
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

  /**
   * Resolves true once the source covers every range, false once the wait has
   * run longer than `maxWaitSeconds`.
   */
  async function waitForSourceCoverage(
    sourceRanges: readonly DetectionFrameSourceVersionRange[],
    maxWaitSeconds: number,
  ) {
    const covered = whenRangesCovered(sourceRanges);

    if (!Number.isFinite(maxWaitSeconds)) {
      return covered;
    }

    const bound = startWaitBound(maxWaitSeconds * 1000);

    try {
      const result = await Promise.race([covered, bound.expired]);

      if (!result) {
        // The abandoned wait outlives this call, and a rejection it reaches
        // afterwards has nobody left to hand it to.
        void covered.catch(() => undefined);
      }

      return result;
    } finally {
      bound.cancel();
    }
  }

  async function whenRangesCovered(
    sourceRanges: readonly DetectionFrameSourceVersionRange[],
  ) {
    await Promise.all(
      sourceRanges.map((range) => options.source.waitForRange?.(range)),
    );

    return true;
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
      getWindowDrift(startTime, state.bufferStartTime) >=
        refreshIntervalSeconds ||
      getWindowDrift(endTime, state.bufferEndTime) >= refreshIntervalSeconds
    );
  }

  /**
   * How far a planned edge sits from the window's, counted the short way around
   * a looping timeline. A plan is stated on the first lap and the window on the
   * playhead's, so across the loop point the two state the same edge a whole lap
   * apart; measured straight, that reads as a window a full lap stale and
   * rebuilds it on every frame until the plan stops reaching behind the first
   * playable timestamp.
   */
  function getWindowDrift(planTime: number, bufferTime: number) {
    const drift = Math.abs(planTime - bufferTime);

    if (!isLoopingTimeline() || timelineContext.duration === null) {
      return drift;
    }

    const loopSpan = timelineContext.duration - timelineFirstTimestamp;
    const wrappedDrift = modulo(drift, loopSpan);

    return Math.min(wrappedDrift, loopSpan - wrappedDrift);
  }

  function createLoadPlan(
    requestedStartTime: number,
    requestedEndTime: number,
  ): DetectionBufferLoadPlan {
    const startTime = Math.min(requestedStartTime, requestedEndTime);
    const endTime = Math.max(startTime, requestedEndTime);

    if (!isLoopingTimeline()) {
      const clampedStartTime = Math.max(timelineFirstTimestamp, startTime);
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
    const loopSpan = duration - timelineFirstTimestamp;

    if (endTime - startTime >= loopSpan) {
      return {
        endTime: duration,
        sourceRanges: [
          { endTime: duration, startTime: timelineFirstTimestamp },
        ],
        startTime: timelineFirstTimestamp,
      };
    }

    // Both ends move by the same whole number of laps, so the window keeps its
    // span and its source ranges while its start reads on the media clock: a
    // window counted in the laps playback accumulated is one no host can hold
    // against a current time.
    const laps = Math.floor((startTime - timelineFirstTimestamp) / loopSpan);

    return {
      endTime: endTime - laps * loopSpan,
      sourceRanges: getLoopingSourceRanges(
        startTime,
        endTime,
        duration,
        timelineFirstTimestamp,
      ),
      startTime: startTime - laps * loopSpan,
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
      timelineContext.duration > timelineFirstTimestamp
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

    const loopSpan = timelineContext.duration - timelineFirstTimestamp;

    // The representative of mediaTime (mod the loop span) anchored at the window
    // start. The mapping must depend only on where the window sits, never on
    // how many laps playback has accumulated, or membership drifts away from
    // what the buffer actually holds. A time less than one lap past the
    // anchor never wraps, so ordinary forward playback cannot ratchet.
    return (
      state.bufferStartTime +
      modulo(mediaTime - state.bufferStartTime, loopSpan)
    );
  }

  function getSourceMediaTime(mediaTime: number) {
    if (!isLoopingTimeline() || timelineContext.duration === null) {
      return mediaTime;
    }

    if (
      mediaTime >= timelineFirstTimestamp &&
      mediaTime <= timelineContext.duration
    ) {
      return mediaTime;
    }

    const loopSpan = timelineContext.duration - timelineFirstTimestamp;

    return (
      timelineFirstTimestamp +
      modulo(mediaTime - timelineFirstTimestamp, loopSpan)
    );
  }

  function getNavigationMediaTime(mediaTime: number) {
    return Math.max(timelineFirstTimestamp, mediaTime);
  }

  function adoptFirstTimestamp(firstTimestamp: number | undefined) {
    if (
      firstTimestamp === undefined ||
      !Number.isFinite(firstTimestamp) ||
      firstTimestamp === timelineFirstTimestamp
    ) {
      return;
    }

    timelineFirstTimestamp = firstTimestamp;
    loadId += 1;
    inFlight = undefined;
    pendingPrefetch = undefined;
    bufferedSourceVersion = null;
    bufferedVersionRange = null;
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
    Math.max(options.firstTimestamp ?? 0, options.duration),
  );
}

function getLoopingSourceRanges(
  startTime: number,
  endTime: number,
  duration: number,
  firstTimestamp = 0,
): readonly DetectionFrameSourceVersionRange[] {
  const loopSpan = duration - firstTimestamp;
  const normalizedStartTime =
    firstTimestamp + modulo(startTime - firstTimestamp, loopSpan);
  const normalizedEndTime =
    firstTimestamp + modulo(endTime - firstTimestamp, loopSpan);
  const startCycle = Math.floor((startTime - firstTimestamp) / loopSpan);
  const endCycle = Math.floor((endTime - firstTimestamp) / loopSpan);

  if (startCycle === endCycle) {
    return [{ endTime: normalizedEndTime, startTime: normalizedStartTime }];
  }

  const ranges: DetectionFrameSourceVersionRange[] = [];

  if (normalizedStartTime < duration) {
    ranges.push({ endTime: duration, startTime: normalizedStartTime });
  }

  if (normalizedEndTime > firstTimestamp) {
    ranges.push({ endTime: normalizedEndTime, startTime: firstTimestamp });
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

/**
 * Keeps the frame already held wherever the source returned one this buffer
 * knows, and copies only what is new. Copying everything first and then
 * discarding it is the same result for a great deal more work: a window rebuilt
 * while a gesture moves inside it re-derives hundreds of frames it already has.
 */
function reuseBufferedFrameSnapshots(
  currentFrames: readonly DetectionFrame[],
  loadedFrames: readonly DetectionFrame[],
) {
  validateDetectionFrames(loadedFrames);

  const currentFramesByIdentity = new Map(
    currentFrames.map((frame) => [getDetectionFrameIdentity(frame), frame]),
  );

  return loadedFrames
    .map(
      (frame) =>
        currentFramesByIdentity.get(getDetectionFrameIdentity(frame)) ??
        copyDetectionFrame(frame),
    )
    .sort(compareDetectionFrames);
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
