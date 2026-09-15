import { FrameTimeline } from "#web-video-engine";
import { describe, expect, it } from "vitest";
import { createMediaFrameClock } from "./media-frame-clock";

describe("media frame clock", () => {
  it("exposes exact variable-rate timing with a nonzero origin", () => {
    const clock = createMediaFrameClock(
      FrameTimeline.from({
        tickRate: 90000,
        ticks: Float64Array.from([22500, 25503, 31509]),
        lastDurationTicks: 4500,
      }),
    );

    expect(clock.frameCount).toBe(3);
    expect(clock.firstTimestamp).toBe(0.25);
    expect(clock.endTimestamp).toBe(36009 / 90000);
    expect(clock.duration).toBe(36009 / 90000 - 0.25);
    for (let index = 0; index < clock.frameCount; index++) {
      expect(clock.indexAtOrBefore(clock.timeAt(index))).toBe(index);
    }
    expect(clock.durationAt(0)).toBe(3003 / 90000);
    expect(clock.durationAt(1)).toBe(6006 / 90000);
    expect(clock.durationAt(2)).toBe(0.05);
    expect(clock.indexAtOrBefore(-1)).toBe(0);
    expect(clock.indexAtOrBefore(100)).toBe(2);
  });

  it("uses the presentation table after duplicate and pre-roll normalization", () => {
    const clock = createMediaFrameClock(
      FrameTimeline.from({
        tickRate: 1000,
        ticks: Float64Array.from([-80, -40, -40, 20, 60]),
        lastDurationTicks: 40,
      }),
    );
    expect(clock.frameCount).toBe(3);
    expect([0, 1, 2].map(clock.timeAt)).toEqual([0, 0.02, 0.06]);
    expect(clock.durationAt(0)).toBe(0.02);
    expect(clock.endTimestamp).toBe(0.1);
  });

  it("rejects invalid addresses instead of silently selecting another frame", () => {
    const clock = createMediaFrameClock(FrameTimeline.uniform(30, 3));
    for (const index of [-1, 3, 0.5, NaN, Infinity]) {
      expect(() => clock.timeAt(index)).toThrow(RangeError);
      expect(() => clock.durationAt(index)).toThrow(RangeError);
    }
    expect(() => clock.indexAtOrBefore(NaN)).toThrow(RangeError);
    expect(() => clock.indexAtOrBefore(Infinity)).toThrow(RangeError);
  });
});
