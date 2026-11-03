import { describe, expect, it } from "vitest";
import { PLAYBACK_RATE } from "supervision/web-video-engine";

import {
  PLAYER_SPEED_RANGE,
  clampPlayerSpeed,
  parsePlayerSpeed,
} from "./player-speed";

describe("player speed", () => {
  it("offers exactly the range the engine accepts", () => {
    expect(PLAYER_SPEED_RANGE).toEqual({
      max: PLAYBACK_RATE.MAX,
      min: PLAYBACK_RATE.MIN,
    });
    expect(PLAYER_SPEED_RANGE.max).toBeGreaterThanOrEqual(16);
  });

  it("reads typed speeds with or without the trailing x", () => {
    expect(parsePlayerSpeed("3")).toBe(3);
    expect(parsePlayerSpeed(" 12x ")).toBe(12);
    expect(parsePlayerSpeed("1.5X")).toBe(1.5);
  });

  it("pulls a speed the engine would refuse back inside its range", () => {
    expect(parsePlayerSpeed("64")).toBe(PLAYBACK_RATE.MAX);
    expect(parsePlayerSpeed("0.1")).toBe(PLAYBACK_RATE.MIN);
  });

  it("lands every speed on the field's step", () => {
    expect(clampPlayerSpeed(1.234)).toBe(1.25);
    expect(clampPlayerSpeed(6.01)).toBe(6);
  });

  it("leaves the running speed alone for text that names none", () => {
    expect(parsePlayerSpeed("")).toBeNull();
    expect(parsePlayerSpeed("x")).toBeNull();
    expect(parsePlayerSpeed("fast")).toBeNull();
    expect(parsePlayerSpeed("0")).toBeNull();
    expect(parsePlayerSpeed("-2")).toBeNull();
  });
});
