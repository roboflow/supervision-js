import { describe, expect, it } from "vitest";

import {
  assertDecodedFrameTimestamp,
  buildFrameTimeTable,
  createFrameTimeTable,
  mapFrameBatch,
  type FramePacketTiming,
} from "./frame-time-table";

/** Timescale and tick counts measured on the horse trail source. */
const SOURCE_TIMESCALE = 600;
const NTSC_FRAME_DURATION = 20 / SOURCE_TIMESCALE;
const SHORT_FRAME_DURATION = 19 / SOURCE_TIMESCALE;
const LONG_FRAME_DURATION = 21 / SOURCE_TIMESCALE;

/** Decode order measured on demo/fixtures/horse_trail/1min-horse-video.mov. */
const REORDERED_DECODE_TIMESTAMPS = [
  0, 0.13333333333333333, 0.06666666666666667, 0.03333333333333333, 0.1,
  0.26666666666666666,
];

describe("frame time table", () => {
  it("sorts decode-order packets into presentation order", async () => {
    const table = await buildFrameTimeTable(
      iterate(
        REORDERED_DECODE_TIMESTAMPS.map((timestamp) => ({
          duration: NTSC_FRAME_DURATION,
          timestamp,
        })),
      ),
    );

    expect(table.entries.map((entry) => entry.timestamp)).toEqual([
      0, 0.03333333333333333, 0.06666666666666667, 0.1, 0.13333333333333333,
      0.26666666666666666,
    ]);
    expect(table.entries.map((entry) => entry.frameIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(table.frameCount).toBe(6);
    expect(table.firstTimestamp).toBe(0);
  });

  it("rejects a repeated frame timestamp", () => {
    expect(() =>
      createFrameTimeTable([
        { duration: 0.04, timestamp: 0 },
        { duration: 0.04, timestamp: 0.08 },
        { duration: 0.04, timestamp: 0.04 },
        { duration: 0.04, timestamp: 0.04 },
      ]),
    ).toThrow(/repeats a frame timestamp: frameIndex=2, timestamp=0.04/);
  });

  it("rejects a packet without a usable timestamp", () => {
    expect(() =>
      createFrameTimeTable([
        { duration: 0.04, timestamp: 0 },
        { duration: 0.04, timestamp: Number.NaN },
      ]),
    ).toThrow(/without a timestamp at decode position 1/);
  });

  it("rejects a track with no frames", () => {
    expect(() => createFrameTimeTable([])).toThrow(
      "The source video track has no frames.",
    );
  });

  it("closes the last frame interval with the track duration", () => {
    const table = createFrameTimeTable(constantRate(3, 0.04));

    expect(table.entries.map((entry) => entry.endTime)).toEqual([
      0.04, 0.08, 0.12,
    ]);
    expect(table.duration).toBe(0.12);
    expect(table.frameRate).toBe(25);
    expect(table.averagePacketRate).toBe(25);
  });

  it("spans a variable frame interval with the next presented timestamp", () => {
    const table = createFrameTimeTable([
      { duration: NTSC_FRAME_DURATION, timestamp: 0 },
      { duration: NTSC_FRAME_DURATION, timestamp: SHORT_FRAME_DURATION },
      { duration: LONG_FRAME_DURATION, timestamp: 0.06666666666666667 },
    ]);

    expect(table.entries[0].endTime).toBe(SHORT_FRAME_DURATION);
    expect(table.entries[1].endTime).toBe(0.06666666666666667);
    expect(table.entries[1].duration).toBe(NTSC_FRAME_DURATION);
    expect(table.entries[2].endTime).toBeCloseTo(
      0.06666666666666667 + LONG_FRAME_DURATION,
      12,
    );
  });

  it("recovers the presentation index from a wobbling source timeline", () => {
    const table = createFrameTimeTable(wobbling(2113));

    expect(table.frameIndexRoundTripError).toBe(0);
    expect(table.frameRate).toBeGreaterThan(30);
    expect(table.frameRate).toBeLessThan(30.01);
  });

  it("samples inside the frame interval instead of on its boundary", () => {
    const table = createFrameTimeTable(constantRate(2, 0.04));

    expect(table.entries[0].sampleQueryTime).toBe(0.001);
    expect(table.entries[1].sampleQueryTime).toBe(0.041);
  });

  it("keeps the sample query time inside a frame shorter than the epsilon", () => {
    const table = createFrameTimeTable([
      { duration: 0.0004, timestamp: 0 },
      { duration: 0.04, timestamp: 0.0004 },
    ]);

    expect(table.entries[0].sampleQueryTime).toBe(0.0004);
  });

  it("maps a batch of ordinals to the table tail", () => {
    const table = createFrameTimeTable(constantRate(225, 0.04));
    const batch = mapFrameBatch(table, 223, 2);

    expect(batch.map((entry) => entry.frameIndex)).toEqual([223, 224]);
    expect(batch[1].timestamp).toBeCloseTo(8.96, 10);
    expect(batch[1].endTime).toBeCloseTo(9, 10);
  });

  it("rejects a batch that runs past the table tail", () => {
    const table = createFrameTimeTable(constantRate(225, 0.04));

    expect(() => mapFrameBatch(table, 224, 2)).toThrow(
      /past the end of the source frame table: startFrameIndex=224, count=2, frameCount=225/,
    );
  });

  it("rejects a decoded frame from a neighbouring source frame", () => {
    const table = createFrameTimeTable(constantRate(3, 0.04));

    expect(() =>
      assertDecodedFrameTimestamp(table.entries[1], 0.04),
    ).not.toThrow();
    expect(() => assertDecodedFrameTimestamp(table.entries[1], 0.08)).toThrow(
      /frameIndex=1, expected=0.04, decoded=0.08/,
    );
  });
});

async function* iterate(packets: readonly FramePacketTiming[]) {
  for (const packet of packets) {
    yield packet;
  }
}

function constantRate(
  frameCount: number,
  frameDuration: number,
): FramePacketTiming[] {
  return Array.from({ length: frameCount }, (_, frameIndex) => ({
    duration: frameDuration,
    timestamp: frameIndex * frameDuration,
  }));
}

/** Reproduces the +/- one-tick timestamp wobble of the horse trail source. */
function wobbling(frameCount: number): FramePacketTiming[] {
  const packets: FramePacketTiming[] = [];
  let timestamp = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const duration =
      frameIndex % 64 === 31
        ? SHORT_FRAME_DURATION
        : frameIndex % 64 === 32
          ? LONG_FRAME_DURATION
          : NTSC_FRAME_DURATION;

    packets.push({ duration, timestamp });
    timestamp += duration;
  }

  return packets;
}
