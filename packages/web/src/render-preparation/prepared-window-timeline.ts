import type { DetectionFrame } from "supervision-js-core";

export interface PreparedRenderTimelineContext {
  readonly duration: number | null;
  readonly firstTimestamp?: number;
  readonly loop: boolean;
}

export interface PreparedWindowTimeline {
  getFrameDistance(frameTime: number, mediaTime: number): number;
  getWindowFrames(
    bufferedFrames: readonly DetectionFrame[],
    mediaTime: number,
    bufferEndTime: number | null,
  ): readonly DetectionFrame[];
  setContext(context: PreparedRenderTimelineContext): void;
}

export function createPreparedWindowTimeline(): PreparedWindowTimeline {
  let timelineContext: PreparedRenderTimelineContext = {
    duration: null,
    loop: false,
  };

  return {
    getFrameDistance(frameTime, mediaTime) {
      if (isLoopingTimeline()) {
        return getLoopDistance(frameTime, mediaTime);
      }

      return Math.max(0, frameTime - mediaTime);
    },

    getWindowFrames(bufferedFrames, mediaTime, bufferEndTime) {
      if (!isLoopingTimeline()) {
        return bufferedFrames.filter((frame) => frame.mediaTime >= mediaTime);
      }

      return bufferedFrames
        .filter((frame) =>
          isAheadWithinBuffer(frame.mediaTime, mediaTime, bufferEndTime),
        )
        .sort(
          (leftFrame, rightFrame) =>
            getLoopDistance(leftFrame.mediaTime, mediaTime) -
            getLoopDistance(rightFrame.mediaTime, mediaTime),
        );
    },

    setContext(context) {
      timelineContext = context;
    },
  };

  function isLoopingTimeline() {
    const firstTimestamp = timelineContext.firstTimestamp ?? 0;

    return (
      timelineContext.loop &&
      timelineContext.duration !== null &&
      timelineContext.duration > firstTimestamp
    );
  }

  /**
   * Travel forward from `mediaTime` to `frameTime`, wrapping at the media end,
   * so a frame the playhead has already passed reads as almost a whole lap away.
   */
  function getLoopDistance(frameTime: number, mediaTime: number) {
    if (!isLoopingTimeline() || timelineContext.duration === null) {
      return Math.max(0, frameTime - mediaTime);
    }

    const firstTimestamp = timelineContext.firstTimestamp ?? 0;
    const loopSpan = timelineContext.duration - firstTimestamp;
    const normalizedFrameTime =
      firstTimestamp + modulo(frameTime - firstTimestamp, loopSpan);
    const normalizedMediaTime =
      firstTimestamp + modulo(mediaTime - firstTimestamp, loopSpan);
    const rawDistance = normalizedFrameTime - normalizedMediaTime;

    return rawDistance >= 0 ? rawDistance : rawDistance + loopSpan;
  }

  /**
   * The buffer's end time is the far edge of what the playhead reaches next, and
   * it runs past the media end when the loop point is close. A frame beyond it
   * is one the playhead already passed, not one a lap of travel away.
   */
  function isAheadWithinBuffer(
    frameTime: number,
    mediaTime: number,
    bufferEndTime: number | null,
  ) {
    if (bufferEndTime === null) {
      return true;
    }

    return mediaTime + getLoopDistance(frameTime, mediaTime) <= bufferEndTime;
  }
}

function modulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}
