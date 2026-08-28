import { describe, expect, it, vi } from "vitest";

import type {
  PresentedFrame,
  PresentedFrameHandler,
} from "supervision-js-web-video-engine";
import type { MediaRendererSource } from "supervision";
import {
  createPresentedFrameTap,
  readPresentedPerSecond,
  readPresentedRate,
  type PresentedFrameRecord,
  type PresentedFrameTap,
} from "./presented-frame-tap";

interface FakeProducer {
  onPresentedFrame(handler: PresentedFrameHandler): void;
  present(presented: PresentedFrame): void;
  scrub(timeMs: number): void;
  readonly seeks: number[];
}

function createFakeProducer(): FakeProducer {
  let handler: PresentedFrameHandler | null = null;
  const seeks: number[] = [];

  return {
    onPresentedFrame(nextHandler) {
      handler = nextHandler;
    },
    present(presented) {
      handler?.(presented);
    },
    scrub(timeMs) {
      seeks.push(timeMs);
    },
    seeks,
  };
}

function createFakeFrame(): VideoFrame {
  return { close: vi.fn() } as unknown as VideoFrame;
}

const TICK_RATE = 30000;
const FRAME_RATE = 30;

function createPresentedFrame(mediaTimeMs: number): PresentedFrame {
  const index = Math.round((mediaTimeMs / 1000) * FRAME_RATE);
  const ticks = (index * TICK_RATE) / FRAME_RATE;
  return {
    frame: createFakeFrame(),
    frameId: { index, ticks },
    mediaTimeMs,
    mediaTimeS: ticks / TICK_RATE,
    paintSeq: index,
    quality: "exact",
  };
}

async function openTappedSource(
  tap: PresentedFrameTap,
  producer: FakeProducer,
) {
  const source: MediaRendererSource = {
    open: async () =>
      ({ engine: producer }) as unknown as Awaited<
        ReturnType<MediaRendererSource["open"]>
      >,
  };
  const opened = await tap.tap(source).open();

  return (opened as unknown as { readonly engine: FakeProducer }).engine;
}

describe("presented frame tap", () => {
  it("forwards the presented frame untouched, in the producer's call", async () => {
    const tap = createPresentedFrameTap();
    const producer = createFakeProducer();
    const tappedProducer = await openTappedSource(tap, producer);
    const received: PresentedFrame[] = [];
    let insidePresent = false;
    let forwardedInsidePresent = false;

    tappedProducer.onPresentedFrame((presented) => {
      forwardedInsidePresent = insidePresent;
      received.push(presented);
    });

    const presented = createPresentedFrame(120);

    insidePresent = true;
    producer.present(presented);
    insidePresent = false;

    expect(received).toEqual([presented]);
    expect(received[0]).toBe(presented);
    expect(forwardedInsidePresent).toBe(true);
    expect(presented.frame.close).not.toHaveBeenCalled();
  });

  it("records identity without holding the frame", async () => {
    const tap = createPresentedFrameTap({ now: () => 1_000 });
    const producer = createFakeProducer();
    const tappedProducer = await openTappedSource(tap, producer);

    tappedProducer.onPresentedFrame(() => {});
    const presented = createPresentedFrame(240);
    producer.present(presented);

    const { records } = tap.read();

    // The producer's own seconds, not the millisecond divided back: at this
    // frame rate those are 0.2333 and 0.24, and only the first names a frame.
    expect(presented.mediaTimeS).not.toBe(240 / 1000);
    expect(records).toEqual([
      {
        frameIndex: presented.frameId.index,
        mediaTimeMs: 240,
        mediaTimeS: presented.mediaTimeS,
        paintSeq: presented.paintSeq,
        quality: "exact",
        wallTimeMs: 1_000,
      },
    ]);
    expect(Object.keys(records[0])).toEqual([
      "frameIndex",
      "mediaTimeMs",
      "mediaTimeS",
      "paintSeq",
      "quality",
      "wallTimeMs",
    ]);
  });

  it("keeps presentation order and counts every frame past the ring", async () => {
    const tap = createPresentedFrameTap({ capacity: 3, now: () => 0 });
    const producer = createFakeProducer();
    const tappedProducer = await openTappedSource(tap, producer);
    const forwardedMediaTimes: number[] = [];

    tappedProducer.onPresentedFrame((presented) => {
      forwardedMediaTimes.push(presented.mediaTimeMs);
    });

    for (const mediaTimeMs of [10, 20, 30, 40, 50]) {
      producer.present(createPresentedFrame(mediaTimeMs));
    }

    const snapshot = tap.read();

    expect(forwardedMediaTimes).toEqual([10, 20, 30, 40, 50]);
    expect(snapshot.records.map((record) => record.mediaTimeMs)).toEqual([
      30, 40, 50,
    ]);
    expect(snapshot.presentedCount).toBe(5);
    expect(snapshot.lastPresented?.mediaTimeMs).toBe(50);
  });

  it("leaves the producer's other members reachable", async () => {
    const tap = createPresentedFrameTap();
    const producer = createFakeProducer();
    const tappedProducer = await openTappedSource(tap, producer);

    (tappedProducer as unknown as { scrub(timeMs: number): void }).scrub(500);

    expect(producer.seeks).toEqual([500]);
  });

  it("leaves a source without a presented-frame producer alone", async () => {
    const tap = createPresentedFrameTap();
    const opened = { sampleSink: {} };
    const source = {
      open: async () => opened,
    } as unknown as MediaRendererSource;

    expect(await tap.tap(source).open()).toBe(opened);
  });

  it("drops every record on reset", async () => {
    const tap = createPresentedFrameTap({ now: () => 0 });
    const producer = createFakeProducer();
    const tappedProducer = await openTappedSource(tap, producer);

    tappedProducer.onPresentedFrame(() => {});
    producer.present(createPresentedFrame(80));
    tap.reset();

    expect(tap.read()).toEqual({
      lastPresented: null,
      presentedCount: 0,
      presentedPerSecond: null,
      records: [],
    });
  });
});

describe("presented frame rate", () => {
  it("reports no rate while nothing presents", () => {
    expect(readPresentedPerSecond([], 5_000)).toBeNull();
    expect(
      readPresentedPerSecond(
        [
          {
            frameIndex: 0,
            mediaTimeMs: 0,
            mediaTimeS: 0 / 1000,
            paintSeq: 1,
            quality: "exact",
            wallTimeMs: 3_500,
          },
        ],
        5_000,
      ),
    ).toBeNull();
  });

  it("counts only the frames inside the trailing window", () => {
    const records = [4_200, 4_600, 4_900, 5_000].map((wallTimeMs, index) => ({
      frameIndex: index,
      mediaTimeMs: wallTimeMs,
      mediaTimeS: wallTimeMs / 1000,
      paintSeq: index + 1,
      quality: "exact" as const,
      wallTimeMs,
    }));

    expect(readPresentedPerSecond(records, 5_000)).toBe(4);
    expect(readPresentedPerSecond(records, 5_500)).toBe(3);
  });
});

describe("presented playback rate", () => {
  it("measures the media time the picture covered per wall second", () => {
    const records = createRecords([
      [4_200, 8_400],
      [4_600, 9_200],
      [4_900, 9_800],
      [5_000, 10_000],
    ]);

    expect(readPresentedRate(records, 5_000)).toBe(2);
  });

  it("reads a picture falling short of the rate it was commanded", () => {
    const records = createRecords([
      [4_200, 8_400],
      [4_600, 8_800],
      [5_000, 9_200],
    ]);

    expect(readPresentedRate(records, 5_000)).toBeCloseTo(1);
  });

  it("measures nothing from a window too thin to hold a slope", () => {
    expect(readPresentedRate([], 5_000)).toBeNull();
    expect(
      readPresentedRate(
        createRecords([
          [4_800, 9_600],
          [5_000, 10_000],
        ]),
        5_000,
      ),
    ).toBeNull();
  });

  it("measures nothing across a jump the playhead took", () => {
    const records = createRecords([
      [4_400, 9_800],
      [4_600, 200],
      [4_800, 600],
      [5_000, 1_000],
    ]);

    expect(readPresentedRate(records, 5_000)).toBeNull();
  });
});

function createRecords(
  entries: readonly (readonly [number, number])[],
): readonly PresentedFrameRecord[] {
  return entries.map(([wallTimeMs, mediaTimeMs], index) => ({
    frameIndex: index,
    mediaTimeMs,
    mediaTimeS: mediaTimeMs / 1000,
    paintSeq: index + 1,
    quality: "exact" as const,
    wallTimeMs,
  }));
}
