import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioContextMediaClock, PerformanceMediaClock } from "./clock";

/** Drives performance.now() so every media-time reading below is exact. */
function fakeWallClock(): {
  advance: (ms: number) => void;
  restore: () => void;
} {
  let wallMs = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => wallMs);
  return {
    advance: (ms: number): void => {
      wallMs += ms;
    },
    restore: (): void => spy.mockRestore(),
  };
}

describe("PerformanceMediaClock rate", () => {
  let wall: ReturnType<typeof fakeWallClock>;

  beforeEach(() => {
    wall = fakeWallClock();
  });

  afterEach(() => {
    wall.restore();
  });

  it("defaults to 1x and advances media time with wall time", () => {
    const clock = new PerformanceMediaClock();
    expect(clock.rate).toBe(1);
    clock.play(0);
    wall.advance(1000);
    expect(clock.now()).toBeCloseTo(1, 6);
  });

  it("2x advances media time twice as fast as wall time", () => {
    const clock = new PerformanceMediaClock();
    clock.setRate(2);
    clock.play(0);
    wall.advance(5000);
    expect(clock.now()).toBeCloseTo(10, 6);
  });

  it("0.5x advances media time half as fast as wall time", () => {
    const clock = new PerformanceMediaClock();
    clock.setRate(0.5);
    clock.play(0);
    wall.advance(5000);
    expect(clock.now()).toBeCloseTo(2.5, 6);
  });

  it("a rate change mid-playback does not move the playhead", () => {
    const clock = new PerformanceMediaClock();
    clock.play(0);
    wall.advance(1000);
    const before = clock.now();
    clock.setRate(4);
    expect(clock.now()).toBeCloseTo(before, 9);
  });

  it("only the span after a rate change runs at the new rate", () => {
    const clock = new PerformanceMediaClock();
    clock.play(0);
    wall.advance(1000);
    clock.setRate(2);
    wall.advance(1000);
    // 1s of wall at 1x, then 1s of wall at 2x. A clock that re-applied the
    // new rate to the whole elapsed span would read 4.
    expect(clock.now()).toBeCloseTo(3, 6);
  });

  it("a rate set while paused leaves the playhead put and applies on play", () => {
    const clock = new PerformanceMediaClock();
    clock.seek(5);
    clock.setRate(2);
    wall.advance(1000);
    expect(clock.now()).toBe(5);
    clock.play();
    wall.advance(1000);
    expect(clock.now()).toBeCloseTo(7, 6);
  });

  it("pause, play and seek all preserve the rate", () => {
    const clock = new PerformanceMediaClock();
    clock.setRate(2);
    clock.play(0);
    wall.advance(500);
    clock.pause();
    expect(clock.rate).toBe(2);
    clock.seek(0);
    expect(clock.rate).toBe(2);
    clock.play();
    wall.advance(1000);
    expect(clock.rate).toBe(2);
    expect(clock.now()).toBeCloseTo(2, 6);
  });

  it("pausing freezes media time at the rate-scaled position", () => {
    const clock = new PerformanceMediaClock();
    clock.setRate(4);
    clock.play(0);
    wall.advance(250);
    clock.pause();
    wall.advance(10_000);
    expect(clock.now()).toBeCloseTo(1, 6);
  });
});

describe("AudioContextMediaClock rate", () => {
  function fakeAudioContext(): {
    ctx: AudioContext;
    advance: (s: number) => void;
  } {
    let currentTime = 0;
    return {
      ctx: {
        get currentTime(): number {
          return currentTime;
        },
      } as AudioContext,
      advance: (s: number): void => {
        currentTime += s;
      },
    };
  }

  it("scales context time by the rate and re-anchors on a change", () => {
    const { ctx, advance } = fakeAudioContext();
    const clock = new AudioContextMediaClock(ctx);
    clock.play(0);
    advance(1);
    const before = clock.now();
    clock.setRate(2);
    expect(clock.now()).toBeCloseTo(before, 9);
    advance(1);
    expect(clock.now()).toBeCloseTo(3, 6);
  });
});
