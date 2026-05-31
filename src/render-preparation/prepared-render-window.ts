import {
  createMaskFramePreparer,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-preparer";
import { getBrowserMaskPreparationWorkerCount } from "#render-preparation/mask-preparation-worker-count";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { MaskStyle } from "#types/mask-style";
import {
  RenderPreparationExecutionMode,
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  type RenderPreparationOptions,
} from "#types/render-preparation";
import { canReuseMaskStyleArtifacts } from "#utils/mask-style";

const DEFAULT_MASK_FRAME_CACHE_SIZE = 24;
const DEFAULT_MASK_PENDING_FRAME_COUNT = 8;
const DEFAULT_MASK_PREFETCH_FRAME_COUNT = 12;
const DEFAULT_MASK_SCHEDULE_BATCH_SIZE = 2;
const DEFAULT_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS = 0.15;

type ScheduledPreparationTask = ReturnType<typeof setTimeout>;

interface PendingMaskFrame {
  readonly frame: DetectionFrame;
  readonly generation: number;
  readonly key: string;
  readonly maskStyle: MaskStyle;
  readonly mediaTime: number;
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
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  destroy(): void;
}

export type { PreparedMaskFrame } from "./mask-frame-preparer";

export function createPreparedRenderWindow(options: {
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskStyle?: MaskStyle | null;
  readonly maxMaskFrameCacheSize?: number;
  readonly onMaskFrameEvicted?: (key: string) => void;
  readonly onMaskFramePrepared?: (maskFrame: PreparedMaskFrame) => void;
  readonly onMaskFramesCleared?: () => void;
  readonly prefetchFrameCount?: number;
  readonly preparedWindowScanIntervalSeconds?: number;
  readonly renderPreparation?: RenderPreparationOptions;
}): PreparedRenderWindow {
  const maskFrameOptions = options.renderPreparation?.maskFrame;
  const maxMaskFrameCacheSize = Math.max(
    1,
    options.maxMaskFrameCacheSize ??
      maskFrameOptions?.maxCacheFrameCount ??
      DEFAULT_MASK_FRAME_CACHE_SIZE,
  );
  const prefetchFrameCount = Math.max(
    0,
    options.prefetchFrameCount ??
      maskFrameOptions?.prefetchFrameCount ??
      DEFAULT_MASK_PREFETCH_FRAME_COUNT,
  );
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

  let maskStyle = options.maskStyle ?? null;
  let maskFramePreparer = createPreparer();
  let lastPreparedBufferSignature: string | null = null;
  let lastPreparedWindowMediaTime: number | null = null;
  let lastPreparedWindowFrames: readonly DetectionFrame[] = [];
  let lastPreparedTargetFrames: readonly DetectionFrame[] = [];
  let activeMaskFrame: {
    readonly key: string;
    readonly mediaTime: number;
  } | null = null;
  let activeMaskFrameSignature: string | null = null;
  let isDestroyed = false;
  let generation = 0;
  const preparedMaskFrames = new Map<string, PreparedMaskFrame>();
  const pendingMaskFrames = new Map<string, PendingMaskFrame>();
  const queuedMaskFrameKeys: string[] = [];
  const inFlightMaskFrameKeys = new Set<string>();
  const emptyMaskFrameKeys = new Set<string>();
  let scheduledQueuePump: ScheduledPreparationTask | undefined;

  const scheduleMaskFrame = (
    frame: DetectionFrame,
    mediaTime: number,
    scheduleOptions: { readonly force?: boolean } = {},
  ) => {
    const key = getFrameKey(frame);

    if (
      !maskStyle ||
      preparedMaskFrames.has(key) ||
      emptyMaskFrameKeys.has(key) ||
      isDestroyed
    ) {
      return false;
    }

    if (pendingMaskFrames.has(key)) {
      if (scheduleOptions.force) {
        pruneStaleQueuedMaskFrames(mediaTime, key);
        promotePendingMaskFrame(key, mediaTime);
      }

      return false;
    }

    if (scheduleOptions.force) {
      pruneStaleQueuedMaskFrames(mediaTime);

      if (pendingMaskFrames.size >= maxPendingFrameCount) {
        evictFarthestQueuedMaskFrame(mediaTime);
      }
    }

    if (
      !scheduleOptions.force &&
      pendingMaskFrames.size >= maxPendingFrameCount
    ) {
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

    if (scheduleOptions.force) {
      queuedMaskFrameKeys.unshift(key);
    } else {
      queuedMaskFrameKeys.push(key);
    }

    emitDiagnostics();
    pumpMaskFrameQueue();

    return true;
  };

  function pumpMaskFrameQueue() {
    if (scheduledQueuePump || isDestroyed) {
      return;
    }

    scheduledQueuePump = schedulePreparationTask(() => {
      scheduledQueuePump = undefined;
      startQueuedMaskFrameJobs();
    });
  }

  function startQueuedMaskFrameJobs() {
    if (isDestroyed) {
      return;
    }

    while (
      queuedMaskFrameKeys.length > 0 &&
      inFlightMaskFrameKeys.size < getMaxInFlightMaskFrameCount()
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

      inFlightMaskFrameKeys.add(key);

      if (isDestroyed || job.generation !== generation) {
        pendingMaskFrames.delete(key);
        inFlightMaskFrameKeys.delete(key);
        emitDiagnostics();
        return;
      }

      const instructions = resolveMaskInstructions({
        frame: job.frame,
        maskStyle: job.maskStyle,
        mediaTime: job.mediaTime,
      });

      if (instructions.length === 0) {
        emptyMaskFrameKeys.add(key);
        pendingMaskFrames.delete(key);
        inFlightMaskFrameKeys.delete(key);
        schedulePreparedTargetBatch();
        emitDiagnostics();
        continue;
      }

      void maskFramePreparer
        .prepare({ instructions, key })
        .then((maskFrame) => {
          inFlightMaskFrameKeys.delete(key);
          const pendingJob = pendingMaskFrames.get(key);

          pendingMaskFrames.delete(key);

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
            schedulePreparedTargetBatch();
            emitDiagnostics();
            pumpMaskFrameQueue();
            return;
          }

          preparedMaskFrames.set(key, maskFrame);
          evictPreparedMaskFrames();
          options.onMaskFramePrepared?.(maskFrame);
          schedulePreparedTargetBatch();
          emitDiagnostics();
          pumpMaskFrameQueue();
        })
        .catch((error: unknown) => {
          inFlightMaskFrameKeys.delete(key);
          pendingMaskFrames.delete(key);
          schedulePreparedTargetBatch();
          emitDiagnostics(
            error instanceof Error
              ? error.message
              : "Unable to prepare mask frame.",
          );
          pumpMaskFrameQueue();
        });

      continue;
    }
  }

  function promotePendingMaskFrame(key: string, mediaTime: number) {
    const job = pendingMaskFrames.get(key);

    if (!job || inFlightMaskFrameKeys.has(key)) {
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

  function removeQueuedMaskFrameKey(key: string) {
    const index = queuedMaskFrameKeys.indexOf(key);

    if (index >= 0) {
      queuedMaskFrameKeys.splice(index, 1);
    }
  }

  const schedulePreparedWindow = (
    detectionFrame: DetectionFrame | undefined,
    mediaTime: number,
  ) => {
    const bufferState = options.detectionTimeline.getState();
    const bufferSignature = [
      bufferState.bufferStartTime,
      bufferState.bufferEndTime,
      bufferState.frameCount,
      bufferState.detectionCount,
    ].join(":");
    const frameKey = detectionFrame ? getFrameKey(detectionFrame) : null;
    const shouldScanWindow =
      bufferSignature !== lastPreparedBufferSignature ||
      lastPreparedWindowMediaTime === null ||
      mediaTime < lastPreparedWindowMediaTime ||
      mediaTime - lastPreparedWindowMediaTime >=
        preparedWindowScanIntervalSeconds;

    if (!shouldScanWindow) {
      return;
    }

    lastPreparedBufferSignature = bufferSignature;
    lastPreparedWindowMediaTime = mediaTime;

    const bufferedFrames = options.detectionTimeline.getBufferedFrames();
    lastPreparedWindowFrames = bufferedFrames;
    lastPreparedTargetFrames = bufferedFrames
      .filter((frame) => frame.mediaTime >= mediaTime)
      .slice(0, prefetchFrameCount);

    if (
      detectionFrame &&
      !lastPreparedTargetFrames.some((frame) => getFrameKey(frame) === frameKey)
    ) {
      lastPreparedTargetFrames = [detectionFrame, ...lastPreparedTargetFrames];
    }

    schedulePreparedTargetBatch();
  };

  function schedulePreparedTargetBatch() {
    if (isDestroyed) {
      return;
    }

    let scheduledFrameCount = 0;

    for (const frame of lastPreparedTargetFrames) {
      if (scheduledFrameCount >= scheduleBatchSize) {
        break;
      }

      const scheduled = scheduleMaskFrame(frame, frame.mediaTime, {
        force: false,
      });

      if (scheduled) {
        scheduledFrameCount += 1;
      }
    }
  }

  return {
    getFrame(mediaTime) {
      if (isDestroyed) {
        return undefined;
      }

      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

      if (!detectionFrame) {
        setActiveMaskFrame(null);
        schedulePreparedWindow(undefined, mediaTime);
        return undefined;
      }

      const key = getFrameKey(detectionFrame);

      setActiveMaskFrame({
        key,
        mediaTime: detectionFrame.mediaTime,
      });
      scheduleMaskFrame(detectionFrame, mediaTime, { force: true });
      schedulePreparedWindow(detectionFrame, mediaTime);

      return {
        detectionFrame,
        key,
        maskFrame: preparedMaskFrames.get(key),
        maskStatus: getMaskStatus(key),
      };
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

      clearPreparedMaskFrames({ resetPreparer: true });
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      clearPreparedMaskFrames();
      maskFramePreparer.destroy();
    },
  };

  function emitDiagnostics(message?: string) {
    const status = maskFramePreparer.getStatus();
    const preparedAhead = getPreparedAheadDiagnostics();
    const maxInFlightCount = getMaxInFlightMaskFrameCount();

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
          inFlightCount: inFlightMaskFrameKeys.size,
          kind: RenderPreparationArtifactKind.MaskFrame,
          maxInFlightCount,
          maxPendingCount: maxPendingFrameCount,
          maxPreparedCount: maxMaskFrameCacheSize,
          pendingCount: pendingMaskFrames.size,
          preparedAheadFrameCount: preparedAhead.frameCount,
          preparedAheadSeconds: preparedAhead.seconds,
          prefetchCount: prefetchFrameCount,
          preparedCount: preparedMaskFrames.size,
          scheduleBatchSize,
        },
      ],
      executionMode: status.executionMode,
      message: message ?? status.message,
      workerStatus: status.workerStatus,
    });
  }

  function evictPreparedMaskFrames() {
    while (preparedMaskFrames.size > maxMaskFrameCacheSize) {
      const oldestKey = preparedMaskFrames.keys().next().value;

      if (oldestKey === undefined) {
        return;
      }

      const maskFrame = preparedMaskFrames.get(oldestKey);

      preparedMaskFrames.delete(oldestKey);
      options.onMaskFrameEvicted?.(oldestKey);
      maskFrame?.close();
    }
  }

  function clearPreparedMaskFrames(
    clearOptions: { readonly resetPreparer?: boolean } = {},
  ) {
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
    inFlightMaskFrameKeys.clear();
    emptyMaskFrameKeys.clear();

    if (preparedMaskFrames.size > 0) {
      const maskFrames = Array.from(preparedMaskFrames.values());

      preparedMaskFrames.clear();
      options.onMaskFramesCleared?.();

      for (const maskFrame of maskFrames) {
        maskFrame.close();
      }
    }

    if (clearOptions.resetPreparer && !isDestroyed) {
      maskFramePreparer.destroy();
      maskFramePreparer = createPreparer();
    }

    emitDiagnostics();
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

    const activeFrameIndex = lastPreparedWindowFrames.findIndex(
      (frame) => getFrameKey(frame) === activeMaskFrame?.key,
    );

    if (activeFrameIndex < 0) {
      return { frameCount: 0, seconds: 0 };
    }

    let frameCount = 0;
    let latestPreparedTime = activeMaskFrame.mediaTime;

    for (const frame of lastPreparedWindowFrames.slice(activeFrameIndex)) {
      const key = getFrameKey(frame);

      if (!preparedMaskFrames.has(key) && !emptyMaskFrameKeys.has(key)) {
        break;
      }

      frameCount += 1;
      latestPreparedTime = frame.mediaTime;
    }

    return {
      frameCount,
      seconds: Math.max(0, latestPreparedTime - activeMaskFrame.mediaTime),
    };
  }

  function createPreparer() {
    return createMaskFramePreparer({
      onStatusChange: emitDiagnostics,
      renderPreparation: options.renderPreparation,
    });
  }

  function getMaxInFlightMaskFrameCount() {
    const status = maskFramePreparer.getStatus();

    if (status.executionMode === RenderPreparationExecutionMode.Worker) {
      return workerCount;
    }

    return 1;
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

  for (const [
    detectionIndex,
    detection,
  ] of options.frame.detections.entries()) {
    const instruction = options.maskStyle.resolve(detection, {
      detectionIndex,
      frame: options.frame,
      mediaTime: options.mediaTime,
    });

    if (instruction) {
      instructions.push(instruction);
    }
  }

  return instructions;
}

function getFrameKey(frame: DetectionFrame) {
  return `${frame.frameIndex ?? "time"}:${frame.mediaTime}`;
}

function schedulePreparationTask(
  callback: () => void,
): ScheduledPreparationTask {
  return setTimeout(callback, 0);
}

function cancelScheduledPreparationTask(task: ScheduledPreparationTask) {
  clearTimeout(task);
}
