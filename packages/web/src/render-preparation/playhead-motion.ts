/**
 * How the playhead is moving, read from where it lands: playing forward at a
 * cadence, dragged, or stepped, and which way. Every prepared window that
 * works ahead of the playhead reads it here, so a drag or a fast rate reads
 * the same to each.
 */

/** A jump that repeats. One on its own is a seek, and it lands somewhere. */
const DRAGGED_PLAYHEAD_JUMP_COUNT = 2;
/** The widest stride a present is taken to move: 8x of a 30 fps clip on 60 Hz. */
export const MAX_PRESENTED_FRAME_STRIDE = 4;
const PRESENTED_FRAME_STRIDE_SAMPLE_COUNT = 4;
/**
 * Positions a heading is read from, and how many it needs. These match the
 * web video engine's scrub ring, so a window here and the engine's residency
 * agree on which way a drag goes.
 */
const HEADING_SAMPLE_CAPACITY = 8;
const MIN_SAMPLES_FOR_HEADING = 3;
/**
 * Share of a window spent the way the playhead is heading, as the engine's
 * scrub window spends it. The rest covers the ground just behind, which is
 * what a reversal lands on before the new heading is established.
 */
export const WINDOW_LEAD_FRACTION = 0.75;

export interface PlayheadMotion {
  /**
   * The playhead landed at `position`. `settledAdvance` is the widest
   * forward step playback makes, in the same unit; a move past it, or any
   * move back, is a jump.
   */
  observe(position: number, settledAdvance: number): void;
  /**
   * False while the playhead is dragged: it jumped twice in a row. A single
   * jump is a seek that lands, and the window may lead it at once.
   */
  readonly settled: boolean;
  /** Which way the playhead travels: 1, -1, or 0 without enough to say. */
  heading(): -1 | 0 | 1;
  /** Playback started or stopped: the gesture that moved the playhead is over. */
  endGesture(): void;
}

export function createPlayheadMotion(
  now: () => number = () => performance.now(),
): PlayheadMotion {
  const positions = new Float64Array(HEADING_SAMPLE_CAPACITY);
  const times = new Float64Array(HEADING_SAMPLE_CAPACITY);
  let count = 0;
  let writeIndex = 0;
  let previous: number | null = null;
  let jumps = 0;
  let settled = true;

  const fromNewest = (back: number) =>
    (writeIndex - 1 - back + HEADING_SAMPLE_CAPACITY) % HEADING_SAMPLE_CAPACITY;
  const fromOldest = () =>
    (writeIndex - count + HEADING_SAMPLE_CAPACITY) % HEADING_SAMPLE_CAPACITY;
  const net = () => positions[fromNewest(0)] - positions[fromOldest()];

  const sample = (position: number, atMs: number) => {
    if (count > 0) {
      const latest = fromNewest(0);

      // A clock that has not advanced would divide the step by nothing.
      if (atMs <= times[latest]) {
        positions[latest] = position;
        return;
      }
      // The samples behind a reversal describe a gesture that is over; only
      // against an established heading, so one twitch cannot reset it.
      if (
        count >= MIN_SAMPLES_FOR_HEADING &&
        (position - positions[latest]) * net() < 0
      ) {
        count = 1;
      }
    }
    positions[writeIndex] = position;
    times[writeIndex] = atMs;
    writeIndex = (writeIndex + 1) % HEADING_SAMPLE_CAPACITY;
    if (count < HEADING_SAMPLE_CAPACITY) count += 1;
  };

  return {
    observe(position, settledAdvance) {
      const last = previous;

      // A redraw of the frame on screen says nothing about how it moves.
      if (last === position) return;
      previous = position;
      sample(position, now());
      if (last === null) return;

      const advance = position - last;

      if (advance > 0 && advance <= settledAdvance) {
        jumps = 0;
        settled = true;
        return;
      }
      jumps += 1;
      settled = jumps < DRAGGED_PLAYHEAD_JUMP_COUNT;
    },

    get settled() {
      return settled;
    },

    heading() {
      if (count < MIN_SAMPLES_FOR_HEADING) return 0;

      const travelled = net();

      return travelled > 0 ? 1 : travelled < 0 ? -1 : 0;
    },

    endGesture() {
      jumps = 0;
      settled = true;
      count = 0;
      writeIndex = 0;
    },
  };
}

/**
 * How many frames each present moves, from the last few that moved. A
 * cadence counts only once it has repeated, which is what separates it from
 * a seek.
 */
export interface PresentedFrameStride {
  observe(step: number): void;
  /** The narrowest of the repeated strides, 1 until there are enough. */
  narrowest(): number;
  /** How far presents move on average, 1 until there are enough. */
  average(): number;
  /**
   * The stride every recent present moved, or 1 when they differ: a cadence
   * that alternates lands on frames no single stride names.
   */
  uniform(): number;
  reset(): void;
}

/**
 * `sampleCount` is how many moves a cadence has to repeat over. A cadence
 * that is not a whole number of frames, 3.2 at 8x of 24 fps on 60 Hz, moves
 * 3, 3, 3, 3 and then 4, so a reading that skips frames on it needs more
 * than four moves to see that.
 */
export function createPresentedFrameStride(
  sampleCount = PRESENTED_FRAME_STRIDE_SAMPLE_COUNT,
): PresentedFrameStride {
  const samples: number[] = [];
  const full = () => samples.length >= sampleCount;

  return {
    observe(step) {
      if (step <= 0 || step > MAX_PRESENTED_FRAME_STRIDE) return;
      samples.push(step);
      if (samples.length > sampleCount) samples.shift();
    },
    narrowest: () => (full() ? Math.min(...samples) : 1),
    average: () =>
      full()
        ? samples.reduce((sum, step) => sum + step, 0) / samples.length
        : 1,
    uniform: () =>
      full() && samples.every((step) => step === samples[0]) ? samples[0] : 1,
    reset() {
      samples.length = 0;
    },
  };
}

/**
 * The playhead's own frame plus one schedule batch ahead. A batch is the most
 * a window commits to in one pass, so a resting playhead holds a single pass
 * of work, and a step forward still lands on a frame already prepared.
 */
export function getPausedPreparedWindowFrameCount(options: {
  readonly prefetchFrameCount: number;
  readonly scheduleBatchSize: number;
}) {
  return Math.min(options.prefetchFrameCount, options.scheduleBatchSize + 1);
}
