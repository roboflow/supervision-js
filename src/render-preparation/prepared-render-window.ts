import {
  createMaskFramePreparer,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-preparer";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { MaskStyle } from "#types/mask-style";
import {
  RenderPreparationArtifactKind,
  type RenderPreparationOptions,
} from "#types/render-preparation";

const DEFAULT_MASK_FRAME_CACHE_SIZE = 10;
const DEFAULT_MASK_PREFETCH_FRAME_COUNT = 4;
const DEFAULT_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS = 0.5;

type BrowserIdleDeadline = {
  readonly didTimeout: boolean;
  timeRemaining(): number;
};

type BrowserIdleCallback = (deadline: BrowserIdleDeadline) => void;

type RenderPreparationWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (callback: BrowserIdleCallback) => number;
};

type ScheduledPreparationTask =
  | {
      readonly handle: number;
      readonly type: "idle";
    }
  | {
      readonly handle: ReturnType<typeof setTimeout>;
      readonly type: "timeout";
    };

export interface PreparedRenderFrame {
  readonly detectionFrame: DetectionFrame;
  readonly key: string;
  readonly maskFrame?: PreparedMaskFrame;
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
  const maxMaskFrameCacheSize = Math.max(
    1,
    options.maxMaskFrameCacheSize ?? DEFAULT_MASK_FRAME_CACHE_SIZE,
  );
  const prefetchFrameCount = Math.max(
    0,
    options.prefetchFrameCount ?? DEFAULT_MASK_PREFETCH_FRAME_COUNT,
  );
  const preparedWindowScanIntervalSeconds =
    options.preparedWindowScanIntervalSeconds ??
    DEFAULT_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS;
  const maskFramePreparer = createMaskFramePreparer({
    onStatusChange: emitDiagnostics,
    renderPreparation: options.renderPreparation,
  });

  let maskStyle = options.maskStyle ?? null;
  let lastPreparedBufferSignature: string | null = null;
  let lastPreparedWindowMediaTime: number | null = null;
  let isDestroyed = false;
  let generation = 0;
  const preparedMaskFrames = new Map<string, PreparedMaskFrame>();
  const scheduledMaskFrameTasks = new Map<string, ScheduledPreparationTask>();
  const pendingMaskFrameKeys = new Set<string>();
  const emptyMaskFrameKeys = new Set<string>();

  const scheduleMaskFrame = (frame: DetectionFrame, mediaTime: number) => {
    const key = getFrameKey(frame);

    if (
      !maskStyle ||
      preparedMaskFrames.has(key) ||
      pendingMaskFrameKeys.has(key) ||
      emptyMaskFrameKeys.has(key) ||
      isDestroyed
    ) {
      return;
    }

    const scheduledMaskStyle = maskStyle;
    const scheduledGeneration = generation;
    pendingMaskFrameKeys.add(key);
    emitDiagnostics();

    const scheduledTask = schedulePreparationTask(() => {
      scheduledMaskFrameTasks.delete(key);

      if (isDestroyed || scheduledGeneration !== generation) {
        pendingMaskFrameKeys.delete(key);
        emitDiagnostics();
        return;
      }

      const instructions = resolveMaskInstructions({
        frame,
        maskStyle: scheduledMaskStyle,
        mediaTime,
      });

      if (instructions.length === 0) {
        emptyMaskFrameKeys.add(key);
        pendingMaskFrameKeys.delete(key);
        emitDiagnostics();
        return;
      }

      void maskFramePreparer
        .prepare({ instructions, key })
        .then((maskFrame) => {
          pendingMaskFrameKeys.delete(key);

          if (isDestroyed || scheduledGeneration !== generation) {
            maskFrame?.close();
            emitDiagnostics();
            return;
          }

          if (!maskFrame) {
            emptyMaskFrameKeys.add(key);
            emitDiagnostics();
            return;
          }

          preparedMaskFrames.set(key, maskFrame);
          evictPreparedMaskFrames();
          options.onMaskFramePrepared?.(maskFrame);
          emitDiagnostics();
        })
        .catch((error: unknown) => {
          pendingMaskFrameKeys.delete(key);
          emitDiagnostics(
            error instanceof Error
              ? error.message
              : "Unable to prepare mask frame.",
          );
        });
    });

    scheduledMaskFrameTasks.set(key, scheduledTask);
  };

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
    const upcomingFrames = bufferedFrames
      .filter((frame) => frame.mediaTime >= mediaTime)
      .slice(0, prefetchFrameCount);

    if (
      detectionFrame &&
      !upcomingFrames.some((frame) => getFrameKey(frame) === frameKey)
    ) {
      upcomingFrames.unshift(detectionFrame);
    }

    for (const frame of upcomingFrames) {
      scheduleMaskFrame(
        frame,
        getFrameKey(frame) === frameKey ? mediaTime : frame.mediaTime,
      );
    }
  };

  return {
    getFrame(mediaTime) {
      if (isDestroyed) {
        return undefined;
      }

      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

      if (!detectionFrame) {
        schedulePreparedWindow(undefined, mediaTime);
        return undefined;
      }

      const key = getFrameKey(detectionFrame);

      scheduleMaskFrame(detectionFrame, mediaTime);
      schedulePreparedWindow(detectionFrame, mediaTime);

      return {
        detectionFrame,
        key,
        maskFrame: preparedMaskFrames.get(key),
      };
    },

    setMaskStyle(nextMaskStyle) {
      if (nextMaskStyle === undefined) {
        return;
      }

      maskStyle = nextMaskStyle;
      clearPreparedMaskFrames();
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

    options.renderPreparation?.onDiagnostics?.({
      artifacts: [
        {
          kind: RenderPreparationArtifactKind.MaskFrame,
          pendingCount: pendingMaskFrameKeys.size,
          preparedCount: preparedMaskFrames.size,
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

  function clearPreparedMaskFrames() {
    generation += 1;
    lastPreparedBufferSignature = null;
    lastPreparedWindowMediaTime = null;

    for (const scheduledTask of scheduledMaskFrameTasks.values()) {
      cancelScheduledPreparationTask(scheduledTask);
    }

    scheduledMaskFrameTasks.clear();
    pendingMaskFrameKeys.clear();
    emptyMaskFrameKeys.clear();

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
  const browserWindow = window as RenderPreparationWindow;

  if (browserWindow.requestIdleCallback) {
    return {
      handle: browserWindow.requestIdleCallback(callback),
      type: "idle",
    };
  }

  return {
    handle: setTimeout(callback, 0),
    type: "timeout",
  };
}

function cancelScheduledPreparationTask(task: ScheduledPreparationTask) {
  if (task.type === "idle") {
    const browserWindow = window as RenderPreparationWindow;
    browserWindow.cancelIdleCallback?.(task.handle);
    return;
  }

  clearTimeout(task.handle);
}
