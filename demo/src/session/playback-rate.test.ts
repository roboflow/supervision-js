import { describe, expect, it } from "vitest";

import {
  cyclePlaybackRate,
  isPlaybackRateSustained,
  resolveShuttleCommand,
  stepPlaybackRate,
} from "./playback-rate";

describe("playback rate ladder", () => {
  it("walks the rungs in both directions", () => {
    expect(stepPlaybackRate(1, 1)).toBe(2);
    expect(stepPlaybackRate(2, 1)).toBe(4);
    expect(stepPlaybackRate(4, 1)).toBe(8);
    expect(stepPlaybackRate(1, -1)).toBe(0.5);
    expect(stepPlaybackRate(0.5, -1)).toBe(0.25);
  });

  it("rests at the ends rather than wrapping", () => {
    expect(stepPlaybackRate(8, 1)).toBe(8);
    expect(stepPlaybackRate(0.25, -1)).toBe(0.25);
  });

  it("wraps when the pill is clicked past the top", () => {
    expect(cyclePlaybackRate(4)).toBe(8);
    expect(cyclePlaybackRate(8)).toBe(0.25);
  });

  it("starts from the nearest rung to a rate set elsewhere", () => {
    expect(stepPlaybackRate(3.5, 1)).toBe(8);
    expect(stepPlaybackRate(1.2, -1)).toBe(0.5);
  });
});

describe("J-K-L shuttle", () => {
  it("starts a stopped player at the speed it already holds", () => {
    expect(resolveShuttleCommand("l", { isPlaying: false, rate: 1 })).toEqual({
      playback: "play",
      rate: 1,
    });
    expect(resolveShuttleCommand("j", { isPlaying: false, rate: 4 })).toEqual({
      playback: "play",
      rate: 4,
    });
  });

  it("climbs on repeated L and drops on repeated J", () => {
    expect(resolveShuttleCommand("l", { isPlaying: true, rate: 1 })).toEqual({
      playback: null,
      rate: 2,
    });
    expect(resolveShuttleCommand("l", { isPlaying: true, rate: 2 })).toEqual({
      playback: null,
      rate: 4,
    });
    expect(resolveShuttleCommand("j", { isPlaying: true, rate: 4 })).toEqual({
      playback: null,
      rate: 2,
    });
    expect(resolveShuttleCommand("j", { isPlaying: true, rate: 1 })).toEqual({
      playback: null,
      rate: 0.5,
    });
  });

  it("stops and returns to 1x on K", () => {
    expect(resolveShuttleCommand("k", { isPlaying: true, rate: 8 })).toEqual({
      playback: "pause",
      rate: 1,
    });
    expect(
      resolveShuttleCommand("K", { isPlaying: false, rate: 0.25 }),
    ).toEqual({ playback: "pause", rate: 1 });
  });

  it("leaves every other key to its own binding", () => {
    expect(resolveShuttleCommand(" ", { isPlaying: true, rate: 1 })).toBeNull();
    expect(
      resolveShuttleCommand("ArrowRight", { isPlaying: true, rate: 1 }),
    ).toBeNull();
  });
});

describe("sustained playback rate", () => {
  it("calls out a picture running well under the rate it was commanded", () => {
    expect(isPlaybackRateSustained(4, 1.5)).toBe(false);
    expect(isPlaybackRateSustained(2, 1.2)).toBe(false);
  });

  it("calls out a shortfall at the default rate", () => {
    expect(isPlaybackRateSustained(1, 0.4)).toBe(false);
    expect(isPlaybackRateSustained(1, 0.79)).toBe(false);
  });

  it("accepts a picture close enough to the commanded rate", () => {
    expect(isPlaybackRateSustained(4, 3.4)).toBe(true);
    expect(isPlaybackRateSustained(2, 2.1)).toBe(true);
    expect(isPlaybackRateSustained(1, 0.8)).toBe(true);
    expect(isPlaybackRateSustained(1, 0.95)).toBe(true);
  });

  it("claims no shortfall it cannot see", () => {
    expect(isPlaybackRateSustained(8, null)).toBe(true);
    expect(isPlaybackRateSustained(1, null)).toBe(true);
    expect(isPlaybackRateSustained(0.5, 0.1)).toBe(true);
    expect(isPlaybackRateSustained(0.25, 0.05)).toBe(true);
  });
});
