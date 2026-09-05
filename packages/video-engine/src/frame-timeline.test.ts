import { describe, expect, it } from "vitest";

import { FrameTimeline } from "./frame-timeline";

import horseTicks from "../test/fixtures/horse-trail-ticks.json";
import variableRateTicks from "../test/fixtures/variable-rate-ticks.json";

/**
 * A table whose frame gaps never settle, at a tick rate that is not a multiple
 * of any frame rate: the shape a constant-rate assumption gets wrong.
 */
function syntheticVfr(): FrameTimeline {
  const gaps = [33, 33, 34, 33, 40, 26];
  const ticks: number[] = [7];
  for (let i = 1; i < 600; i++)
    ticks.push(ticks[i - 1] + gaps[i % gaps.length]);
  return FrameTimeline.from({
    lastDurationTicks: 33,
    tickRate: 1000,
    ticks: Float64Array.from(ticks),
  });
}

/**
 * The horse fixture's own packet table, in the order the container stores it.
 * The clip carries B-frames, so decode order is not presentation order, and its
 * frame gaps are 19, 20 and 21 ticks at 600 ticks a second.
 */
function horseTrail(): FrameTimeline {
  const ticks = [...horseTicks.decodeOrderTicks].sort((a, b) => a - b);
  const last = horseTicks.decodeOrderTicks.indexOf(ticks[ticks.length - 1]);
  return FrameTimeline.from({
    lastDurationTicks: horseTicks.decodeOrderDurationTicks[last],
    tickRate: horseTicks.tickRate,
    ticks: Float64Array.from(ticks),
  });
}

/**
 * A screen-recorder shape: 74 of this clip's 300 packets share a presentation
 * timestamp with the packet before them, so the container names 226 instants
 * with 300 packets.
 */
function variableRate(): FrameTimeline {
  const ticks = [...variableRateTicks.decodeOrderTicks].sort((a, b) => a - b);
  const last = variableRateTicks.decodeOrderTicks.indexOf(
    ticks[ticks.length - 1],
  );
  return FrameTimeline.from({
    lastDurationTicks: variableRateTicks.decodeOrderDurationTicks[last],
    tickRate: variableRateTicks.tickRate,
    ticks: Float64Array.from(ticks),
  });
}

const TABLES: Array<[string, () => FrameTimeline]> = [
  ["a synthetic VFR table", syntheticVfr],
  ["the horse fixture's own tick table", horseTrail],
  ["the variable-rate fixture's own tick table", variableRate],
];

describe.each(TABLES)("FrameTimeline over %s", (_name, build) => {
  const timeline = build();

  it("names every frame as itself", () => {
    for (let i = 0; i < timeline.frameCount; i++) {
      expect(timeline.indexOfDecoded(timeline.timeAt(i))).toBe(i);
    }
  });

  it("a frame's own published time answers that frame", () => {
    for (let i = 0; i < timeline.frameCount; i++) {
      expect(timeline.indexAtOrBefore(timeline.timeAt(i))).toBe(i);
    }
  });

  /**
   * The two framings in play disagree by a whole microsecond: mediabunny's
   * sinks hand WebCodecs a truncated timestamp and the engine's own decode
   * session hands it a rounded one, and the decoder echoes back whichever it
   * got. A frame has to be recognisable through either.
   */
  it("survives the WebCodecs microsecond round trip", () => {
    for (let i = 0; i < timeline.frameCount; i++) {
      const t = timeline.timeAt(i);
      for (const us of [Math.trunc(t * 1e6), Math.round(t * 1e6)]) {
        expect(timeline.indexOfDecoded(us / 1e6)).toBe(i);
      }
    }
  });

  /** Every frame's own boundary and its interior. A search that is wrong is
   *  wrong at a boundary, so those are checked one by one; the uniform sweep
   *  is there to catch a table the boundaries alone would not describe. */
  it("answers every time in range with the frame that covers it", () => {
    const check = (t: number): void => {
      const index = timeline.indexAtOrBefore(t);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(timeline.frameCount);
      expect(timeline.ticksAt(index)).toBeLessThanOrEqual(
        Math.ceil(t * timeline.tickRate),
      );
      expect(timeline.endTicksAt(index)).toBeGreaterThan(
        Math.floor(t * timeline.tickRate),
      );
    };
    for (let i = 0; i < timeline.frameCount; i++) {
      const start = timeline.ticksAt(i);
      const end = timeline.endTicksAt(i);
      for (const ticks of [start, (start + end) / 2, end - 1])
        check(ticks / timeline.tickRate);
    }
    const first = timeline.ticksAt(0);
    const last = timeline.endTicksAt(timeline.frameCount - 1);
    for (let s = 0; s < 20_000; s++) {
      check((first + ((last - first) * s) / 20_000) / timeline.tickRate);
    }
  });

  it("is monotone in time", () => {
    const step = 1 / timeline.tickRate;
    const end = timeline.timeAt(timeline.frameCount - 1);
    let previous = 0;
    let regression: { at: number; from: number; to: number } | null = null;

    for (let t: number = timeline.timeAt(0); t < end; t += step) {
      const index = timeline.indexAtOrBefore(t);
      if (index < previous) {
        regression ??= { at: t, from: previous, to: index };
      }
      previous = index;
    }

    expect(regression).toBeNull();
  });

  it("a time before the first frame answers the first frame", () => {
    expect(timeline.indexAtOrBefore(timeline.timeAt(0) - 10)).toBe(0);
    expect(timeline.indexOfDecoded(timeline.timeAt(0) - 10)).toBe(0);
  });

  it("a time past the last frame answers the last frame", () => {
    const last = timeline.frameCount - 1;
    expect(timeline.indexAtOrBefore(timeline.timeAt(last) + 10)).toBe(last);
    expect(timeline.indexOfDecoded(timeline.timeAt(last) + 10)).toBe(last);
  });

  it("each frame ends where the next one starts", () => {
    for (let i = 0; i + 1 < timeline.frameCount; i++) {
      expect(timeline.endTicksAt(i)).toBe(timeline.ticksAt(i + 1));
    }
  });

  it("an index outside the table is clamped into it", () => {
    expect(timeline.idAt(-5)).toEqual(timeline.idAt(0));
    expect(timeline.idAt(timeline.frameCount + 5)).toEqual(
      timeline.idAt(timeline.frameCount - 1),
    );
  });
});

describe("FrameTimeline construction", () => {
  it("drops pre-roll and clamps only the frame straddling public zero", () => {
    const timeline = FrameTimeline.from({
      lastDurationTicks: 20,
      tickRate: 600,
      ticks: Float64Array.from([-40, -20, 10, 30]),
    });

    expect(Array.from(timeline.toData().ticks)).toEqual([0, 10, 30]);
    expect(Array.from(timeline.toData().sourceTicks ?? [])).toEqual([
      -20, 10, 30,
    ]);
    expect(timeline.timeAt(0)).toBe(0);
    expect(timeline.sourceTimeAt(0)).toBe(-1 / 30);
    expect(timeline.fromSourceTime(-1 / 30)).toBe(0);
    expect(timeline.toSourceTime(10 / 600)).toBe(10 / 600);
  });

  it("a track with no frames has no timeline", () => {
    expect(() =>
      FrameTimeline.from({
        lastDurationTicks: 1,
        tickRate: 600,
        ticks: new Float64Array(0),
      }),
    ).toThrow(RangeError);
  });

  it("a tick rate that is not positive is refused", () => {
    expect(() =>
      FrameTimeline.from({
        lastDurationTicks: 1,
        tickRate: 0,
        ticks: Float64Array.from([0, 1]),
      }),
    ).toThrow(RangeError);
  });

  it("packets sharing a presentation timestamp name one frame", () => {
    const timeline = FrameTimeline.from({
      lastDurationTicks: 3000,
      tickRate: 90_000,
      ticks: Float64Array.from([0, 3000, 9000, 12_000, 12_000, 15_000]),
    });

    expect(timeline.frameCount).toBe(5);
    expect(timeline.ticksAt(3)).toBe(12_000);
    expect(timeline.ticksAt(4)).toBe(15_000);
  });

  it("the variable-rate fixture names 226 frames, not 300 packets", () => {
    expect(variableRate().frameCount).toBe(226);
  });

  it("a uniform table lands every frame on its own whole tick", () => {
    const timeline = FrameTimeline.uniform(30, 1000);

    expect(timeline.frameCount).toBe(1000);
    expect(timeline.tickRate).toBe(30_000);
    expect(timeline.ticksAt(1)).toBe(1000);
    expect(timeline.timeAt(3)).toBe(0.1);
    expect(timeline.endTicksAt(999)).toBe(1_000_000);
  });

  it("a uniform table's published times answer their own frames", () => {
    for (const fps of [24, 25, 29.97, 30, 60]) {
      const timeline = FrameTimeline.uniform(fps, 600);
      for (let i = 0; i < timeline.frameCount; i++) {
        expect(timeline.indexAtOrBefore(timeline.timeAt(i))).toBe(i);
      }
    }
  });

  it("the data it was built from is what it hands back", () => {
    const data = {
      lastDurationTicks: 20,
      tickRate: 600,
      ticks: Float64Array.from([0, 20, 39, 59]),
    };

    expect(FrameTimeline.from(data).toData()).toBe(data);
  });
});

/**
 * The millisecond plane the runtime publishes is not a lossless re-encoding of a
 * real frame time. This is the size of the error the table removes.
 */
it("the horse fixture's frames are mostly unrepresentable in whole milliseconds", () => {
  const timeline = horseTrail();
  let exact = 0;
  for (let i = 0; i < timeline.frameCount; i++) {
    const t = timeline.timeAt(i);
    if (Math.round(t * 1000) / 1000 === t) exact += 1;
  }

  expect(exact).toBe(704);
  expect(timeline.frameCount).toBe(2113);
});
