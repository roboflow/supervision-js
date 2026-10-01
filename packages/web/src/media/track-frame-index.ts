import { readFrameIndex } from "#web-video-engine/frame-index";

/** A track's presented frames, as a decoder beside the engine reads them. */
export interface TrackFrameIndex {
  /** Seconds from the first presented frame. */
  readonly times: Float64Array;
  /** Container presentation times in seconds, which packets are found by. */
  readonly sourceTimes: Float64Array;
  /** Presentation indices of key frames, ascending. */
  readonly keyIndices: Int32Array;
}

/**
 * The frames of a track Mediabunny opened, read by the walk the web video
 * engine reads its own frames by, so a track decoded beside the media and
 * the media itself agree on every frame.
 */
export async function readTrackFrameIndex(
  track: unknown,
): Promise<TrackFrameIndex> {
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
