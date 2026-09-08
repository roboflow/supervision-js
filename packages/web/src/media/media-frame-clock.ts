import type { FrameTimeline } from "#web-video-engine";
import type { MediaFrameClock } from "#types/media-frame-clock";

export function createMediaFrameClock(
  timeline: FrameTimeline,
): MediaFrameClock {
  const { frameCount, tickRate } = timeline;
  const firstTimestamp = timeline.timeAt(0);
  const endTimestamp = timeline.endTicksAt(frameCount - 1) / tickRate;
  const validateIndex = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= frameCount) {
      throw new RangeError(
        `Frame index must be between 0 and ${frameCount - 1}.`,
      );
    }
  };

  return Object.freeze({
    frameCount,
    firstTimestamp,
    endTimestamp,
    duration: endTimestamp - firstTimestamp,
    timeAt(index: number) {
      validateIndex(index);
      return timeline.timeAt(index);
    },
    durationAt(index: number) {
      validateIndex(index);
      return (timeline.endTicksAt(index) - timeline.ticksAt(index)) / tickRate;
    },
    indexAtOrBefore(mediaTime: number) {
      if (!Number.isFinite(mediaTime)) {
        throw new RangeError("Media time must be finite.");
      }
      return timeline.indexAtOrBefore(mediaTime);
    },
  });
}
