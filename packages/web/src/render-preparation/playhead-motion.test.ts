import { describe, expect, it } from "vitest";

import {
  createPlayheadMotion,
  createPresentedFrameStride,
  getPausedPreparedWindowFrameCount,
} from "./playhead-motion";

/** A clock that moves 10 ms on every read, as pointer samples do. */
function steppingClock() {
  let now = 0;

  return () => (now += 10);
}

function observe(
  motion: ReturnType<typeof createPlayheadMotion>,
  positions: readonly number[],
) {
  for (const position of positions) motion.observe(position, 4);
}

describe("playhead motion", () => {
  it("tells playback from a seek from a drag by how the playhead lands", () => {
    const motion = createPlayheadMotion(steppingClock());

    observe(motion, [0, 1, 2, 3]);
    expect(motion.settled).toBe(true);

    // One jump is a seek that lands; the next steps settle again.
    observe(motion, [40, 41]);
    expect(motion.settled).toBe(true);

    // Jumps that repeat are a hand dragging.
    observe(motion, [60, 80]);
    expect(motion.settled).toBe(false);

    motion.endGesture();
    expect(motion.settled).toBe(true);
  });

  it("reads which way the playhead travels from three samples, the engine's rule", () => {
    const forward = createPlayheadMotion(steppingClock());
    const backward = createPlayheadMotion(steppingClock());

    observe(forward, [10, 12]);
    expect(forward.heading()).toBe(0);
    observe(forward, [14]);
    expect(forward.heading()).toBe(1);

    observe(backward, [50, 47, 44]);
    expect(backward.heading()).toBe(-1);
  });

  it("drops the old heading on a reversal, and survives a twitch the hand recovers from", () => {
    const motion = createPlayheadMotion(steppingClock());

    observe(motion, [10, 12, 14, 16, 18]);
    observe(motion, [17]);
    expect(motion.heading()).toBe(0);
    observe(motion, [19, 21]);
    expect(motion.heading()).toBe(1);

    observe(motion, [20, 18]);
    expect(motion.heading()).toBe(-1);
  });

  it("forgets the heading once the gesture is over", () => {
    const motion = createPlayheadMotion(steppingClock());

    observe(motion, [30, 28, 26]);
    motion.endGesture();
    expect(motion.heading()).toBe(0);
  });
});

describe("presented frame stride", () => {
  it("names a cadence only once it has repeated", () => {
    const stride = createPresentedFrameStride();

    for (const step of [2, 2, 2]) stride.observe(step);
    expect(stride.narrowest()).toBe(1);
    stride.observe(2);
    expect(stride.narrowest()).toBe(2);
    expect(stride.uniform()).toBe(2);
  });

  it("follows the narrowest of an uneven cadence, and calls none uniform", () => {
    const stride = createPresentedFrameStride();

    for (const step of [3, 3, 4, 3]) stride.observe(step);
    expect(stride.narrowest()).toBe(3);
    expect(stride.uniform()).toBe(1);
  });

  it("ignores moves no present makes", () => {
    const stride = createPresentedFrameStride();

    for (const step of [0, -2, 9, 2, 2, 2, 2]) stride.observe(step);
    expect(stride.uniform()).toBe(2);
    stride.reset();
    expect(stride.uniform()).toBe(1);
  });
});

describe("paused window", () => {
  it("is the playhead's frame and one batch, within the prefetch", () => {
    expect(
      getPausedPreparedWindowFrameCount({
        prefetchFrameCount: 12,
        scheduleBatchSize: 2,
      }),
    ).toBe(3);
    expect(
      getPausedPreparedWindowFrameCount({
        prefetchFrameCount: 2,
        scheduleBatchSize: 16,
      }),
    ).toBe(2);
  });
});
