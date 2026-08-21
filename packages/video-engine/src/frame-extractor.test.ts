import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import { AnalysisSession } from "./analysis-session";
import type {
  CanvasFrameSource,
  DecodeSourceHandle,
  WrappedCanvasLike,
} from "./decode-source";
import { FrameExtractor } from "./frame-extractor";
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
  nativeFps: 30,
  durationS: asSec(10),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

const SRC = { width: 1280, height: 720 } as unknown as OffscreenCanvas;

class FakeSink implements CanvasFrameSource {
  readonly atTimestampsCalls: number[] = [];

  async getCanvas(): Promise<WrappedCanvasLike | null> {
    return null;
  }

  async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {}

  async *canvasesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<WrappedCanvasLike | null, void, unknown> {
    for (const t of timestamps) {
      this.atTimestampsCalls.push(t);
      yield { canvas: SRC, timestamp: t };
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
  extractor: FrameExtractor;
  sink: FakeSink;
  disposed: Mock;
}

function make(opts: { keyframes?: number[] } = {}): Harness {
  const sink = new FakeSink();
  const disposed = vi.fn();
  const handle: DecodeSourceHandle = {
    track: TRACK,
    sink,
    keyframeProbe: new FakeKeyframeProbe(opts.keyframes ?? [0, 2, 4, 6, 8]),
    dispose: async () => {
      disposed();
    },
  };
  return {
    extractor: new FrameExtractor(new AnalysisSession(handle)),
    sink,
    disposed,
  };
}

describe("FrameExtractor", () => {
  it("evenlySpaced samples the middle of each slice", async () => {
    const { extractor, sink } = make();
    const frames = await extractor.evenlySpaced(4);

    // Duration 10s, step 2.5s, sampled at the slice midpoints.
    expect(sink.atTimestampsCalls).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(frames).toHaveLength(4);
  });

  it("evenlySpaced is empty for a non-positive count", async () => {
    const { extractor } = make();
    expect(await extractor.evenlySpaced(0)).toEqual([]);
  });

  it("atKeyframes pulls one frame per keyframe in range", async () => {
    const { extractor, sink } = make({ keyframes: [0, 2, 4] });
    const frames = await extractor.atKeyframes();

    expect(sink.atTimestampsCalls).toEqual([0, 2, 4]);
    expect(frames.map((f) => f.timestampS)).toEqual([0, 2, 4]);
  });

  it("extractAt forwards exact timestamps, sorted", async () => {
    const { extractor, sink } = make();
    await extractor.extractAt([2, 1]);
    expect(sink.atTimestampsCalls).toEqual([1, 2]);
  });

  it("close disposes the underlying session", async () => {
    const { extractor, disposed } = make();
    await extractor.close();
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
