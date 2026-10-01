import { createMediaFrameClock } from "#media/media-frame-clock";
import type { MediaFrameClock } from "#types/media-frame-clock";

/**
 * The frame index of a track Mediabunny opened, read from its packet table
 * by the walk the web video engine reads its own frames by, so a depth clip
 * pairs frames on this path exactly as it does on the engine's. Pre-roll
 * that ends at or before zero is dropped and the frame straddling zero starts
 * at zero, which is where the pull path presents it.
 */
export async function readMediabunnyFrameClock(
  track: unknown,
): Promise<MediaFrameClock> {
  const { readFrameTimeline } = await import("#web-video-engine/frame-index");

  return createMediaFrameClock(await readFrameTimeline(track));
}

/** A track's presented frames, as a decoder beside the engine reads them. */
export interface TrackFrameIndex {
  /** Seconds from the first presented frame. */
  readonly times: Float64Array;
  /** Container presentation times in seconds, which packets are found by. */
  readonly sourceTimes: Float64Array;
  /** Presentation indices of key frames, ascending. */
  readonly keyIndices: Int32Array;
}

/** The same walk, for a track decoded beside the media rather than as it. */
export async function readMediabunnyFrameIndex(
  track: unknown,
): Promise<TrackFrameIndex> {
  const { readFrameIndex } = await import("#web-video-engine/frame-index");
  const { timeline, keyIndices } = await readFrameIndex(track);
  const first = timeline.timeAt(0);

  return {
    keyIndices,
    sourceTimes: Float64Array.from(
      { length: timeline.frameCount },
      (_, index) => timeline.sourceTimeAt(index),
    ),
    times: Float64Array.from(
      { length: timeline.frameCount },
      (_, index) => timeline.timeAt(index) - first,
    ),
  };
}
