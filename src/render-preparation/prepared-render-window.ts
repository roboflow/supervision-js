import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { MaskDrawInstruction, MaskStyle } from "#types/mask-style";
import { decodeCompressedRleMask } from "#utils/detection-frames";

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

export interface PreparedMaskFrame {
  readonly canvas: HTMLCanvasElement;
  readonly height: number;
  readonly key: string;
  readonly width: number;
}

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

export function createPreparedRenderWindow(options: {
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskStyle?: MaskStyle | null;
  readonly maxMaskFrameCacheSize?: number;
  readonly onMaskFrameEvicted?: (key: string) => void;
  readonly onMaskFramePrepared?: (maskFrame: PreparedMaskFrame) => void;
  readonly onMaskFramesCleared?: () => void;
  readonly prefetchFrameCount?: number;
  readonly preparedWindowScanIntervalSeconds?: number;
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

  let maskStyle = options.maskStyle ?? null;
  let lastPreparedBufferSignature: string | null = null;
  let lastPreparedWindowMediaTime: number | null = null;
  let isDestroyed = false;
  let generation = 0;
  const preparedMaskFrames = new Map<string, PreparedMaskFrame>();
  const scheduledMaskFrameTasks = new Map<string, ScheduledPreparationTask>();
  const emptyMaskFrameKeys = new Set<string>();

  const scheduleMaskFrame = (frame: DetectionFrame, mediaTime: number) => {
    const key = getFrameKey(frame);

    if (
      !maskStyle ||
      preparedMaskFrames.has(key) ||
      scheduledMaskFrameTasks.has(key) ||
      emptyMaskFrameKeys.has(key) ||
      isDestroyed
    ) {
      return;
    }

    const scheduledMaskStyle = maskStyle;
    const scheduledGeneration = generation;
    const scheduledTask = schedulePreparationTask(() => {
      scheduledMaskFrameTasks.delete(key);

      if (isDestroyed || scheduledGeneration !== generation) {
        return;
      }

      const maskFrame = createPreparedMaskFrame({
        frame,
        key,
        maskStyle: scheduledMaskStyle,
        mediaTime,
      });

      if (!maskFrame) {
        emptyMaskFrameKeys.add(key);
        return;
      }

      preparedMaskFrames.set(key, maskFrame);
      evictPreparedMaskFrames();
      options.onMaskFramePrepared?.(maskFrame);
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
    },
  };

  function evictPreparedMaskFrames() {
    while (preparedMaskFrames.size > maxMaskFrameCacheSize) {
      const oldestKey = preparedMaskFrames.keys().next().value;

      if (oldestKey === undefined) {
        return;
      }

      preparedMaskFrames.delete(oldestKey);
      options.onMaskFrameEvicted?.(oldestKey);
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
    emptyMaskFrameKeys.clear();

    if (preparedMaskFrames.size > 0) {
      preparedMaskFrames.clear();
      options.onMaskFramesCleared?.();
    }
  }
}

function createPreparedMaskFrame(options: {
  readonly frame: DetectionFrame;
  readonly key: string;
  readonly maskStyle: MaskStyle;
  readonly mediaTime: number;
}): PreparedMaskFrame | undefined {
  const instructions = resolveMaskInstructions(options);

  if (instructions.length === 0) {
    return undefined;
  }

  const width = Math.max(...instructions.map(({ mask }) => mask.width));
  const height = Math.max(...instructions.map(({ mask }) => mask.height));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return undefined;
  }

  canvas.width = width;
  canvas.height = height;

  const imageData = new ImageData(
    new Uint8ClampedArray(width * height * 4),
    width,
    height,
  );

  for (const instruction of instructions) {
    compositeInstruction(imageData.data, width, instruction);
  }

  context.putImageData(imageData, 0, 0);

  return {
    canvas,
    height,
    key: options.key,
    width,
  };
}

function resolveMaskInstructions(options: {
  readonly frame: DetectionFrame;
  readonly maskStyle: MaskStyle;
  readonly mediaTime: number;
}) {
  const instructions: MaskDrawInstruction[] = [];

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

function compositeInstruction(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  instruction: MaskDrawInstruction,
) {
  const decodedMask = decodeCompressedRleMask(instruction.mask);
  const red = (instruction.color >> 16) & 0xff;
  const green = (instruction.color >> 8) & 0xff;
  const blue = instruction.color & 0xff;
  const alpha = Math.round(Math.max(0, Math.min(instruction.alpha, 1)) * 255);

  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      const maskOffset = y * decodedMask.width + x;

      if (!decodedMask.data[maskOffset]) {
        continue;
      }

      const rgbaOffset = (y * canvasWidth + x) * 4;
      rgba[rgbaOffset] = red;
      rgba[rgbaOffset + 1] = green;
      rgba[rgbaOffset + 2] = blue;
      rgba[rgbaOffset + 3] = alpha;
    }
  }
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
