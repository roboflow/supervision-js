import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import { CanvasSinkScrubCursor } from "./canvas-sink-scrub-cursor";
import type {
  CanvasFrameSource,
  DecodeSourceHandle,
  WrappedCanvasLike,
} from "./decode-source";
import { FrameTimeline } from "./frame-timeline";
import { type KeyframeProbe } from "./keyframe-index";
import {
  ScrubCursorState,
  type ScrubFrame,
  type ScrubTrackInfo,
} from "./scrub-cursor";
import { asSec } from "./types";
import { installWorkerGlobals } from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

const TRACK: ScrubTrackInfo = {
  width: 320,
  height: 180,
  decodeWidth: 320,
  decodeHeight: 180,
  nativeFps: 30,
  durationS: asSec(5),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

const SRC = { width: 320, height: 180 } as unknown as OffscreenCanvas;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeSink implements CanvasFrameSource {
  readonly getCanvasCalls: number[] = [];

  constructor(private readonly frames: number[] = []) {}

  async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
    this.getCanvasCalls.push(timestampS);
    return { canvas: SRC, timestamp: timestampS };
  }

  async *canvases(
    startS: number,
  ): AsyncGenerator<WrappedCanvasLike, void, unknown> {
    for (const t of this.frames) {
      if (t >= startS) yield { canvas: SRC, timestamp: t };
    }
  }

  async *canvasesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<WrappedCanvasLike | null, void, unknown> {
    for (const t of timestamps) yield { canvas: SRC, timestamp: t };
  }
}

// CanvasSinkScrubCursor ignores the probe; getCanvas at-or-before is its
// keyframe semantics. A stub satisfies the handle shape.
const NOOP_PROBE: KeyframeProbe = {
  async getKeyPacket() {
    return null;
  },
  async getNextKeyPacket() {
    return null;
  },
};

interface Harness {
  cursor: CanvasSinkScrubCursor;
  sink: FakeSink;
  disposed: Mock;
}

function setup(frames?: number[]): Harness {
  const sink = new FakeSink(frames);
  const disposed = vi.fn();
  const source: DecodeSourceHandle = {
    track: TRACK,
    sink,
    keyframeProbe: NOOP_PROBE,
    dispose: async () => {
      disposed();
    },
  };
  return { cursor: new CanvasSinkScrubCursor(source), sink, disposed };
}

function record(cursor: CanvasSinkScrubCursor): ScrubFrame[] {
  const frames: ScrubFrame[] = [];
  cursor.subscribe((f) => frames.push(f));
  return frames;
}

describe("CanvasSinkScrubCursor", () => {
  it("open seeds and emits the first frame", async () => {
    const { cursor, sink } = setup();
    const frames = record(cursor);
    await cursor.open();

    expect(sink.getCanvasCalls).toEqual([0]);
    expect(frames.map((f) => f.timestampS)).toEqual([0]);
    expect(cursor.state).toBe(ScrubCursorState.Idle);
  });

  it("peekCached is always null on the uncached backend", async () => {
    const { cursor } = setup();
    await cursor.open();
    expect(cursor.peekCached()).toBeNull();
  });

  it("seekTo decodes and emits", async () => {
    const { cursor, sink } = setup();
    await cursor.open();
    const frames = record(cursor);
    frames.length = 0;

    cursor.seekTo(asSec(1));
    await cursor.idle();

    expect(sink.getCanvasCalls).toEqual([0, 1]);
    expect(frames.map((f) => f.timestampS)).toEqual([1]);
  });

  it("seekToKey marks the emitted frame as a keyframe", async () => {
    const { cursor } = setup();
    await cursor.open();
    const frames = record(cursor);
    frames.length = 0;

    cursor.seekToKey(asSec(2));
    await cursor.idle();

    expect(frames[0].isKeyFrame).toBe(true);
  });

  it("a burst of seeks keeps the in-flight target and the latest", async () => {
    const { cursor, sink } = setup();
    await cursor.open();

    cursor.seekTo(asSec(1));
    cursor.seekTo(asSec(2));
    cursor.seekTo(asSec(3));
    await cursor.idle();

    expect(sink.getCanvasCalls).toEqual([0, 1, 3]);
  });

  it("seekToFrame decodes the frame it was handed, forwards or back", async () => {
    const { cursor, sink } = setup([0, 1, 2, 3]);
    await cursor.open();

    expect(
      (await cursor.seekToFrame(TRACK.timeline.idAt(60)))?.timestampS,
    ).toBe(2);
    expect(
      (await cursor.seekToFrame(TRACK.timeline.idAt(30)))?.timestampS,
    ).toBe(1);
    expect(sink.getCanvasCalls).toEqual([0, 2, 1]);
  });

  it("play pulls advance forward", async () => {
    const { cursor } = setup([0, 1, 2, 3]);
    await cursor.open();
    const frames = record(cursor);
    frames.length = 0;

    cursor.attachPlay(0);
    cursor.next();
    await tick();
    cursor.next();
    await tick();
    cursor.detachPlay();

    expect(frames.map((f) => f.timestampS)).toEqual([0, 1]);
  });

  it("subscribe replays the most recent frame", async () => {
    const { cursor } = setup();
    await cursor.open();
    const late = record(cursor);
    expect(late.map((f) => f.timestampS)).toEqual([0]);
  });

  it("close disposes the source and goes inert", async () => {
    const { cursor, disposed } = setup();
    await cursor.open();
    await cursor.close();

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(cursor.state).toBe(ScrubCursorState.Closed);
  });

  describe("non-zero track origin (T4b)", () => {
    const OFFSET_TRACK: ScrubTrackInfo = {
      ...TRACK,
      firstTimestampS: asSec(2),
    };

    function offsetSetup(): Harness {
      const sink = new FakeSink();
      const source: DecodeSourceHandle = {
        track: OFFSET_TRACK,
        sink,
        keyframeProbe: NOOP_PROBE,
        dispose: async () => undefined,
      };
      return {
        cursor: new CanvasSinkScrubCursor(source),
        sink,
        disposed: vi.fn(),
      };
    }

    it("open seeds at the first timestamp, not 0", async () => {
      const { cursor, sink } = offsetSetup();
      const frames = record(cursor);
      await cursor.open();

      expect(sink.getCanvasCalls).toEqual([2]);
      expect(frames.map((f) => f.timestampS)).toEqual([2]);
    });

    it("a seek below the origin clamps up to the first timestamp", async () => {
      const { cursor, sink } = offsetSetup();
      await cursor.open();
      sink.getCanvasCalls.length = 0;

      cursor.seekTo(asSec(0.5));
      await cursor.idle();

      expect(sink.getCanvasCalls).toEqual([2]);
    });

    it("a seek at or above the origin passes through unclamped", async () => {
      const { cursor, sink } = offsetSetup();
      await cursor.open();
      sink.getCanvasCalls.length = 0;

      cursor.seekTo(asSec(3));
      await cursor.idle();

      expect(sink.getCanvasCalls).toEqual([3]);
    });

    it("seekToFrame reads the frame table, not the requested origin", async () => {
      const { cursor } = offsetSetup();
      await cursor.open();

      const result = await cursor.seekToFrame(OFFSET_TRACK.timeline.idAt(0));
      expect(result?.timestampS).toBe(0);
    });
  });
});
