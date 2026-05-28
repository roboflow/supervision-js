import type { MaskDrawInstruction, MaskStyle } from "#types/mask-style";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import { decodeCompressedRleMask } from "#utils/detection-frames";
import type {
  CanvasSource as PixiCanvasSource,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";

const MASK_TEXTURE_CACHE_SIZE = 10;
const MASK_PREFETCH_FRAME_COUNT = 4;
const MASK_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS = 0.5;

type CanvasSourceConstructor = new (options: {
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement;
  width: number;
}) => PixiCanvasSource;

type TextureConstructor = new (options: {
  dynamic: boolean;
  source: PixiCanvasSource;
}) => PixiTexture;

type SpriteConstructor = new (options?: {
  texture?: PixiTexture;
}) => PixiSprite;

interface CachedMaskTexture {
  readonly key: string;
  readonly texture: PixiTexture;
}

type BrowserIdleDeadline = {
  readonly didTimeout: boolean;
  timeRemaining(): number;
};

type BrowserIdleCallback = (deadline: BrowserIdleDeadline) => void;

type MaskTaskWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (callback: BrowserIdleCallback) => number;
};

type ScheduledMaskTask =
  | {
      readonly handle: number;
      readonly type: "idle";
    }
  | {
      readonly handle: ReturnType<typeof setTimeout>;
      readonly type: "timeout";
    };

export interface PixiMaskLayer {
  createSprite(dimensions: { width: number; height: number }): PixiSprite;
  drawFrame(mediaTime: number): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  destroy(): void;
}

export function createPixiMaskLayer(options: {
  readonly CanvasSource: CanvasSourceConstructor;
  readonly Sprite: SpriteConstructor;
  readonly Texture: TextureConstructor;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskStyle: MaskStyle;
}): PixiMaskLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let maskSprite: PixiSprite | undefined;
  let maskStyle: MaskStyle | null = options.maskStyle;
  let activeFrameKey: string | null = null;
  let lastPreparedBufferSignature: string | null = null;
  let lastPreparedWindowMediaTime: number | null = null;
  let isDestroyed = false;
  let generation = 0;
  const cache = new Map<string, CachedMaskTexture>();
  const scheduledFrameTasks = new Map<string, ScheduledMaskTask>();
  const emptyFrameKeys = new Set<string>();

  const scheduleFrame = (frame: DetectionFrame, mediaTime: number) => {
    const key = getFrameKey(frame);

    if (
      !maskStyle ||
      cache.has(key) ||
      scheduledFrameTasks.has(key) ||
      emptyFrameKeys.has(key) ||
      isDestroyed
    ) {
      return;
    }

    const scheduledGeneration = generation;

    const scheduledTask = scheduleMaskTask(() => {
      scheduledFrameTasks.delete(key);

      if (isDestroyed || scheduledGeneration !== generation) {
        return;
      }

      const cachedTexture = createCachedTexture(frame, key, mediaTime);

      if (!cachedTexture) {
        emptyFrameKeys.add(key);
        return;
      }

      cache.set(key, cachedTexture);
      evictCachedTextures();

      if (key === activeFrameKey) {
        showTexture(cachedTexture.texture);
      }
    });
    scheduledFrameTasks.set(key, scheduledTask);
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
        MASK_PREPARED_WINDOW_SCAN_INTERVAL_SECONDS;

    if (!shouldScanWindow) {
      return;
    }

    lastPreparedBufferSignature = bufferSignature;
    lastPreparedWindowMediaTime = mediaTime;

    const bufferedFrames = options.detectionTimeline.getBufferedFrames();
    const upcomingFrames = bufferedFrames
      .filter((frame) => frame.mediaTime >= mediaTime)
      .slice(0, MASK_PREFETCH_FRAME_COUNT);

    if (
      detectionFrame &&
      !upcomingFrames.some((frame) => getFrameKey(frame) === frameKey)
    ) {
      upcomingFrames.unshift(detectionFrame);
    }

    for (const frame of upcomingFrames) {
      scheduleFrame(
        frame,
        getFrameKey(frame) === frameKey ? mediaTime : frame.mediaTime,
      );
    }
  };

  return {
    createSprite({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      maskSprite = new options.Sprite();
      maskSprite.visible = false;
      maskSprite.width = mediaWidth;
      maskSprite.height = mediaHeight;
      return maskSprite;
    },

    drawFrame(mediaTime) {
      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

      if (!maskStyle || !detectionFrame || !maskSprite) {
        activeFrameKey = null;
        hideSprite();
        return;
      }

      const nextFrameKey = getFrameKey(detectionFrame);
      activeFrameKey = nextFrameKey;
      scheduleFrame(detectionFrame, mediaTime);

      const cachedTexture = cache.get(nextFrameKey);

      if (cachedTexture) {
        showTexture(cachedTexture.texture);
      } else {
        hideSprite();
      }

      schedulePreparedWindow(detectionFrame, mediaTime);
    },

    setMaskStyle(nextMaskStyle) {
      if (nextMaskStyle === undefined) {
        return;
      }

      maskStyle = nextMaskStyle;
      clearPreparedFrames();

      if (!maskStyle) {
        hideSprite();
      }
    },

    destroy() {
      isDestroyed = true;
      clearPreparedFrames();
    },
  };

  function createCachedTexture(
    frame: DetectionFrame,
    key: string,
    mediaTime: number,
  ): CachedMaskTexture | undefined {
    if (!maskStyle) {
      return undefined;
    }

    const instructions = resolveMaskInstructions({
      frame,
      maskStyle,
      mediaTime,
    });

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

    const canvasSource = new options.CanvasSource({
      dynamic: false,
      height,
      resource: canvas,
      width,
    });
    const texture = new options.Texture({
      dynamic: false,
      source: canvasSource,
    });

    return { key, texture };
  }

  function showTexture(texture: PixiTexture) {
    if (!maskSprite) {
      return;
    }

    maskSprite.texture = texture;
    maskSprite.width = mediaWidth;
    maskSprite.height = mediaHeight;
    maskSprite.visible = true;
  }

  function hideSprite() {
    if (maskSprite) {
      maskSprite.visible = false;
    }
  }

  function evictCachedTextures() {
    while (cache.size > MASK_TEXTURE_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value;

      if (oldestKey === undefined) {
        return;
      }

      const cachedTexture = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedTexture?.texture.destroy(true);
    }
  }

  function clearPreparedFrames() {
    generation += 1;
    activeFrameKey = null;
    lastPreparedBufferSignature = null;
    lastPreparedWindowMediaTime = null;

    for (const scheduledTask of scheduledFrameTasks.values()) {
      cancelScheduledMaskTask(scheduledTask);
    }

    scheduledFrameTasks.clear();
    emptyFrameKeys.clear();

    for (const cachedTexture of cache.values()) {
      cachedTexture.texture.destroy(true);
    }

    cache.clear();
  }
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

function scheduleMaskTask(callback: () => void): ScheduledMaskTask {
  const browserWindow = window as MaskTaskWindow;

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

function cancelScheduledMaskTask(task: ScheduledMaskTask) {
  if (task.type === "idle") {
    const browserWindow = window as MaskTaskWindow;
    browserWindow.cancelIdleCallback?.(task.handle);
    return;
  }

  clearTimeout(task.handle);
}
