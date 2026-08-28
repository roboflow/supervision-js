/**
 * Where the timeline is allowed to stop: the container's own frame table, and
 * nothing else.
 *
 * No function here may take a frame rate, and none is in scope. A rate read
 * off a packet prefix put the index 2856 frames out across one screen
 * recording that declares 600 fps and delivers 56.4, so a boundary computed
 * from one names a frame the click does not land on.
 */
import {
  FrameTimeline,
  type FrameTimelineData,
} from "supervision-js-web-video-engine";

/** A frame, by the two names a readout needs. */
export interface TimelineFrame {
  readonly index: number;
  readonly timeS: number;
}

export function readTimelineFrames(
  data: FrameTimelineData | null | undefined,
): FrameTimeline | null {
  return data === undefined || data === null || data.ticks.length === 0
    ? null
    : FrameTimeline.from(data);
}

/** The frame covering an offset along the track, which is the frame the engine
 *  decodes when that offset is clicked. */
export function resolveTimelineFrame(
  frames: FrameTimeline | null,
  offsetPx: number,
  trackPx: number,
  duration: number,
): TimelineFrame | null {
  if (frames === null || !(trackPx > 0) || !(duration > 0)) {
    return null;
  }

  return frameAt(frames, clampFraction(offsetPx / trackPx) * duration);
}

/**
 * The seconds a scrub publishes for a pointer offset.
 *
 * Two offsets inside one frame answer with the identical number, which is what
 * lets a drag drop the moves that changed no frame. With no table the pointer's
 * own position is published, and every move is a new one.
 */
export function resolveScrubTime(
  frames: FrameTimeline | null,
  offsetPx: number,
  trackPx: number,
  duration: number,
): number {
  return (
    resolveTimelineFrame(frames, offsetPx, trackPx, duration)?.timeS ??
    clampFraction(offsetPx / trackPx) * duration
  );
}

/** The same answer for a control that speaks seconds, so a keyboard step lands
 *  where a click on the same spot lands. */
export function quantizeScrubTime(
  frames: FrameTimeline | null,
  timeS: number,
): number {
  return frames === null ? timeS : frameAt(frames, timeS).timeS;
}

/**
 * The index leads, and carries no trailing `f`: the demo spends that on frame
 * counts, and an index is not a count. Three decimals because frames are 33 ms
 * apart on the default fixture and two decimals cannot separate two of them.
 */
export function formatTimelineFrame(frame: TimelineFrame) {
  return `f${frame.index} · ${frame.timeS.toFixed(3)}s`;
}

function frameAt(frames: FrameTimeline, timeS: number): TimelineFrame {
  const index = frames.indexAtOrBefore(timeS);

  return { index, timeS: frames.timeAt(index) };
}

function clampFraction(fraction: number) {
  return Math.min(Math.max(fraction, 0), 1);
}
