import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import { AnalysisSession } from "./analysis-session";
import type {
  CanvasFrameSource,
  DecodeSourceHandle,
  WrappedCanvasLike,
} from "./decode-source";
import { FrameTimeline } from "./frame-timeline";
import { type KeyframePacketLike, type KeyframeProbe } from "./keyframe-index";
import { type ScrubTrackInfo } from "./scrub-cursor";
import { asSec } from "./types";
import { installWorkerGlobals } from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

const TRACK: ScrubTrackInfo = {
  width: 1280,
  height: 720,
  decodeWidth: 160,
  decodeHeight: 90,
  rotation: 0,
  nativeFps: 30,
  durationS: asSec(10),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

/** Source frame handle; the fake 2D context ignores it on copy. */
const SRC = { width: 1280, height: 720 } as unknown as OffscreenCanvas;

class FakeSink implements CanvasFrameSource {
  readonly atTimestampsCalls: number[] = [];
  /** One entry per iterator driven, which is one seek and GOP walk each. */
  readonly passes: number[][] = [];

  constructor(private readonly missing = new Set<number>()) {}

  async getCanvas(): Promise<WrappedCanvasLike | null> {
    return null;
  }

  async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {}

  async *canvasesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<WrappedCanvasLike | null, void, unknown> {
    const pass: number[] = [];
    this.passes.push(pass);

    for (const t of timestamps) {
      this.atTimestampsCalls.push(t);
      pass.push(t);
      yield this.missing.has(t) ? null : { canvas: SRC, timestamp: t };
    }
  }
}

class FakeKeyframeProbe implements KeyframeProbe {
  constructor(private readonly keyframes: number[]) {}

  async getKeyPacket(timestamp: number): Promise<KeyframePacketLike | null> {
    let found: number | null = null;
    for (const k of this.keyframes) {
      if (k <= timestamp) found = k;
      else break;
    }
    return found === null ? null : { timestamp: found };
  }

  async getNextKeyPacket(
    packet: KeyframePacketLike,
  ): Promise<KeyframePacketLike | null> {
    const i = this.keyframes.indexOf(packet.timestamp);
    if (i === -1 || i + 1 >= this.keyframes.length) return null;
    return { timestamp: this.keyframes[i + 1] };
  }
}

interface Harness {
  session: AnalysisSession;
  sink: FakeSink;
  disposed: Mock;
}

function makeSession(
  opts: { missing?: Set<number>; keyframes?: number[] } = {},
): Harness {
  const sink = new FakeSink(opts.missing);
  const disposed = vi.fn();
  const handle: DecodeSourceHandle = {
    track: TRACK,
    sink,
    keyframeProbe: new FakeKeyframeProbe(opts.keyframes ?? [0, 2, 4, 6, 8]),
    dispose: async () => {
      disposed();
    },
  };
  return { session: new AnalysisSession(handle), sink, disposed };
}

describe("AnalysisSession", () => {
  it("metadata reflects the opened track", () => {
    const { session } = makeSession();
    expect(session.metadata).toEqual({
      durationS: 10,
      width: 1280,
      height: 720,
      frameWidth: 160,
      frameHeight: 90,
      nativeFps: 30,
    });
  });

  it("keyframeTimestamps returns the keyframes covering a range", async () => {
    const { session } = makeSession({ keyframes: [0, 2, 4, 6, 8] });
    expect(await session.keyframeTimestamps(3, 7)).toEqual([2, 4, 6]);
  });

  it("extractFrames sorts timestamps and copies each into its own frame", async () => {
    const { session, sink } = makeSession();
    const frames = await session.extractFrames([3, 1, 2]);

    expect(sink.atTimestampsCalls).toEqual([1, 2, 3]);
    expect(frames.map((f) => f.timestampS)).toEqual([1, 2, 3]);
    expect(frames[0].width).toBe(160);
    expect(frames[0].height).toBe(90);
    expect(frames[0].canvas).not.toBe(SRC);
  });

  it("extractFrames skips timestamps with no frame", async () => {
    const { session } = makeSession({ missing: new Set([2]) });
    const frames = await session.extractFrames([1, 2, 3]);
    expect(frames.map((f) => f.timestampS)).toEqual([1, 3]);
  });

  it("extractFrames decodes the whole set in one pass", async () => {
    const { session, sink } = makeSession();
    await session.extractFrames([1, 2, 3]);

    expect(sink.passes).toEqual([[1, 2, 3]]);
  });

  it("extractFrames is empty for empty input", async () => {
    const { session } = makeSession();
    expect(await session.extractFrames([])).toEqual([]);
  });

  it("framesAtTimestamps decodes the whole set in one pass", async () => {
    const { session, sink } = makeSession();
    const frames = [];
    for await (const frame of session.framesAtTimestamps([1, 2, 3])) {
      frames.push(frame);
    }

    expect(sink.passes).toEqual([[1, 2, 3]]);
    expect(frames.map((f) => f?.timestampS)).toEqual([1, 2, 3]);
  });

  it("framesAtTimestamps keeps a gap on the timestamp it belongs to", async () => {
    const { session } = makeSession({ missing: new Set([2]) });
    const frames = [];
    for await (const frame of session.framesAtTimestamps([1, 2, 3])) {
      frames.push(frame);
    }

    expect(frames.map((f) => f?.timestampS ?? null)).toEqual([1, null, 3]);
  });

  it("framesAtTimestamps yields in the order asked for", async () => {
    const { session, sink } = makeSession();
    const frames = [];
    for await (const frame of session.framesAtTimestamps([3, 1, 2])) {
      frames.push(frame);
    }

    expect(sink.passes).toEqual([[3, 1, 2]]);
    expect(frames.map((f) => f?.timestampS)).toEqual([3, 1, 2]);
  });

  it("close disposes the source and stops extraction", async () => {
    const { session, disposed } = makeSession();
    await session.close();

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(await session.extractFrames([1])).toEqual([]);
  });

  it("a close during extraction resolves with the frames gathered so far", async () => {
    const disposed = vi.fn();
    const ref: { session?: AnalysisSession } = {};
    // Yields one frame, then closes the session and throws on the next pull,
    // simulating the source being disposed mid-decode.
    const sink: CanvasFrameSource = {
      async getCanvas() {
        return null;
      },
      async *canvases() {},
      async *canvasesAtTimestamps(timestamps) {
        let i = 0;
        for (const t of timestamps) {
          if (i === 1) {
            void ref.session?.close();
            throw new Error("source disposed");
          }
          i++;
          yield { canvas: SRC, timestamp: t };
        }
      },
    };
    const handle: DecodeSourceHandle = {
      track: TRACK,
      sink,
      keyframeProbe: new FakeKeyframeProbe([0]),
      dispose: async () => {
        disposed();
      },
    };
    ref.session = new AnalysisSession(handle);

    const frames = await ref.session.extractFrames([1, 2, 3]);

    expect(frames.map((f) => f.timestampS)).toEqual([1]);
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
