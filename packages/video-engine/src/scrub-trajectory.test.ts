import { describe, expect, it } from "vitest";

import { ScrubTrajectory } from "./scrub-trajectory";
import { asSec } from "./types";

const SAMPLE_INTERVAL_MS = 10;
const RING_CAPACITY = 8;

/** Feeds positions at a fixed cadence, returning the timestamp the next one would take. */
function feed(
  trajectory: ScrubTrajectory,
  positionsS: number[],
  startMs = 0,
  intervalMs = SAMPLE_INTERVAL_MS,
): number {
  let atMs = startMs;
  for (const positionS of positionsS) {
    trajectory.sample(asSec(positionS), atMs);
    atMs += intervalMs;
  }
  return atMs;
}

function ramp(fromS: number, stepS: number, samples: number): number[] {
  return Array.from({ length: samples }, (_, i) => fromS + i * stepS);
}

describe("ScrubTrajectory", () => {
  it("asserts no heading before a gesture exists", () => {
    const trajectory = new ScrubTrajectory();
    expect(trajectory.heading()).toBe(0);

    trajectory.sample(asSec(4), 0);
    trajectory.sample(asSec(4.05), SAMPLE_INTERVAL_MS);
    expect(trajectory.heading()).toBe(0);
  });

  it("a stationary pointer has no heading", () => {
    const trajectory = new ScrubTrajectory();
    feed(trajectory, ramp(4, 0, RING_CAPACITY));
    expect(trajectory.heading()).toBe(0);
  });

  it("a steady drag reads its direction", () => {
    const forward = new ScrubTrajectory();
    feed(forward, ramp(10, 0.05, RING_CAPACITY));
    const backward = new ScrubTrajectory();
    feed(backward, ramp(10, -0.05, RING_CAPACITY));

    expect(forward.heading()).toBe(1);
    expect(backward.heading()).toBe(-1);
  });

  it("a reversal drops the old direction, and waits for a gesture before asserting a new one", () => {
    const trajectory = new ScrubTrajectory();
    const atMs = feed(trajectory, ramp(10, 0.05, RING_CAPACITY));

    // One step against the heading is what a stray pixel of pointer jitter
    // looks like. It has to stop carrying the forward motion, but taking it
    // as a new gesture would aim the whole prefetch window backward behind a
    // hand that is still going forward.
    trajectory.sample(asSec(10.3), atMs);
    expect(trajectory.heading()).toBe(0);

    // A second step the same way is a gesture, and it reads backward.
    trajectory.sample(asSec(10.25), atMs + SAMPLE_INTERVAL_MS);
    expect(trajectory.heading()).toBe(-1);
  });

  it("a twitch the hand recovers from does not suppress the heading twice", () => {
    const trajectory = new ScrubTrajectory();
    const atMs = feed(trajectory, ramp(10, 0.05, RING_CAPACITY));
    expect(trajectory.heading()).toBe(1);

    // One pixel of hand shake backwards, then the drag carries on forwards.
    trajectory.sample(asSec(10.3), atMs);
    trajectory.sample(asSec(10.36), atMs + SAMPLE_INTERVAL_MS);

    // Resuming the original direction must not read as a second reversal.
    // After the twitch the ring holds the step INTO it, so its net
    // displacement is the twitch itself, and a forward sample tested against
    // that resets again: the heading stays lost for another sample, and on a
    // shaky slow drag it can stay lost for most of the gesture.
    expect(trajectory.heading()).toBe(1);
  });

  it("the heading spans only the newest samples the ring holds", () => {
    const trajectory = new ScrubTrajectory();
    const atMs = feed(trajectory, ramp(0, 0.01, RING_CAPACITY));
    // Far enough forward that the ring's oldest sample, were it still held,
    // would sit behind the newest either way; only the ring bound decides.
    feed(trajectory, ramp(0.17, 0.1, RING_CAPACITY), atMs);
    expect(trajectory.heading()).toBe(1);
  });

  it("a custom capacity bounds the ring", () => {
    const trajectory = new ScrubTrajectory(3);
    feed(trajectory, ramp(0, 0.01, 3));
    expect(trajectory.heading()).toBe(1);
  });

  it("a sample that does not advance the clock replaces the latest", () => {
    const trajectory = new ScrubTrajectory();
    trajectory.sample(asSec(10), 0);
    trajectory.sample(asSec(10.1), SAMPLE_INTERVAL_MS);
    trajectory.sample(asSec(10.2), 2 * SAMPLE_INTERVAL_MS);
    expect(trajectory.heading()).toBe(1);

    // Same clock reading as the newest sample: it overwrites rather than
    // joining the ring, so the ring still spans three samples.
    trajectory.sample(asSec(9.9), 2 * SAMPLE_INTERVAL_MS);
    expect(trajectory.heading()).toBe(-1);
  });

  it("reset drops the gesture", () => {
    const trajectory = new ScrubTrajectory();
    feed(trajectory, ramp(10, 0.05, RING_CAPACITY));
    expect(trajectory.heading()).toBe(1);

    trajectory.reset();
    expect(trajectory.heading()).toBe(0);
  });
});
