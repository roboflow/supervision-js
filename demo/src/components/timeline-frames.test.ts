import { describe, expect, it } from "vitest";
import { FrameTimeline } from "supervision-js-video-engine";

import {
  formatTimelineFrame,
  quantizeScrubTime,
  readTimelineFrames,
  resolveScrubTime,
  resolveTimelineFrame,
} from "./timeline-frames";

/**
 * A table that lies the way `large.mp4` does: the container declares 600 ticks
 * a second and the packets arrive at about 56, and the spacing wanders. A
 * resolve that averaged a rate out of either figure answers a different frame
 * on the first boundary here.
 */
const TICK_RATE = 600;
const LYING_TICKS = Float64Array.of(0, 11, 22, 30, 41, 52, 60, 71, 82, 90);
const lyingTable = FrameTimeline.from({
  lastDurationTicks: 11,
  tickRate: TICK_RATE,
  ticks: LYING_TICKS,
});
const DURATION = 101 / TICK_RATE;
const TRACK_PX = 1170;

/** The x a frame's own timestamp sits at on a track of `TRACK_PX`. */
function offsetOfTick(ticks: number) {
  return (ticks / TICK_RATE / DURATION) * TRACK_PX;
}

describe("resolveTimelineFrame", () => {
  it("answers on both sides of every boundary of a table whose spacing wanders", () => {
    for (const [index, ticks] of LYING_TICKS.entries()) {
      expect(
        resolveTimelineFrame(
          lyingTable,
          offsetOfTick(ticks) + 0.01,
          TRACK_PX,
          DURATION,
        ),
      ).toEqual({ index, timeS: ticks / TICK_RATE });

      if (index > 0) {
        expect(
          resolveTimelineFrame(
            lyingTable,
            offsetOfTick(ticks) - 0.01,
            TRACK_PX,
            DURATION,
          )?.index,
        ).toBe(index - 1);
      }
    }
  });

  it("holds the earlier frame across the whole gap to the next one", () => {
    const justBeforeSeven = offsetOfTick(71) - 0.001;

    expect(
      resolveTimelineFrame(lyingTable, justBeforeSeven, TRACK_PX, DURATION),
    ).toEqual({ index: 6, timeS: 60 / TICK_RATE });
  });

  it("reports the earlier frame from a pointer nine tenths of the way to the next", () => {
    const nearlySeven = offsetOfTick(60 + 0.9 * 11);

    expect(
      resolveTimelineFrame(lyingTable, nearlySeven, TRACK_PX, DURATION)?.index,
    ).toBe(6);
  });

  it("agrees with the engine's own snap at every offset across the track", () => {
    for (let offset = 0; offset <= TRACK_PX; offset += 1) {
      const resolved = resolveTimelineFrame(
        lyingTable,
        offset,
        TRACK_PX,
        DURATION,
      );

      expect(resolved?.index).toBe(
        lyingTable.indexAtOrBefore((offset / TRACK_PX) * DURATION),
      );
    }
  });

  it("clamps a pointer dragged off either end onto the frames that exist", () => {
    expect(
      resolveTimelineFrame(lyingTable, -80, TRACK_PX, DURATION)?.index,
    ).toBe(0);
    expect(
      resolveTimelineFrame(lyingTable, TRACK_PX + 80, TRACK_PX, DURATION)
        ?.index,
    ).toBe(LYING_TICKS.length - 1);
  });

  it("names no frame at all when there is no table", () => {
    expect(resolveTimelineFrame(null, 400, TRACK_PX, DURATION)).toBe(null);
  });
});

describe("resolveScrubTime", () => {
  it("publishes the same seconds for two pointers inside one frame", () => {
    const insideFrameSix = offsetOfTick(60) + 0.4;
    const alsoInsideFrameSix = offsetOfTick(71) - 0.4;

    expect(
      resolveScrubTime(lyingTable, insideFrameSix, TRACK_PX, DURATION),
    ).toBe(
      resolveScrubTime(lyingTable, alsoInsideFrameSix, TRACK_PX, DURATION),
    );
  });

  it("publishes a new seconds the move a pointer crosses into the next frame", () => {
    expect(
      resolveScrubTime(lyingTable, offsetOfTick(71) - 0.4, TRACK_PX, DURATION),
    ).not.toBe(
      resolveScrubTime(lyingTable, offsetOfTick(71) + 0.4, TRACK_PX, DURATION),
    );
  });

  it("publishes the pointer's own position, and a new one every move, with no table", () => {
    expect(resolveScrubTime(null, 400, TRACK_PX, DURATION)).toBe(
      (400 / TRACK_PX) * DURATION,
    );
    expect(resolveScrubTime(null, 400.5, TRACK_PX, DURATION)).not.toBe(
      resolveScrubTime(null, 400, TRACK_PX, DURATION),
    );
  });
});

describe("quantizeScrubTime", () => {
  it("moves a seconds-domain step onto the frame covering it", () => {
    expect(quantizeScrubTime(lyingTable, 70 / TICK_RATE)).toBe(60 / TICK_RATE);
  });

  it("leaves a step where it fell when there is no table", () => {
    expect(quantizeScrubTime(null, 70 / TICK_RATE)).toBe(70 / TICK_RATE);
  });
});

describe("readTimelineFrames", () => {
  it("degrades on a source that never reported a table", () => {
    expect(readTimelineFrames(null)).toBe(null);
    expect(readTimelineFrames(undefined)).toBe(null);
  });

  it("degrades on a table carrying no frames", () => {
    expect(
      readTimelineFrames({
        lastDurationTicks: 0,
        tickRate: TICK_RATE,
        ticks: new Float64Array(0),
      }),
    ).toBe(null);
  });

  it("reads a table the engine did report", () => {
    expect(
      readTimelineFrames({
        lastDurationTicks: 11,
        tickRate: TICK_RATE,
        ticks: LYING_TICKS,
      })?.frameCount,
    ).toBe(LYING_TICKS.length);
  });
});

describe("formatTimelineFrame", () => {
  it("leads with the index and carries the frame's own timestamp to the millisecond", () => {
    expect(formatTimelineFrame({ index: 1352, timeS: 45.0666666 })).toBe(
      "f1352 · 45.067s",
    );
  });

  it("separates two adjacent frames of a 30fps clip, which two decimals cannot", () => {
    expect(formatTimelineFrame({ index: 1352, timeS: 45.0666 })).not.toBe(
      formatTimelineFrame({ index: 1353, timeS: 45.1 }),
    );
  });
});
