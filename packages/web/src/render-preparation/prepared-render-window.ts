import {
  createMaskFramePreparer,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-preparer";
import { getBrowserMaskPreparationWorkerCount } from "#render-preparation/mask-preparation-worker-count";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import {
  createPreparedWindowTimeline,
  type PreparedRenderTimelineContext,
} from "#render-preparation/prepared-window-timeline";
import {
  getBufferedDetectionTimelineFrameSnapshot,
  type BufferedDetectionTimeline,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import {
  RenderPreparationExecutionMode,
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  RenderPreparationGateHoldReason,
  RenderPreparationWorkerStatus,
  type RenderPreparationGateHoldDiagnostics,
  type RenderPreparationOptions,
  type RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";
import { canReuseMaskStyleArtifacts } from "supervision-js-core";

const DEFAULT_MASK_FRAME_CACHE_SIZE = 24;
const DEFAULT_MASK_PENDING_FRAME_COUNT = 8;
const DEFAULT_MASK_PREFETCH_FRAME_COUNT = 12;
const DEFAULT_MASK_SCHEDULE_BATCH_SIZE = 2;
const DEFAULT_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS = 0.15;
const PREPARED_WINDOW_REFILL_RATIO = 5 / 7;
/** One cook per four frames, the top of the playback-rate ladder on 60Hz. */
const MAX_PRESENTED_FRAME_STRIDE = 4;
/** A jump that repeats. One on its own is a seek, and it lands somewhere. */
const DRAGGED_PLAYHEAD_JUMP_COUNT = 2;
const PRESENTED_FRAME_STRIDE_SAMPLE_COUNT = 4;

type ScheduledPreparationTask = ReturnType<typeof setTimeout>;

interface PendingMaskFrame {
  readonly frame: DetectionFrame;
  readonly generation: number;
  readonly key: string;
  readonly maskStyle: MaskStyle;
  readonly mediaTime: number;
}

enum PreparedRenderSchedulePriority {
  Active = "active",
  Background = "background",
}

export interface PreparedRenderFrame {
  readonly detectionFrame: DetectionFrame;
  readonly key: string;
  readonly maskFrame?: PreparedMaskFrame;
  readonly maskStatus: PreparedRenderFrameMaskStatus;
}

export enum PreparedRenderFrameMaskStatus {
  Disabled = "disabled",
  Empty = "empty",
  Pending = "pending",
  Prepared = "prepared",
}

export interface PreparedRenderWindow {
  getFrame(mediaTime: number): PreparedRenderFrame | undefined;
  /**
   * Whether this window's artifact for a media time is cooked, scheduling
   * nothing. True when there is nothing to cook: no style, no frame there.
   */
  isArtifactPrepared(mediaTime: number): boolean;
  /**
   * Frames preparation has finished, counted up across the window's life. Read
   * twice, it separates preparation that is slow from preparation that is
   * stuck: the count moves for a cook that lands however far behind the
   * playhead it is, and a cook that lands and is then evicted still counts.
   */
  getPreparationProgress(): number;
  /**
   * Whether `waitForReady` would wait, answered without scheduling anything.
   * Asked on every playhead move of a source that has to be stopped to be
   * held, where opening a wait that resolves immediately still costs the stop.
   */
  needsPlaybackGateWait(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
  ): boolean;
  /**
   * Resolves once the media time may be presented. `signal` is how a caller
   * that has moved on says so: aborting resolves the wait and drops the hold it
   * was placing on preparation, because a caller that walked away re-checks
   * whatever it does next anyway. Without one, an abandoned wait holds forever.
   */
  waitForReady(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Whether the playhead is moving. A window over a resting playhead covers a
   * paused margin instead of the full prefetch span.
   */
  setPlaybackActive(active: boolean): void;
  setTimelineContext(context: PreparedRenderTimelineContext): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  destroy(): void;
}

export type { PreparedMaskFrame } from "./mask-frame-preparer";
export type { PreparedRenderTimelineContext } from "./prepared-window-timeline";

/** How many frames ahead of the playhead a prepared window aims to cover. */
export function resolvePreparedWindowFrameCount(options: {
  readonly prefetchFrameCount?: number;
  readonly renderPreparation?: RenderPreparationOptions;
}) {
  return Math.max(
    0,
    options.prefetchFrameCount ??
      options.renderPreparation?.maskFrame?.prefetchFrameCount ??
      DEFAULT_MASK_PREFETCH_FRAME_COUNT,
  );
}

export function createPreparedRenderWindow(options: {
  readonly artifactKind?: RenderPreparationArtifactKind;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskStyle?: MaskStyle | null;
  readonly maxMaskFrameCacheSize?: number;
  readonly onMaskFrameEvicted?: (key: string) => void;
  readonly onMaskFramePrepared?: (maskFrame: PreparedMaskFrame) => void;
  readonly onMaskFramesCleared?: () => void;
  /** Fires whenever what the window covers may have changed. */
  readonly onPreparedWindowChange?: () => void;
  readonly prefetchFrameCount?: number;
  readonly preparedWindowScanIntervalSeconds?: number;
  readonly renderPreparation?: RenderPreparationOptions;
  readonly resolveInstructions?: (options: {
    readonly frame: DetectionFrame;
    readonly maskStyle: MaskStyle;
    readonly mediaTime: number;
  }) => readonly SerializableMaskInstruction[];
  /**
   * The widest id raster a cook may produce. A function because the raster is
   * sized against media dimensions the caller only learns once its display
   * exists, which is after this window does.
   */
  readonly resolveMaxRasterWidth?: () => number | undefined;
}): PreparedRenderWindow {
  const maskFrameOptions = options.renderPreparation?.maskFrame;
  const maxMaskFrameCacheSize = Math.max(
    1,
    Math.floor(
      options.maxMaskFrameCacheSize ??
        maskFrameOptions?.maxCacheFrameCount ??
        DEFAULT_MASK_FRAME_CACHE_SIZE,
    ) || DEFAULT_MASK_FRAME_CACHE_SIZE,
  );
  const prefetchFrameCount = resolvePreparedWindowFrameCount(options);
  const preparedWindowScanIntervalSeconds = Math.max(
    0,
    options.preparedWindowScanIntervalSeconds ??
      maskFrameOptions?.scanIntervalSeconds ??
      DEFAULT_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS,
  );
  const maxPendingFrameCount = Math.max(
    1,
    maskFrameOptions?.maxPendingFrameCount ?? DEFAULT_MASK_PENDING_FRAME_COUNT,
  );
  const scheduleBatchSize = Math.max(
    1,
    maskFrameOptions?.scheduleBatchSize ?? DEFAULT_MASK_SCHEDULE_BATCH_SIZE,
  );
  const workerCount = getBrowserMaskPreparationWorkerCount(
    maskFrameOptions?.workerCount,
  );
  const pausedPrefetchFrameCount = getPausedPreparedWindowFrameCount({
    prefetchFrameCount,
    scheduleBatchSize,
  });
  const refillThresholdFrameCount =
    getPreparedWindowRefillThresholdFrameCount(prefetchFrameCount);
  const pausedRefillThresholdFrameCount =
    getPreparedWindowRefillThresholdFrameCount(pausedPrefetchFrameCount);

  let isPlaybackActive = true;
  let maskStyle = options.maskStyle ?? null;
  const maskFramePreparer = createPreparer();
  let lastPreparedBufferSignature: string | null = null;
  let lastPreparedWindowMediaTime: number | null = null;
  let lastPreparedWindowFrames: readonly DetectionFrame[] = [];
  let lastPreparedTargetFrames: readonly DetectionFrame[] = [];
  const timeline = createPreparedWindowTimeline();
  let activeMaskFrame: {
    readonly key: string;
    readonly mediaTime: number;
  } | null = null;
  let activeMaskFrameSignature: string | null = null;
  const presentedFrameStrideSamples: number[] = [];
  let previousActiveFrameMediaTime: number | null = null;
  let consecutivePlayheadJumpCount = 0;
  let isPlayheadSettled = true;
  let isDestroyed = false;
  let generation = 0;
  let preparationProgress = 0;
  const preparedMaskFrames = new Map<string, PreparedMaskFrame>();
  const pendingMaskFrames = new Map<string, PendingMaskFrame>();
  const queuedMaskFrameKeys: string[] = [];
  const inFlightMaskFrames = new Set<PendingMaskFrame>();
  const emptyMaskFrameKeys = new Set<string>();
  // Detection frames are immutable snapshots. A new object at an existing
  // timeline key therefore represents a source revision for that artifact.
  const observedMaskFrames = new Map<string, DetectionFrame>();
  const readinessWaiters = new Set<() => void>();
  const activeReadinessWaits = new Set<{
    readonly mediaTime: number;
    readonly requiredAheadSeconds: number;
  }>();
  let scheduledQueuePump: ScheduledPreparationTask | undefined;
  let terminalPreparationError: Error | null = null;

  const scheduleMaskFrame = (
    frame: DetectionFrame,
    mediaTime: number,
    scheduleOptions: {
      readonly emitDiagnostics?: boolean;
      readonly priority: PreparedRenderSchedulePriority;
    },
  ) => {
    const key = getFrameKey(frame);
    const isActiveFrame =
      scheduleOptions.priority === PreparedRenderSchedulePriority.Active;

    if (!maskStyle || isDestroyed || terminalPreparationError) {
      return false;
    }

    observeMaskFrame(frame, key);

    if (preparedMaskFrames.has(key) || emptyMaskFrameKeys.has(key)) {
      return false;
    }

    if (pendingMaskFrames.has(key)) {
      if (isActiveFrame) {
        pruneStaleQueuedMaskFrames(mediaTime, key);
        promotePendingMaskFrame(key, mediaTime);
      }

      return false;
    }

    if (isActiveFrame) {
      pruneStaleQueuedMaskFrames(mediaTime);

      if (pendingMaskFrames.size >= maxPendingFrameCount) {
        evictFarthestQueuedMaskFrame(mediaTime);
      }
    }

    if (!isActiveFrame && pendingMaskFrames.size >= maxPendingFrameCount) {
      return false;
    }

    if (pendingMaskFrames.size >= maxPendingFrameCount) {
      return false;
    }

    pendingMaskFrames.set(key, {
      frame,
      generation,
      key,
      maskStyle,
      mediaTime,
    });

    if (isActiveFrame) {
      queuedMaskFrameKeys.unshift(key);
    } else {
      queuedMaskFrameKeys.push(key);
    }

    if (scheduleOptions.emitDiagnostics !== false) {
      emitDiagnostics();
    }
    pumpMaskFrameQueue();

    return true;
  };

  function pumpMaskFrameQueue() {
    if (scheduledQueuePump || isDestroyed || terminalPreparationError) {
      return;
    }

    scheduledQueuePump = schedulePreparationTask(() => {
      scheduledQueuePump = undefined;
      startQueuedMaskFrameJobs();
    });
  }

  function startQueuedMaskFrameJobs() {
    if (isDestroyed || terminalPreparationError) {
      return;
    }

    while (
      queuedMaskFrameKeys.length > 0 &&
      inFlightMaskFrames.size < getMaxInFlightMaskFrameCount()
    ) {
      const key = queuedMaskFrameKeys.shift();

      if (!key) {
        return;
      }

      const job = pendingMaskFrames.get(key);

      if (!job || job.generation !== generation) {
        pendingMaskFrames.delete(key);
        emitDiagnostics();
        continue;
      }

      inFlightMaskFrames.add(job);

      if (isDestroyed || job.generation !== generation) {
        pendingMaskFrames.delete(key);
        inFlightMaskFrames.delete(job);
        emitDiagnostics();
        return;
      }

      const instructions = (
        options.resolveInstructions ?? resolveMaskInstructions
      )({
        frame: job.frame,
        maskStyle: job.maskStyle,
        mediaTime: job.mediaTime,
      });

      if (instructions.length === 0) {
        emptyMaskFrameKeys.add(key);
        preparationProgress += 1;
        pendingMaskFrames.delete(key);
        inFlightMaskFrames.delete(job);
        schedulePreparedTargetBatch();
        emitDiagnostics();
        continue;
      }

      void maskFramePreparer
        .prepare({
          instructions,
          key,
          maxRasterWidth: options.resolveMaxRasterWidth?.(),
        })
        .then((maskFrame) => {
          inFlightMaskFrames.delete(job);
          const pendingJob = pendingMaskFrames.get(key);

          if (pendingJob === job) {
            pendingMaskFrames.delete(key);
          }

          if (
            isDestroyed ||
            job.generation !== generation ||
            pendingJob !== job
          ) {
            maskFrame?.close();
            schedulePreparedTargetBatch();
            emitDiagnostics();
            pumpMaskFrameQueue();
            return;
          }

          if (!maskFrame) {
            emptyMaskFrameKeys.add(key);
            preparationProgress += 1;
            schedulePreparedTargetBatch();
            emitDiagnostics();
            pumpMaskFrameQueue();
            return;
          }

          preparedMaskFrames.set(key, maskFrame);
          preparationProgress += 1;
          evictPreparedMaskFrames();
          options.onMaskFramePrepared?.(maskFrame);
          schedulePreparedTargetBatch();
          emitDiagnostics();
          pumpMaskFrameQueue();
        })
        .catch((error: unknown) => {
          inFlightMaskFrames.delete(job);
          const pendingJob = pendingMaskFrames.get(key);

          if (pendingJob === job) {
            pendingMaskFrames.delete(key);
          }

          const preparationError = getPreparationError(error);
          const status = maskFramePreparer.getStatus();

          if (
            status.executionMode === RenderPreparationExecutionMode.Worker &&
            status.workerStatus === RenderPreparationWorkerStatus.Error
          ) {
            setTerminalPreparationError(preparationError);
            emitDiagnostics(terminalPreparationError?.message);
            return;
          }

          schedulePreparedTargetBatch();

          if (
            isDestroyed ||
            job.generation !== generation ||
            pendingJob !== job
          ) {
            emitDiagnostics();
            pumpMaskFrameQueue();
            return;
          }

          emitDiagnostics(preparationError.message);
          pumpMaskFrameQueue();
        });

      continue;
    }
  }

  function promotePendingMaskFrame(key: string, mediaTime: number) {
    const job = pendingMaskFrames.get(key);

    if (!job || inFlightMaskFrames.has(job)) {
      return;
    }

    pendingMaskFrames.set(key, {
      ...job,
      mediaTime,
    });
    removeQueuedMaskFrameKey(key);
    queuedMaskFrameKeys.unshift(key);
    emitDiagnostics();
    pumpMaskFrameQueue();
  }

  function pruneStaleQueuedMaskFrames(mediaTime: number, exemptKey?: string) {
    for (let index = queuedMaskFrameKeys.length - 1; index >= 0; index -= 1) {
      const key = queuedMaskFrameKeys[index];
      const job = key ? pendingMaskFrames.get(key) : undefined;

      if (key !== exemptKey && (!job || job.mediaTime < mediaTime)) {
        queuedMaskFrameKeys.splice(index, 1);

        if (key) {
          pendingMaskFrames.delete(key);
        }
      }
    }
  }

  function evictFarthestQueuedMaskFrame(mediaTime: number) {
    let farthestIndex = -1;
    let farthestDistance = -1;

    for (const [index, key] of queuedMaskFrameKeys.entries()) {
      const job = pendingMaskFrames.get(key);

      if (!job) {
        farthestIndex = index;
        break;
      }

      const distance = Math.abs(job.mediaTime - mediaTime);

      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }

    if (farthestIndex < 0) {
      return;
    }

    const [key] = queuedMaskFrameKeys.splice(farthestIndex, 1);

    if (key) {
      pendingMaskFrames.delete(key);
    }
  }

  function dropQueuedMaskFramesBeyondTargets() {
    const targetKeys = new Set(lastPreparedTargetFrames.map(getFrameKey));

    for (let index = queuedMaskFrameKeys.length - 1; index >= 0; index -= 1) {
      const key = queuedMaskFrameKeys[index];

      if (!key || targetKeys.has(key)) {
        continue;
      }

      queuedMaskFrameKeys.splice(index, 1);
      pendingMaskFrames.delete(key);
    }
  }

  function rescanPreparedWindow() {
    if (!activeMaskFrame) {
      return;
    }

    const { mediaTime } = activeMaskFrame;

    schedulePreparedWindow(
      options.detectionTimeline.selectFrame(mediaTime),
      mediaTime,
      { force: true },
    );
  }

  function removeQueuedMaskFrameKey(key: string) {
    const index = queuedMaskFrameKeys.indexOf(key);

    if (index >= 0) {
      queuedMaskFrameKeys.splice(index, 1);
    }
  }

  function observeMaskFrame(frame: DetectionFrame, key: string) {
    const previousFrame = observedMaskFrames.get(key);

    if (previousFrame === frame) {
      return;
    }

    observedMaskFrames.set(key, frame);

    if (!previousFrame) {
      return;
    }

    invalidateMaskFrame(key);
  }

  function invalidateMaskFrame(key: string) {
    lastPreparedBufferSignature = null;
    lastPreparedWindowMediaTime = null;
    removeQueuedMaskFrameKey(key);
    pendingMaskFrames.delete(key);
    emptyMaskFrameKeys.delete(key);

    const maskFrame = preparedMaskFrames.get(key);

    if (!maskFrame) {
      return;
    }

    preparedMaskFrames.delete(key);
    options.onMaskFrameEvicted?.(key);
    maskFrame.close();
  }

  const schedulePreparedWindow = (
    detectionFrame: DetectionFrame | undefined,
    mediaTime: number,
    scheduleOptions: { readonly force?: boolean } = {},
  ) => {
    const bufferState = options.detectionTimeline.getState();
    const bufferSignature = [
      bufferState.bufferStartTime,
      bufferState.bufferEndTime,
      bufferState.frameCount,
      bufferState.detectionCount,
    ].join(":");
    const frameKey = detectionFrame ? getFrameKey(detectionFrame) : null;
    const shouldTopUpPreparedWindow = shouldTopUpPreparedWindowAtLowWatermark();
    const shouldScanWindow =
      scheduleOptions.force ||
      bufferSignature !== lastPreparedBufferSignature ||
      lastPreparedWindowMediaTime === null ||
      mediaTime < lastPreparedWindowMediaTime ||
      mediaTime - lastPreparedWindowMediaTime >=
        preparedWindowScanIntervalSeconds ||
      shouldTopUpPreparedWindow;

    if (!shouldScanWindow) {
      return;
    }

    lastPreparedBufferSignature = bufferSignature;
    lastPreparedWindowMediaTime = mediaTime;

    const anchorTime = detectionFrame?.mediaTime ?? mediaTime;
    const bufferedFrames = getBufferedDetectionTimelineFrameSnapshot(
      options.detectionTimeline,
    );
    const retainedKeys = getKnownFrameRetentionKeys(bufferedFrames);

    pruneObservedMaskFrames(retainedKeys);
    lastPreparedWindowFrames = timeline.getWindowFrames(
      bufferedFrames,
      anchorTime,
      bufferState.bufferEndTime,
    );

    const targetFrameCount = getPrefetchFrameCount();

    lastPreparedTargetFrames = selectPresentedTargetFrames({
      stride: getPresentedFrameStride(),
      targetFrameCount,
      windowFrames: lastPreparedWindowFrames,
    });

    if (
      detectionFrame &&
      !lastPreparedTargetFrames.some((frame) => getFrameKey(frame) === frameKey)
    ) {
      lastPreparedTargetFrames = [
        detectionFrame,
        ...lastPreparedTargetFrames,
      ].slice(0, targetFrameCount);
    }

    schedulePreparedTargetBatch({ force: scheduleOptions.force });
  };

  function shouldTopUpPreparedWindowAtLowWatermark() {
    if (
      !activeMaskFrame ||
      getPrefetchFrameCount() === 0 ||
      lastPreparedWindowFrames.length === 0 ||
      lastPreparedTargetFrames.length < getPrefetchFrameCount()
    ) {
      return false;
    }

    const preparedAhead =
      getPreparedAheadDiagnosticsFor(activeMaskFrame).frameCount;
    const availableAhead = getAvailableAheadFrameCount(activeMaskFrame);
    const effectiveThreshold = Math.min(
      getRefillThresholdFrameCount(),
      availableAhead,
    );

    return (
      preparedAhead <= effectiveThreshold && preparedAhead < availableAhead
    );
  }

  function schedulePreparedTargetBatch(
    batchOptions: { readonly force?: boolean } = {},
  ) {
    if (isDestroyed || terminalPreparationError) {
      return;
    }

    /* A wait held at the gate does not ask again until it is let through, so
       the hold is what has to keep preparation running. */
    if (!isPlayheadSettled && !batchOptions.force && getGateHold() === null) {
      return;
    }

    let scheduledFrameCount = 0;

    for (const frame of lastPreparedTargetFrames) {
      if (scheduledFrameCount >= scheduleBatchSize) {
        break;
      }

      const scheduled = scheduleBackgroundMaskFrame(frame, {
        emitDiagnostics: false,
      });

      if (scheduled) {
        scheduledFrameCount += 1;
      }
    }

    if (scheduledFrameCount > 0) {
      emitDiagnostics();
    }
  }

  return {
    getFrame,

    getPreparationProgress() {
      return preparationProgress;
    },

    isArtifactPrepared(mediaTime) {
      if (isDestroyed || !maskStyle) {
        return true;
      }

      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

      if (!detectionFrame) {
        return true;
      }

      return (
        getMaskStatus(getFrameKey(detectionFrame)) !==
        PreparedRenderFrameMaskStatus.Pending
      );
    },

    needsPlaybackGateWait(mediaTime, waitOptions) {
      if (isDestroyed || waitOptions.enabled === false) {
        return false;
      }

      return !isReadyForPresentation(
        mediaTime,
        getMinimumAheadSeconds(waitOptions),
      );
    },

    waitForReady(mediaTime, waitOptions, signal) {
      if (waitOptions.enabled === false || signal?.aborted) {
        return Promise.resolve();
      }

      if (terminalPreparationError) {
        return Promise.reject(terminalPreparationError);
      }

      getFrame(mediaTime, { forcePreparedWindow: true });

      if (terminalPreparationError) {
        return Promise.reject(terminalPreparationError);
      }

      if (
        isReadyForPresentation(mediaTime, getMinimumAheadSeconds(waitOptions))
      ) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        const activeWait = {
          mediaTime,
          requiredAheadSeconds: getRequiredAheadSeconds(waitOptions),
        };
        const endWait = () => {
          readinessWaiters.delete(checkReady);
          activeReadinessWaits.delete(activeWait);
          signal?.removeEventListener("abort", abandonWait);
        };
        const abandonWait = () => {
          endWait();
          resolve();
        };
        const checkReady = () => {
          if (terminalPreparationError) {
            endWait();
            reject(terminalPreparationError);
            return;
          }

          if (
            !isDestroyed &&
            !isReadyForPresentation(mediaTime, activeWait.requiredAheadSeconds)
          ) {
            return;
          }

          endWait();
          resolve();
        };

        readinessWaiters.add(checkReady);
        activeReadinessWaits.add(activeWait);
        signal?.addEventListener("abort", abandonWait);
        emitDiagnostics();
      });
    },

    setPlaybackActive(active) {
      if (isDestroyed || active === isPlaybackActive) {
        return;
      }

      isPlaybackActive = active;
      /* Whichever way this goes, the gesture that was moving the playhead is
         over, and the window may lead it again. */
      consecutivePlayheadJumpCount = 0;
      isPlayheadSettled = true;
      rescanPreparedWindow();

      if (!active) {
        dropQueuedMaskFramesBeyondTargets();
      }

      emitDiagnostics();
    },

    setTimelineContext(context) {
      timeline.setContext(context);
      lastPreparedWindowMediaTime = null;
      emitDiagnostics();
    },

    setMaskStyle(nextMaskStyle) {
      if (nextMaskStyle === undefined) {
        return;
      }

      const previousMaskStyle = maskStyle;

      maskStyle = nextMaskStyle;

      if (canReuseMaskStyleArtifacts(previousMaskStyle, nextMaskStyle)) {
        emitDiagnostics();
        return;
      }

      clearPreparedMaskFrames();
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      clearPreparedMaskFrames();
      maskFramePreparer.destroy();
      notifyReadinessWaiters();
    },
  };

  function getFrame(
    mediaTime: number,
    getFrameOptions: { readonly forcePreparedWindow?: boolean } = {},
  ) {
    if (isDestroyed) {
      return undefined;
    }

    const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

    if (!detectionFrame) {
      setActiveMaskFrame(null);
      schedulePreparedWindow(undefined, mediaTime, {
        force: getFrameOptions.forcePreparedWindow,
      });
      return undefined;
    }

    const key = getFrameKey(detectionFrame);

    observePresentedFrameStride(key);
    observePlayheadStep(detectionFrame.mediaTime);
    setActiveMaskFrame({
      key,
      mediaTime: detectionFrame.mediaTime,
    });
    scheduleActiveMaskFrame(detectionFrame, mediaTime);
    schedulePreparedWindow(detectionFrame, mediaTime, {
      force: getFrameOptions.forcePreparedWindow,
    });

    return {
      detectionFrame,
      key,
      maskFrame: preparedMaskFrames.get(key),
      maskStatus: getMaskStatus(key),
    };
  }

  function emitDiagnostics(message?: string) {
    const status = maskFramePreparer.getStatus();
    const preparedAhead = getPreparedAheadDiagnostics();
    const maxInFlightCount = getMaxInFlightMaskFrameCount();
    const gateHold = getGateHold();

    options.renderPreparation?.onDiagnostics?.({
      artifacts: [
        {
          activeFrame: activeMaskFrame
            ? {
                key: activeMaskFrame.key,
                mediaTime: activeMaskFrame.mediaTime,
                status: toArtifactFrameStatus(
                  getMaskStatus(activeMaskFrame.key),
                ),
              }
            : null,
          gateHold,
          inFlightCount: inFlightMaskFrames.size,
          kind: options.artifactKind ?? RenderPreparationArtifactKind.MaskFrame,
          maxInFlightCount,
          maxPendingCount: maxPendingFrameCount,
          maxPreparedCount: maxMaskFrameCacheSize,
          pendingCount: pendingMaskFrames.size,
          preparedAheadFrameCount: preparedAhead.frameCount,
          preparedAheadSeconds: preparedAhead.seconds,
          prefetchCount: getPrefetchFrameCount(),
          preparedCount: preparedMaskFrames.size,
          refillThresholdCount: getRefillThresholdFrameCount(),
          scheduleBatchSize,
          window: {
            availableFrameCount: lastPreparedWindowFrames.length,
            refillThresholdFrameCount: getRefillThresholdFrameCount(),
            targetFrameCount: lastPreparedTargetFrames.length,
          },
        },
      ],
      executionMode: status.executionMode,
      message: message ?? status.message,
      workerStatus: status.workerStatus,
    });
    notifyReadinessWaiters();
    options.onPreparedWindowChange?.();
  }

  function evictPreparedMaskFrames() {
    while (preparedMaskFrames.size > maxMaskFrameCacheSize) {
      const evictedKey = findPreparedMaskFrameEvictionCandidate();

      if (evictedKey === undefined) {
        return;
      }

      const maskFrame = preparedMaskFrames.get(evictedKey);

      preparedMaskFrames.delete(evictedKey);
      options.onMaskFrameEvicted?.(evictedKey);
      maskFrame?.close();
    }
  }

  function pruneObservedMaskFrames(retainedKeys: ReadonlySet<string>) {
    for (const key of observedMaskFrames.keys()) {
      if (!retainedKeys.has(key)) {
        observedMaskFrames.delete(key);
      }
    }
  }

  function findPreparedMaskFrameEvictionCandidate() {
    const targetKeys = new Set(lastPreparedTargetFrames.map(getFrameKey));
    const activeKey = activeMaskFrame?.key ?? null;

    return (
      findFarthestPreparedMaskFrame(
        (key) => key !== activeKey && !targetKeys.has(key),
      ) ?? findFarthestPreparedMaskFrame((key) => key !== activeKey)
    );
  }

  /**
   * The cache is a span around the playhead rather than a queue behind it. A
   * cache emptied in cook order empties from the ground the playhead just
   * crossed, which is the ground a reversing gesture reaches first.
   */
  function findFarthestPreparedMaskFrame(canEvict: (key: string) => boolean) {
    const playheadMediaTime = activeMaskFrame?.mediaTime;
    let farthestKey: string | undefined;
    let farthestDistance = -1;

    for (const key of preparedMaskFrames.keys()) {
      if (!canEvict(key)) {
        continue;
      }

      const frameMediaTime = observedMaskFrames.get(key)?.mediaTime;
      const distance =
        playheadMediaTime === undefined || frameMediaTime === undefined
          ? Number.POSITIVE_INFINITY
          : Math.abs(frameMediaTime - playheadMediaTime);

      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestKey = key;
      }
    }

    return farthestKey;
  }

  function clearPreparedMaskFrames() {
    generation += 1;
    lastPreparedBufferSignature = null;
    lastPreparedWindowMediaTime = null;
    lastPreparedWindowFrames = [];
    lastPreparedTargetFrames = [];

    if (scheduledQueuePump) {
      cancelScheduledPreparationTask(scheduledQueuePump);
      scheduledQueuePump = undefined;
    }

    pendingMaskFrames.clear();
    queuedMaskFrameKeys.length = 0;
    emptyMaskFrameKeys.clear();
    observedMaskFrames.clear();

    if (preparedMaskFrames.size > 0) {
      const maskFrames = Array.from(preparedMaskFrames.values());

      preparedMaskFrames.clear();
      options.onMaskFramesCleared?.();

      for (const maskFrame of maskFrames) {
        maskFrame.close();
      }
    }

    emitDiagnostics();
  }

  function setTerminalPreparationError(error: Error) {
    if (terminalPreparationError) {
      return;
    }

    terminalPreparationError = error;

    if (scheduledQueuePump) {
      cancelScheduledPreparationTask(scheduledQueuePump);
      scheduledQueuePump = undefined;
    }

    pendingMaskFrames.clear();
    queuedMaskFrameKeys.length = 0;
  }

  function getMaskStatus(key: string) {
    if (!maskStyle) {
      return PreparedRenderFrameMaskStatus.Disabled;
    }

    if (preparedMaskFrames.has(key)) {
      return PreparedRenderFrameMaskStatus.Prepared;
    }

    if (emptyMaskFrameKeys.has(key)) {
      return PreparedRenderFrameMaskStatus.Empty;
    }

    return PreparedRenderFrameMaskStatus.Pending;
  }

  function setActiveMaskFrame(
    nextActiveFrame: {
      readonly key: string;
      readonly mediaTime: number;
    } | null,
  ) {
    const nextSignature = nextActiveFrame
      ? `${nextActiveFrame.key}:${nextActiveFrame.mediaTime}`
      : null;

    activeMaskFrame = nextActiveFrame;

    if (nextSignature === activeMaskFrameSignature) {
      return;
    }

    activeMaskFrameSignature = nextSignature;
    emitDiagnostics();
  }

  function getPreparedAheadDiagnostics() {
    if (!activeMaskFrame) {
      return { frameCount: 0, seconds: 0 };
    }

    return getPreparedAheadDiagnosticsFor(activeMaskFrame);
  }

  function getPreparedAheadDiagnosticsFor(frameRef: {
    readonly key: string;
    readonly mediaTime: number;
  }) {
    const targetFrameIndex = lastPreparedTargetFrames.findIndex(
      (frame) => getFrameKey(frame) === frameRef.key,
    );
    const frames =
      targetFrameIndex >= 0
        ? lastPreparedTargetFrames
        : lastPreparedWindowFrames;
    const activeFrameIndex =
      targetFrameIndex >= 0
        ? targetFrameIndex
        : frames.findIndex((frame) => getFrameKey(frame) === frameRef.key);

    if (activeFrameIndex < 0) {
      return { frameCount: 0, seconds: 0 };
    }

    let frameCount = 0;
    let latestPreparedTime = frameRef.mediaTime;

    for (const frame of frames.slice(activeFrameIndex)) {
      const key = getFrameKey(frame);

      if (!preparedMaskFrames.has(key) && !emptyMaskFrameKeys.has(key)) {
        break;
      }

      frameCount += 1;
      latestPreparedTime = frame.mediaTime;
    }

    return {
      frameCount,
      seconds: timeline.getFrameDistance(
        latestPreparedTime,
        frameRef.mediaTime,
      ),
    };
  }

  function getAvailableAheadFrameCount(frameRef: {
    readonly key: string;
    readonly mediaTime: number;
  }) {
    const activeFrameIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === frameRef.key,
    );

    if (activeFrameIndex < 0) {
      return 0;
    }

    return lastPreparedWindowFrames.length - activeFrameIndex;
  }

  /**
   * The furthest a run of prepared frames starting here can ever reach. The run
   * is read out of a cache holding a fixed number of frames, and eviction takes
   * the frame farthest from the playhead, so a lead demanded beyond this span
   * is one no amount of preparation delivers. Unbounded while the playhead sits
   * outside the scanned window, the only place the span can be read from.
   */
  function getCacheReachableAheadSeconds(frameRef: {
    readonly key: string;
    readonly mediaTime: number;
  }) {
    const activeFrameIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === frameRef.key,
    );

    if (activeFrameIndex < 0) {
      return Number.POSITIVE_INFINITY;
    }

    const lastReachableFrame =
      lastPreparedWindowFrames[
        Math.min(
          lastPreparedWindowFrames.length,
          activeFrameIndex + maxMaskFrameCacheSize,
        ) - 1
      ];

    return timeline.getFrameDistance(
      lastReachableFrame.mediaTime,
      frameRef.mediaTime,
    );
  }

  function getPreparedTargetAheadSeconds(frameRef: {
    readonly key: string;
    readonly mediaTime: number;
  }) {
    const activeFrameIndex = lastPreparedTargetFrames.findIndex(
      (frame) => getFrameKey(frame) === frameRef.key,
    );

    if (activeFrameIndex < 0) {
      return 0;
    }

    const lastTargetFrame =
      lastPreparedTargetFrames[lastPreparedTargetFrames.length - 1];

    if (!lastTargetFrame) {
      return 0;
    }

    return timeline.getFrameDistance(
      lastTargetFrame.mediaTime,
      frameRef.mediaTime,
    );
  }

  /**
   * The hold this gate would apply to the given frame, or null when it would
   * let playback through. Only the gate can name its own hold: the requirement
   * a wait has to clear is capped by the live target window, and the distance
   * to enter a hold is not the distance to leave one, so a host holding the
   * options still cannot work out which of the two stopped the picture.
   */
  function getPresentationHold(
    mediaTime: number,
    requiredAheadSeconds: number,
  ): RenderPreparationGateHoldDiagnostics | null {
    if (isDestroyed || !maskStyle) {
      return null;
    }

    const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

    if (!detectionFrame) {
      return null;
    }

    const frameRef = {
      key: getFrameKey(detectionFrame),
      mediaTime: detectionFrame.mediaTime,
    };
    const activeStatus = getMaskStatus(frameRef.key);
    const requiredLeadSeconds = Math.min(
      Math.max(requiredAheadSeconds, 0),
      getPreparedTargetAheadSeconds(frameRef),
      getCacheReachableAheadSeconds(frameRef),
    );

    if (activeStatus === PreparedRenderFrameMaskStatus.Pending) {
      return {
        reason: RenderPreparationGateHoldReason.ActiveFrameUnprepared,
        requiredAheadSeconds: requiredLeadSeconds,
      };
    }

    if (requiredAheadSeconds <= 0) {
      return null;
    }

    if (
      getPreparedAheadDiagnosticsFor(frameRef).seconds >= requiredLeadSeconds
    ) {
      return null;
    }

    return {
      reason: RenderPreparationGateHoldReason.LeadBelowRequirement,
      requiredAheadSeconds: requiredLeadSeconds,
    };
  }

  function isReadyForPresentation(
    mediaTime: number,
    requiredAheadSeconds: number,
  ) {
    return getPresentationHold(mediaTime, requiredAheadSeconds) === null;
  }

  /**
   * Re-read on every emission rather than cached from the last check, because a
   * hold ends without anything calling the gate again.
   */
  function getGateHold() {
    for (const wait of activeReadinessWaits) {
      const hold = getPresentationHold(
        wait.mediaTime,
        wait.requiredAheadSeconds,
      );

      if (hold) {
        return hold;
      }
    }

    return null;
  }

  function notifyReadinessWaiters() {
    for (const waiter of Array.from(readinessWaiters)) {
      waiter();
    }
  }

  function getRequiredAheadSeconds(
    waitOptions: RenderPreparationPlaybackGateOptions,
  ) {
    return Math.max(waitOptions.requiredAheadSeconds ?? 0, 0);
  }

  function getMinimumAheadSeconds(
    waitOptions: RenderPreparationPlaybackGateOptions,
  ) {
    const requiredAheadSeconds = getRequiredAheadSeconds(waitOptions);

    return Math.min(
      Math.max(waitOptions.minimumAheadSeconds ?? requiredAheadSeconds, 0),
      requiredAheadSeconds,
    );
  }

  function createPreparer() {
    return createMaskFramePreparer({
      onStatusChange: emitDiagnostics,
      renderPreparation: options.renderPreparation,
    });
  }

  /**
   * How many timeline frames the playhead crossed to reach this one. Above 1x
   * the playhead skips source frames the display never paints, and cooking
   * those spends the throughput that the frames it does paint need.
   */
  function observePresentedFrameStride(nextKey: string) {
    const previousKey = activeMaskFrame?.key;

    if (!previousKey || previousKey === nextKey) {
      return;
    }

    const previousIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === previousKey,
    );
    const nextIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === nextKey,
    );

    if (previousIndex < 0 || nextIndex < 0) {
      return;
    }

    const stride = nextIndex - previousIndex;

    if (stride <= 0 || stride > MAX_PRESENTED_FRAME_STRIDE) {
      return;
    }

    presentedFrameStrideSamples.push(stride);

    if (
      presentedFrameStrideSamples.length > PRESENTED_FRAME_STRIDE_SAMPLE_COUNT
    ) {
      presentedFrameStrideSamples.shift();
    }
  }

  /**
   * A playhead one playback step from where it was is a playhead the prefetch
   * can lead, and one jump on its own is a seek that lands. A run of jumps is a
   * drag, and the frames a prefetch picks for it are frames it has gone past.
   */
  function observePlayheadStep(mediaTime: number) {
    const previousMediaTime = previousActiveFrameMediaTime;

    previousActiveFrameMediaTime = mediaTime;

    /* One presented frame is drawn several times over, and a redraw of the
       frame already on screen says nothing about how the playhead is moving. */
    if (previousMediaTime === null || mediaTime === previousMediaTime) {
      return;
    }

    const advance = mediaTime - previousMediaTime;

    if (advance > 0 && advance <= getSettledPlayheadAdvanceSeconds()) {
      consecutivePlayheadJumpCount = 0;
      isPlayheadSettled = true;
      return;
    }

    consecutivePlayheadJumpCount += 1;
    isPlayheadSettled =
      consecutivePlayheadJumpCount < DRAGGED_PLAYHEAD_JUMP_COUNT;
  }

  function getSettledPlayheadAdvanceSeconds() {
    const [firstFrame, secondFrame] = lastPreparedWindowFrames;

    if (!firstFrame || !secondFrame) {
      return preparedWindowScanIntervalSeconds;
    }

    return (
      (secondFrame.mediaTime - firstFrame.mediaTime) *
      MAX_PRESENTED_FRAME_STRIDE
    );
  }

  /**
   * A cadence only counts once it has repeated, which is what separates it from
   * a seek, and the narrowest of those repeats is what the cooks follow, so
   * jitter costs cooks rather than coverage. A paused playhead presents every
   * frame it lands on, whatever it was doing before it stopped.
   */
  function getPresentedFrameStride() {
    if (
      !isPlaybackActive ||
      presentedFrameStrideSamples.length < PRESENTED_FRAME_STRIDE_SAMPLE_COUNT
    ) {
      return 1;
    }

    return Math.min(...presentedFrameStrideSamples);
  }

  function getPrefetchFrameCount() {
    return isPlaybackActive ? prefetchFrameCount : pausedPrefetchFrameCount;
  }

  function getRefillThresholdFrameCount() {
    return isPlaybackActive
      ? refillThresholdFrameCount
      : pausedRefillThresholdFrameCount;
  }

  function getMaxInFlightMaskFrameCount() {
    const status = maskFramePreparer.getStatus();

    if (status.executionMode === RenderPreparationExecutionMode.Worker) {
      return workerCount;
    }

    return 1;
  }

  function getKnownFrameRetentionKeys(frames: readonly DetectionFrame[]) {
    const retainedKeys = new Set(frames.map(getFrameKey));

    for (const key of preparedMaskFrames.keys()) {
      retainedKeys.add(key);
    }

    for (const key of pendingMaskFrames.keys()) {
      retainedKeys.add(key);
    }

    for (const key of emptyMaskFrameKeys) {
      retainedKeys.add(key);
    }

    return retainedKeys;
  }

  function scheduleActiveMaskFrame(frame: DetectionFrame, mediaTime: number) {
    return scheduleMaskFrame(frame, mediaTime, {
      priority: PreparedRenderSchedulePriority.Active,
    });
  }

  function scheduleBackgroundMaskFrame(
    frame: DetectionFrame,
    options: { readonly emitDiagnostics?: boolean } = {},
  ) {
    return scheduleMaskFrame(frame, frame.mediaTime, {
      emitDiagnostics: options.emitDiagnostics,
      priority: PreparedRenderSchedulePriority.Background,
    });
  }
}

function toArtifactFrameStatus(status: PreparedRenderFrameMaskStatus) {
  if (status === PreparedRenderFrameMaskStatus.Disabled) {
    return RenderPreparationArtifactFrameStatus.Disabled;
  }

  if (status === PreparedRenderFrameMaskStatus.Empty) {
    return RenderPreparationArtifactFrameStatus.Empty;
  }

  if (status === PreparedRenderFrameMaskStatus.Prepared) {
    return RenderPreparationArtifactFrameStatus.Prepared;
  }

  return RenderPreparationArtifactFrameStatus.Pending;
}

function resolveMaskInstructions(options: {
  readonly frame: DetectionFrame;
  readonly maskStyle: MaskStyle;
  readonly mediaTime: number;
}) {
  const instructions: SerializableMaskInstruction[] = [];

  const orderedDetections = options.frame.detections
    .map((detection, detectionIndex) => ({ detection, detectionIndex }))
    .sort(
      (left, right) =>
        (left.detection.zIndex ?? left.detectionIndex) -
        (right.detection.zIndex ?? right.detectionIndex),
    );

  for (const { detectionIndex, detection } of orderedDetections) {
    const instruction = options.maskStyle.resolve(detection, {
      detectionIndex,
      frame: options.frame,
      mediaTime: options.mediaTime,
    });

    if (instruction) {
      instructions.push({
        ...instruction,
        detectionIndex,
      });
    }
  }

  return instructions;
}

function getFrameKey(frame: DetectionFrame) {
  return `${frame.frameIndex ?? "time"}:${frame.mediaTime}`;
}

function getPreparationError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error("Unable to prepare mask frame.");
}

/**
 * The playhead's own frame plus one schedule batch ahead. A batch is the most
 * this window commits to in one pass, so a resting playhead holds a single pass
 * of work, and a step forward still lands on a frame already cooked.
 */
function getPausedPreparedWindowFrameCount(options: {
  readonly prefetchFrameCount: number;
  readonly scheduleBatchSize: number;
}) {
  return Math.min(options.prefetchFrameCount, options.scheduleBatchSize + 1);
}

/**
 * The same number of cooks, spread over the frames the display will paint. The
 * walk starts on the playhead's own frame, so the frames it picks are the ones
 * the playhead will land on rather than the ones between them.
 */
function selectPresentedTargetFrames(options: {
  readonly stride: number;
  readonly targetFrameCount: number;
  readonly windowFrames: readonly DetectionFrame[];
}) {
  if (options.stride <= 1) {
    return options.windowFrames.slice(0, options.targetFrameCount);
  }

  const targetFrames: DetectionFrame[] = [];

  for (
    let index = 0;
    index < options.windowFrames.length &&
    targetFrames.length < options.targetFrameCount;
    index += options.stride
  ) {
    const frame = options.windowFrames[index];

    if (frame) {
      targetFrames.push(frame);
    }
  }

  return targetFrames;
}

function getPreparedWindowRefillThresholdFrameCount(
  prefetchFrameCount: number,
) {
  if (prefetchFrameCount <= 1) {
    return 0;
  }

  return Math.max(
    1,
    Math.floor(prefetchFrameCount * PREPARED_WINDOW_REFILL_RATIO),
  );
}

function schedulePreparationTask(
  callback: () => void,
): ScheduledPreparationTask {
  return setTimeout(callback, 0);
}

function cancelScheduledPreparationTask(task: ScheduledPreparationTask) {
  clearTimeout(task);
}
