import {
  PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
  type DepthClipFrames,
} from "supervision-js-core";
import type { MediaFrameClock } from "#types/media-frame-clock";

/** Where each depth frame of a clip sits on the media timeline. */
export interface DepthClipTiming {
  readonly frameCount: number;
  /** Depth frames per second, over the whole clip. */
  readonly frameRate: number;
  /** The depth frame drawn over `mediaTime`, or null before the first. */
  indexAt(mediaTime: number): number | null;
  timeAt(index: number): number;
  endAt(index: number): number;
}

/**
 * Pairs depth frames with the media's frames: one for one by index, or by
 * `frames.times_s` when depth covers only some of them.
 */
export function createDepthClipTiming(
  clock: MediaFrameClock,
  frames: DepthClipFrames,
): DepthClipTiming {
  const { timesS, count } = frames;

  if (!timesS && count !== clock.frameCount) {
    throw new RangeError(
      `depth.json has ${count} frames and the media has ${clock.frameCount}; give frames.times_s when depth covers only some of the video's frames.`,
    );
  }

  const timeAt = (index: number) =>
    timesS ? clock.firstTimestamp + timesS[index] : clock.timeAt(index);
  const endAt = (index: number) =>
    timesS
      ? index + 1 < timesS.length
        ? timeAt(index + 1)
        : clock.endTimestamp
      : clock.timeAt(index) + clock.durationAt(index);

  return {
    endAt,
    frameCount: count,
    frameRate: count / Math.max(1e-6, endAt(count - 1) - timeAt(0)),
    indexAt(mediaTime) {
      if (!Number.isFinite(mediaTime)) return null;
      if (!timesS) {
        return clock.indexAtOrBefore(
          mediaTime + PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
        );
      }

      return lastAtOrBefore(
        timesS,
        mediaTime -
          clock.firstTimestamp +
          PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
      );
    },
    timeAt,
  };
}

function lastAtOrBefore(times: readonly number[], time: number): number | null {
  let low = 0;
  let high = times.length - 1;
  let found: number | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (times[middle] <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}
