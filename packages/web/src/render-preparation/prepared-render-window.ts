import {
  createMaskFramePreparer,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-preparer";
import { getBrowserMaskPreparationWorkerCount } from "#render-preparation/mask-preparation-worker-count";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import {
  createPlayheadMotion,
  createPresentedFrameStride,
  getPausedPreparedWindowFrameCount,
  MAX_PRESENTED_FRAME_STRIDE,
} from "#render-preparation/playhead-motion";
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
  type ResolvedRenderPreparationGateThresholds,
} from "#types/render-preparation";
import { canReuseMaskStyleArtifacts } from "supervision-js-core";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";

/* Rapid playhead movement uses smaller mask rasters. Once the playhead
   rests, the visible frame is upgraded to its full raster width. */
export enum PreparedRasterTier {
  Coarse = "coarse",
  Fine = "fine",
}
const DEFAULT_MASK_PREVIEW_SCALE = 0.5;
/* A step wider than this many frame strides is fast playback, not a scrub. */
const FAST_PLAYHEAD_STRIDES = 3.5;
const FAST_PLAYHEAD_STEP_COUNT = 2;
/* How long without a playhead step before the frame on screen is owed its
   fine cook. */
const SETTLE_AFTER_MS = 150;

const DEFAULT_MASK_FRAME_CACHE_SIZE = 24;
/* 64 MB per GB of device memory as Chrome reports it, clamped to [256 MB,
   1 GB]. An id-mask frame at this raster size is ~1.7 MB of plane plus ~1.7 MB
   of R8 texture, so 1 GB holds ~300 frames, ten seconds at 30 fps — more than
   the 8 s default this replaces, in the unit that actually bounds memory. */
const DEFAULT_MASK_FRAME_CACHE_BYTES = Math.min(
  1024 * 1024 * 1024,
  Math.max(
    256 * 1024 * 1024,
    Math.round(
      ((typeof navigator !== "undefined" &&
        (navigator as { deviceMemory?: number }).deviceMemory) ||
        4) *
        64 *
        1024 *
        1024,
    ),
  ),
);
const DEFAULT_MASK_PENDING_FRAME_COUNT = 8;
const DEFAULT_MASK_PREFETCH_FRAME_COUNT = 12;
export const DEFAULT_MASK_SCHEDULE_BATCH_SIZE = 2;
const DEFAULT_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS = 0.15;
const PREPARED_WINDOW_REFILL_RATIO = 5 / 7;

type ScheduledPreparationTask = ReturnType<typeof setTimeout>;

interface PendingMaskFrame {
  /** Raster tier this cook produces; coarse while the playhead flings. */
  readonly tier: PreparedRasterTier;
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
  /** Revision of the prepared artifact, including replacements at the same time. */
  getArtifactRevision(mediaTime: number): number;
  /** Recooks the active frame and its targets after the display raster size changes. */
  invalidateRasterSize(): void;
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
    options: ResolvedRenderPreparationGateThresholds,
  ): boolean;
  /**
   * Resolves once the media time may be presented. `signal` is how a caller
   * that has moved on says so: aborting resolves the wait and drops the hold it
   * was placing on preparation, because a caller that walked away re-checks
   * whatever it does next anyway. Without one, an abandoned wait holds forever.
   */
  waitForReady(
    mediaTime: number,
    options: ResolvedRenderPreparationGateThresholds,
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
  readonly maxMaskFrameCacheBytes?: number;
  /** Reserves renderer backing before a prepared frame can be drawn. */
  readonly resolveMaskFrameBackingBytes?: (frame: PreparedMaskFrame) => number;
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
  const requestedPreviewScale = maskFrameOptions?.previewScale;
  const previewScale =
    requestedPreviewScale !== undefined &&
    Number.isFinite(requestedPreviewScale) &&
    requestedPreviewScale > 0 &&
    requestedPreviewScale <= 1
      ? requestedPreviewScale
      : DEFAULT_MASK_PREVIEW_SCALE;
  const requiresFineGate =
    options.renderPreparation?.playbackGate?.quality === "fine";
  const maxMaskFrameCacheSize = Math.max(
    1,
    Math.floor(
      options.maxMaskFrameCacheSize ??
        maskFrameOptions?.maxCacheFrameCount ??
        DEFAULT_MASK_FRAME_CACHE_SIZE,
    ) || DEFAULT_MASK_FRAME_CACHE_SIZE,
  );
  /* A cache sized in seconds is right for playback and wrong for a drag: 8 s
     evicts under any wide scrub (one re-cook per cook, measured), 90 s holds a
     70 s clip but costs 2.4 GB. Bytes are the honest unit. The count above
     stays as a ceiling; this budget is what actually bounds memory, and it is
     charged from each frame's payload and reserved texture backing, so it
     needs no guess about raster size up front. Default mirrors the engine's frame cache:
     per GB of device memory, clamped. */
  const requestedMaskFrameCacheBytes =
    options.maxMaskFrameCacheBytes ??
    maskFrameOptions?.maxCacheBytes ??
    DEFAULT_MASK_FRAME_CACHE_BYTES;
  const maxMaskFrameCacheBytes = Math.max(
    16 * 1024 * 1024,
    Math.floor(
      Number.isNaN(requestedMaskFrameCacheBytes)
        ? DEFAULT_MASK_FRAME_CACHE_BYTES
        : requestedMaskFrameCacheBytes,
    ),
  );
  let preparedMaskBytes = 0;
  const preparedMaskBytesByKey = new Map<string, number>();

  function chargeMaskFrame(
    key: string,
    maskFrame: PreparedMaskFrame,
    tier: PreparedRasterTier,
  ) {
    const pixels = maskFrame.width * maskFrame.height;
    const payloadBytes =
      maskFrame.kind === PreparedMaskFrameKind.IdMask
        ? maskFrame.raster.byteLength +
          maskFrame.fillPalette.byteLength +
          maskFrame.strokePalette.byteLength +
          maskFrame.strokeWidths.byteLength
        : pixels * 4 + (maskFrame.idMaskPlane?.data.byteLength ?? 0);
    const coverageBytes =
      maskFrame.regionMaskCoverage?.entries.reduce(
        (total, entry) => total + entry.data.byteLength,
        0,
      ) ?? 0;
    const backingBytes = options.resolveMaskFrameBackingBytes
      ? options.resolveMaskFrameBackingBytes(maskFrame)
      : pixels * (maskFrame.kind === PreparedMaskFrameKind.IdMask ? 1 : 4);
    const strokeBytes =
      maskFrame.screenStrokes?.reduce(
        (total, stroke) =>
          total + stroke.paths.reduce((sum, path) => sum + path.byteLength, 0),
        0,
      ) ?? 0;
    const bytes = Math.max(
      1,
      payloadBytes + coverageBytes + strokeBytes + backingBytes,
    );
    preparedMaskBytesByKey.set(key, bytes);
    preparedMaskBytes += bytes;
    largestMaskFrameBytesByTier.set(
      tier,
      Math.max(largestMaskFrameBytesByTier.get(tier) ?? 0, bytes),
    );
    return bytes;
  }

  function releaseMaskFrame(key: string) {
    const bytes = preparedMaskBytesByKey.get(key);
    if (bytes === undefined) return;
    preparedMaskBytesByKey.delete(key);
    preparedMaskBytes -= bytes;
  }
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
  let requestedPreparedTargetFrames: readonly DetectionFrame[] = [];
  let lastPreparedTargetFrames: readonly DetectionFrame[] = [];
  const timeline = createPreparedWindowTimeline();
  let activeMaskFrame: {
    readonly key: string;
    readonly mediaTime: number;
  } | null = null;
  let activeMaskFrameSignature: string | null = null;
  const presentedFrameStride = createPresentedFrameStride();
  const playheadMotion = createPlayheadMotion();
  let previousActiveFrameMediaTime: number | null = null;
  /* A step wider than a few frame strides is fast playback; its cooks go
     coarse so the prefetch window stays cheap and small. */
  let isPlayheadFast = false;
  let consecutiveWideStepCount = 0;
  /* Fires when steps stop: a paused playhead is settled and owed a fine cook. */
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSteppedMediaTime: number | null = null;
  let isDestroyed = false;
  let generation = 0;
  let preparationProgress = 0;
  let nextArtifactRevision = 0;
  const artifactRevisions = new WeakMap<PreparedMaskFrame, number>();
  const largestMaskFrameBytesByTier = new Map<PreparedRasterTier, number>();
  const preparedMaskFrames = new Map<string, PreparedMaskFrame>();
  /** Keys whose prepared raster is the coarse tier and owed a fine cook once settled. */
  const coarseMaskFrameKeys = new Set<string>();
  const pendingMaskFrames = new Map<string, PendingMaskFrame>();
  const queuedMaskFrameKeys: string[] = [];
  const inFlightMaskFrames = new Set<PendingMaskFrame>();
  const fineUpgradeRequests = new Set<PendingMaskFrame>();
  const emptyMaskFrameKeys = new Set<string>();
  // Detection frames are immutable snapshots. A new object at an existing
  // timeline key therefore represents a source revision for that artifact.
  const observedMaskFrames = new Map<string, DetectionFrame>();
  const readinessWaiters = new Set<() => void>();
  const activeReadinessWaits = new Set<{
    readonly mediaTime: number;
    readonly resumeAtSeconds: number;
  }>();
  let scheduledQueuePump: ScheduledPreparationTask | undefined;
  let terminalPreparationError: Error | null = null;

  const scheduleMaskFrame = (
    frame: DetectionFrame,
    mediaTime: number,
    scheduleOptions: {
      readonly emitDiagnostics?: boolean;
      readonly priority: PreparedRenderSchedulePriority;
      readonly tier?: PreparedRasterTier;
    },
  ) => {
    const key = getFrameKey(frame);
    const isActiveFrame =
      scheduleOptions.priority === PreparedRenderSchedulePriority.Active;

    if (!maskStyle || isDestroyed || terminalPreparationError) {
      return false;
    }

    observeMaskFrame(frame, key);
    const tier = scheduleOptions.tier ?? getRequestedRasterTier();
    if (emptyMaskFrameKeys.has(key)) {
      return false;
    }
    if (preparedMaskFrames.has(key)) {
      const owedFine =
        coarseMaskFrameKeys.has(key) && tier === PreparedRasterTier.Fine;
      if (!owedFine) {
        return false;
      }
    }

    const pending = pendingMaskFrames.get(key);
    if (pending) {
      if (
        tier === PreparedRasterTier.Fine &&
        pending.tier === PreparedRasterTier.Coarse
      ) {
        if (inFlightMaskFrames.has(pending)) {
          fineUpgradeRequests.add(pending);
        } else {
          pendingMaskFrames.set(key, { ...pending, tier });
        }
      }
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
      tier,
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
          maxRasterWidth: resolveRasterWidthFor(job.tier),
        })
        .then((maskFrame) => {
          inFlightMaskFrames.delete(job);
          const upgradeToFine = fineUpgradeRequests.delete(job);
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

          const previous = preparedMaskFrames.get(key);
          if (previous) {
            // an upgrade: the coarse raster gives way to the fine one
            releaseMaskFrame(key);
            options.onMaskFrameEvicted?.(key);
            previous.close();
          }
          preparedMaskFrames.set(key, maskFrame);
          artifactRevisions.set(maskFrame, ++nextArtifactRevision);
          const bytes = chargeMaskFrame(key, maskFrame, job.tier);
          if (
            job.tier === PreparedRasterTier.Coarse &&
            maskFrameNeedsRasterSizeChange(
              key,
              maskFrame,
              PreparedRasterTier.Fine,
            )
          ) {
            coarseMaskFrameKeys.add(key);
          } else {
            coarseMaskFrameKeys.delete(key);
            if (job.tier === PreparedRasterTier.Coarse) {
              largestMaskFrameBytesByTier.set(
                PreparedRasterTier.Fine,
                Math.max(
                  largestMaskFrameBytesByTier.get(PreparedRasterTier.Fine) ?? 0,
                  bytes,
                ),
              );
            }
          }
          refreshPreparedTargetFrames();
          preparationProgress += 1;
          evictPreparedMaskFrames();
          options.onMaskFramePrepared?.(maskFrame);
          if (upgradeToFine && activeMaskFrame?.key === key) {
            scheduleMaskFrame(job.frame, job.mediaTime, {
              priority: PreparedRenderSchedulePriority.Active,
              tier: PreparedRasterTier.Fine,
            });
          }
          schedulePreparedTargetBatch();
          emitDiagnostics();
          pumpMaskFrameQueue();
        })
        .catch((error: unknown) => {
          inFlightMaskFrames.delete(job);
          fineUpgradeRequests.delete(job);
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

      if (!key || targetKeys.has(key) || key === activeMaskFrame?.key) {
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
    coarseMaskFrameKeys.delete(key);
    releaseMaskFrame(key);
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

    requestedPreparedTargetFrames = selectPresentedTargetFrames({
      stride: getPresentedFrameStride(),
      targetFrameCount,
      windowFrames: lastPreparedWindowFrames,
    });

    if (
      detectionFrame &&
      !requestedPreparedTargetFrames.some(
        (frame) => getFrameKey(frame) === frameKey,
      )
    ) {
      requestedPreparedTargetFrames = [
        detectionFrame,
        ...requestedPreparedTargetFrames,
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

    refreshPreparedTargetFrames();

    /* A wait held at the gate does not ask again until it is let through, so
       the hold is what has to keep preparation running. */
    if (
      !playheadMotion.settled &&
      !batchOptions.force &&
      getGateHold() === null
    ) {
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

  /** Keeps warming and gate lead inside the prefix the cache can retain. */
  function refreshPreparedTargetFrames() {
    const targets: DetectionFrame[] = [];
    // The active frame can leave the previous target prefix between scans.
    const activeKey = activeMaskFrame?.key;
    let bytes = activeKey ? getRequiredMaskFrameBytes(activeKey) : 0;
    let cacheFrameCount =
      activeKey && !emptyMaskFrameKeys.has(activeKey) ? 1 : 0;

    for (const frame of requestedPreparedTargetFrames) {
      const key = getFrameKey(frame);
      const isActive = key === activeKey;
      const empty = emptyMaskFrameKeys.has(key);
      const frameBytes = getRequiredMaskFrameBytes(key);

      if (
        !isActive &&
        !empty &&
        (cacheFrameCount >= maxMaskFrameCacheSize ||
          bytes + frameBytes > maxMaskFrameCacheBytes)
      ) {
        break;
      }

      targets.push(frame);
      if (!isActive) {
        bytes += frameBytes;
        if (!empty) cacheFrameCount += 1;
      }
    }

    lastPreparedTargetFrames = targets;
    dropQueuedMaskFramesBeyondTargets();
  }

  function getRequiredMaskFrameBytes(key: string) {
    if (emptyMaskFrameKeys.has(key)) return 0;
    const pending = pendingMaskFrames.get(key);
    const tier =
      pending && fineUpgradeRequests.has(pending)
        ? PreparedRasterTier.Fine
        : (pending?.tier ?? getRequestedRasterTier());
    const estimatedBytes = largestMaskFrameBytesByTier.get(tier) ?? 0;
    const heldBytes = preparedMaskBytesByKey.get(key);
    return heldBytes === undefined
      ? estimatedBytes
      : coarseMaskFrameKeys.has(key) && tier === PreparedRasterTier.Fine
        ? Math.max(heldBytes, estimatedBytes)
        : heldBytes;
  }

  return {
    getFrame,

    getArtifactRevision(mediaTime) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      const artifact = frame && preparedMaskFrames.get(getFrameKey(frame));
      return artifact ? (artifactRevisions.get(artifact) ?? 0) : 0;
    },

    invalidateRasterSize() {
      if (isDestroyed) return;
      if (
        pendingMaskFrames.size === 0 &&
        inFlightMaskFrames.size === 0 &&
        ![...preparedMaskFrames].some(([key, frame]) =>
          maskFrameNeedsRasterSizeChange(key, frame),
        )
      ) {
        return;
      }
      const active = activeMaskFrame;
      const pending = active ? pendingMaskFrames.get(active.key) : undefined;
      const preserveFine =
        active &&
        ((preparedMaskFrames.has(active.key) &&
          !coarseMaskFrameKeys.has(active.key)) ||
          pending?.tier === PreparedRasterTier.Fine ||
          (pending && fineUpgradeRequests.has(pending)));
      clearPreparedMaskFrames();
      if (active) {
        getFrame(active.mediaTime, { forcePreparedWindow: true });
        if (preserveFine) {
          const frame = options.detectionTimeline.selectFrame(active.mediaTime);
          if (frame) {
            scheduleMaskFrame(frame, active.mediaTime, {
              priority: PreparedRenderSchedulePriority.Active,
              tier: PreparedRasterTier.Fine,
            });
          }
        } else if (isPlayheadFast && settleTimer === undefined) {
          armSettleTimer();
        }
      }
    },

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
        getStopBelowSeconds(waitOptions),
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

      if (isReadyForPresentation(mediaTime, getStopBelowSeconds(waitOptions))) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        const activeWait = {
          mediaTime,
          resumeAtSeconds: getResumeAtSeconds(waitOptions),
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
            !isReadyForPresentation(mediaTime, activeWait.resumeAtSeconds)
          ) {
            return;
          }

          endWait();
          resolve();
        };

        readinessWaiters.add(checkReady);
        activeReadinessWaits.add(activeWait);
        signal?.addEventListener("abort", abandonWait);
        try {
          if (requiresFineGate) {
            getFrame(mediaTime, { forcePreparedWindow: true });
          }
          emitDiagnostics();
        } catch (error) {
          endWait();
          reject(error);
        }
      });
    },

    setPlaybackActive(active) {
      if (isDestroyed || active === isPlaybackActive) {
        return;
      }

      isPlaybackActive = active;
      /* Whichever way this goes, the gesture that was moving the playhead is
         over, and the window may lead it again. */
      playheadMotion.endGesture();
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
      if (settleTimer !== undefined) clearTimeout(settleTimer);
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

    const frameStride = observePresentedFrameStride(key);
    observePlayheadStep(detectionFrame.mediaTime, frameStride);
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
          maxPreparedBytes: maxMaskFrameCacheBytes,
          maxPreparedCount: maxMaskFrameCacheSize,
          preparedBytes: preparedMaskBytes,
          coarseCount: coarseMaskFrameKeys.size,
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

  function resolveRasterWidthFor(tier: PreparedRasterTier) {
    const fine = options.resolveMaxRasterWidth?.();
    if (tier === PreparedRasterTier.Fine || fine === undefined) {
      return fine;
    }
    // Align previews for one-channel uploads without exceeding the fitted width.
    return Math.min(
      fine,
      Math.max(64, Math.ceil((fine * previewScale) / 4) * 4),
    );
  }

  function getRequestedRasterTier() {
    return isPlayheadFast &&
      previewScale < 1 &&
      !(
        requiresFineGate &&
        (activeReadinessWaits.size > 0 ||
          (isPlaybackActive &&
            options.renderPreparation?.playbackGate?.enabled === true))
      )
      ? PreparedRasterTier.Coarse
      : PreparedRasterTier.Fine;
  }

  function maskFrameNeedsRasterSizeChange(
    key: string,
    frame: PreparedMaskFrame,
    tier = coarseMaskFrameKeys.has(key)
      ? PreparedRasterTier.Coarse
      : PreparedRasterTier.Fine,
  ) {
    const maxWidth = resolveRasterWidthFor(tier);
    const sourceWidth =
      frame.kind === PreparedMaskFrameKind.IdMask
        ? frame.sourceWidth
        : frame.width;
    const width =
      maxWidth !== undefined && maxWidth > 0
        ? Math.min(sourceWidth, Math.max(1, Math.floor(maxWidth)))
        : sourceWidth;

    return frame.kind === PreparedMaskFrameKind.IdMask
      ? frame.width !== width
      : frame.idMaskPlane !== undefined && frame.idMaskPlane.width !== width;
  }

  function evictPreparedMaskFrames() {
    while (
      preparedMaskFrames.size > maxMaskFrameCacheSize ||
      preparedMaskBytes > maxMaskFrameCacheBytes
    ) {
      const evictedKey = findPreparedMaskFrameEvictionCandidate();

      if (evictedKey === undefined) {
        return;
      }

      const maskFrame = preparedMaskFrames.get(evictedKey);

      preparedMaskFrames.delete(evictedKey);
      coarseMaskFrameKeys.delete(evictedKey);
      releaseMaskFrame(evictedKey);
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
    requestedPreparedTargetFrames = [];
    lastPreparedTargetFrames = [];
    largestMaskFrameBytesByTier.clear();

    if (scheduledQueuePump) {
      cancelScheduledPreparationTask(scheduledQueuePump);
      scheduledQueuePump = undefined;
    }

    pendingMaskFrames.clear();
    fineUpgradeRequests.clear();
    queuedMaskFrameKeys.length = 0;
    emptyMaskFrameKeys.clear();
    observedMaskFrames.clear();

    if (preparedMaskFrames.size > 0) {
      const maskFrames = Array.from(preparedMaskFrames.values());

      preparedMaskFrames.clear();
      coarseMaskFrameKeys.clear();
      preparedMaskBytesByKey.clear();
      preparedMaskBytes = 0;
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

  /**
   * How far prepared work reaches in front of a frame, and how much of that
   * reach is finished. The walk crosses a frame the scheduler already holds
   * without counting it and stops at one nobody has asked for: a queued or
   * in-flight frame is runway that arrives on its own, while a gap no job
   * covers is runway that never fills. A source still appending detections
   * drops a fresh uncooked frame into this span on every record it writes.
   * Whether the frame about to be presented is itself ready is a separate
   * question, asked separately.
   */
  function getPreparedAheadDiagnosticsFor(
    frameRef: {
      readonly key: string;
      readonly mediaTime: number;
    },
    requireFine = requiresFineGate &&
      (options.renderPreparation?.playbackGate?.enabled === true ||
        activeReadinessWaits.size > 0),
  ) {
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

      if (
        emptyMaskFrameKeys.has(key) ||
        (preparedMaskFrames.has(key) &&
          !(requireFine && coarseMaskFrameKeys.has(key)))
      ) {
        frameCount += 1;
        latestPreparedTime = frame.mediaTime;
        continue;
      }

      if (!pendingMaskFrames.has(key)) {
        break;
      }
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

    if (
      activeStatus === PreparedRenderFrameMaskStatus.Pending ||
      (requiresFineGate && coarseMaskFrameKeys.has(frameRef.key))
    ) {
      return {
        reason: RenderPreparationGateHoldReason.ActiveFrameUnprepared,
        requiredAheadSeconds: requiredLeadSeconds,
      };
    }

    if (requiredAheadSeconds <= 0) {
      return null;
    }

    if (
      getPreparedAheadDiagnosticsFor(frameRef, requiresFineGate).seconds >=
      requiredLeadSeconds
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
      const hold = getPresentationHold(wait.mediaTime, wait.resumeAtSeconds);

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

  function getResumeAtSeconds(
    waitOptions: ResolvedRenderPreparationGateThresholds,
  ) {
    return Math.max(waitOptions.resumeAtSeconds, 0);
  }

  function getStopBelowSeconds(
    waitOptions: ResolvedRenderPreparationGateThresholds,
  ) {
    return Math.min(
      Math.max(waitOptions.stopBelowSeconds, 0),
      getResumeAtSeconds(waitOptions),
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

    let previousIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === previousKey,
    );
    let nextIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === nextKey,
    );

    if (previousIndex < 0 || nextIndex < 0) {
      // Reverse steps can leave the prepared window while both frames remain
      // in the detection buffer.
      const bufferedFrames = getBufferedDetectionTimelineFrameSnapshot(
        options.detectionTimeline,
      );
      previousIndex = bufferedFrames.findIndex(
        (frame) => getFrameKey(frame) === previousKey,
      );
      nextIndex = bufferedFrames.findIndex(
        (frame) => getFrameKey(frame) === nextKey,
      );
    }

    if (previousIndex < 0 || nextIndex < 0) {
      return;
    }

    const stride = nextIndex - previousIndex;
    presentedFrameStride.observe(stride);
    return stride;
  }

  /**
   * A playhead one playback step from where it was is a playhead the prefetch
   * can lead, and one jump on its own is a seek that lands. A run of jumps is a
   * drag, and the frames a prefetch picks for it are frames it has gone past.
   */
  function observePlayheadStep(mediaTime: number, frameStride?: number) {
    playheadMotion.observe(mediaTime, getSettledPlayheadAdvanceSeconds());
    const previousMediaTime = previousActiveFrameMediaTime;

    previousActiveFrameMediaTime = mediaTime;

    /* One presented frame is drawn several times over, and a redraw of the
       frame already on screen says nothing about how the playhead is moving. */
    if (previousMediaTime === null || mediaTime === previousMediaTime) {
      return;
    }

    const advance = mediaTime - previousMediaTime;

    lastSteppedMediaTime = mediaTime;

    const stride = getFrameStrideSeconds();

    const isWideStep =
      frameStride === undefined
        ? stride > 0 && Math.abs(advance) > stride * FAST_PLAYHEAD_STRIDES
        : Math.abs(frameStride) > FAST_PLAYHEAD_STRIDES;
    consecutiveWideStepCount = isWideStep ? consecutiveWideStepCount + 1 : 0;
    isPlayheadFast = consecutiveWideStepCount >= FAST_PLAYHEAD_STEP_COUNT;
    /* Only a coarse cook owes a fine one, so only a fling or fast playback
       needs the timer. A step that settles cooks fine on its own. */
    if (isPlayheadFast) {
      armSettleTimer();
    }
  }

  function getFrameStrideSeconds() {
    const [firstFrame, secondFrame] = lastPreparedWindowFrames;
    return firstFrame && secondFrame
      ? secondFrame.mediaTime - firstFrame.mediaTime
      : 0;
  }

  function armSettleTimer() {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (isDestroyed) return;
      /* Only the frame on screen. A stopped drag is still a drag for the window
         around it, so nothing cooks ahead of where the playhead landed. */
      const at = lastSteppedMediaTime;
      const frame =
        at === null ? undefined : options.detectionTimeline.selectFrame(at);
      if (frame && at !== null) {
        scheduleMaskFrame(frame, at, {
          priority: PreparedRenderSchedulePriority.Active,
          tier: PreparedRasterTier.Fine,
        });
      }
    }, SETTLE_AFTER_MS);
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
   * Keeping the intervening source frames lets the cache survive a change in
   * cadence phase without cooking nearby frames again.
   */
  function getPresentedFrameStride() {
    if (!isPlaybackActive) return 1;

    const stride = presentedFrameStride.narrowest();
    const sourceFrameSpan = Math.min(
      lastPreparedWindowFrames.length,
      Math.max(0, (getPrefetchFrameCount() - 1) * stride + 1),
    );
    const largestKnownFrameBytes = Math.max(
      largestMaskFrameBytesByTier.get(PreparedRasterTier.Fine) ?? 0,
      largestMaskFrameBytesByTier.get(PreparedRasterTier.Coarse) ?? 0,
    );
    return sourceFrameSpan <= maxMaskFrameCacheSize &&
      sourceFrameSpan * largestKnownFrameBytes <= maxMaskFrameCacheBytes
      ? stride
      : 1;
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
