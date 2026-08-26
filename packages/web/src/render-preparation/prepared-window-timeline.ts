import type { DetectionFrame } from "supervision-js-core";

export interface PreparedRenderTimelineContext {
  readonly duration: number | null;
  readonly loop: boolean;
}

export interface PreparedWindowTimeline {
  clear(): void;
  getFrameDistance(frameTime: number, mediaTime: number): number;
  getWindowFrameKeys(mediaTime: number, count: number): readonly string[];
  getWindowFrames(
    bufferedFrames: readonly DetectionFrame[],
    mediaTime: number,
  ): readonly DetectionFrame[];
  rememberFrames(
    frames: readonly DetectionFrame[],
    retainedKeys: ReadonlySet<string>,
  ): void;
  setContext(context: PreparedRenderTimelineContext): void;
}

export function createPreparedWindowTimeline(options: {
  readonly getFrameKey: (frame: DetectionFrame) => string;
}): PreparedWindowTimeline {
  const knownFrames = new Map<string, DetectionFrame>();
  let timelineContext: PreparedRenderTimelineContext = {
    duration: null,
    loop: false,
  };

  return {
    clear() {
      knownFrames.clear();
    },

    getFrameDistance(frameTime, mediaTime) {
      if (isLoopingTimeline()) {
        return getLoopDistance(frameTime, mediaTime);
      }

      return Math.max(0, frameTime - mediaTime);
    },

    getWindowFrameKeys(mediaTime, count) {
      const windowCount = Math.max(0, count);

      return orderWindowFrames(Array.from(knownFrames.values()), mediaTime)
        .slice(0, windowCount)
        .map(options.getFrameKey);
    },

    getWindowFrames(bufferedFrames, mediaTime) {
      return orderWindowFrames(bufferedFrames, mediaTime);
    },

    rememberFrames(frames, retainedKeys) {
      for (const frame of frames) {
        knownFrames.set(options.getFrameKey(frame), frame);
      }

      for (const key of knownFrames.keys()) {
        if (!retainedKeys.has(key)) {
          knownFrames.delete(key);
        }
      }
    },

    setContext(context) {
      timelineContext = context;
    },
  };

  function orderWindowFrames(
    frames: readonly DetectionFrame[],
    mediaTime: number,
  ) {
    if (!isLoopingTimeline()) {
      return frames
        .filter((frame) => frame.mediaTime >= mediaTime)
        .sort(
          (leftFrame, rightFrame) => leftFrame.mediaTime - rightFrame.mediaTime,
        );
    }

    return Array.from(frames).sort(
      (leftFrame, rightFrame) =>
        getLoopDistance(leftFrame.mediaTime, mediaTime) -
        getLoopDistance(rightFrame.mediaTime, mediaTime),
    );
  }

  function isLoopingTimeline() {
    return (
      timelineContext.loop &&
      timelineContext.duration !== null &&
      timelineContext.duration > 0
    );
  }

  function getLoopDistance(frameTime: number, mediaTime: number) {
    if (!isLoopingTimeline() || timelineContext.duration === null) {
      return Math.max(0, frameTime - mediaTime);
    }

    const duration = timelineContext.duration;
    const normalizedFrameTime = modulo(frameTime, duration);
    const normalizedMediaTime = modulo(mediaTime, duration);
    const rawDistance = normalizedFrameTime - normalizedMediaTime;

    return rawDistance >= 0 ? rawDistance : rawDistance + duration;
  }
}

function modulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}
