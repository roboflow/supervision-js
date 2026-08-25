import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeResolution, viewportResolution } from "./decode-resolution";
import {
  decodeSessionViable,
  detectVideoDecoder,
  detectWebgpuImport,
  openFrameProvider,
  zeroCopyViable,
  type DecodeSourceHandle,
  type SampleFrameSource,
  type SampleSourceHandle,
  type SessionSourceHandle,
} from "./decode-source";
import type { CanvasFrameSource, WrappedCanvasLike } from "./decode-source";
import { FrameTimeline } from "./frame-timeline";
import type { KeyframeProbe } from "./keyframe-index";
import { idempotentSample, type ScrubTrackInfo } from "./scrub-cursor";
import { asSec } from "./types";
import { FakeVideoSample } from "../test/fake-engine-deps";

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

const PROBE: KeyframeProbe = {
  async getKeyPacket() {
    return null;
  },
  async getNextKeyPacket() {
    return null;
  },
};

describe("zeroCopyViable", () => {
  const base = {
    prefer2d: false,
    strategy: nativeResolution(),
    webgpuImportAvailable: true,
  };

  it("true only when every condition holds", () => {
    expect(zeroCopyViable(base)).toBe(true);
  });

  it("prefer2d rules it out", () => {
    expect(zeroCopyViable({ ...base, prefer2d: true })).toBe(false);
  });

  it("no webgpu import rules it out", () => {
    expect(zeroCopyViable({ ...base, webgpuImportAvailable: false })).toBe(
      false,
    );
  });

  it("a viewport strategy takes the path anyway, and the GPU scales", () => {
    expect(zeroCopyViable({ ...base, strategy: viewportResolution() })).toBe(
      true,
    );
  });
});

describe("decodeSessionViable", () => {
  const AVCC: VideoDecoderConfig = {
    codec: "avc1.640028",
    description: new Uint8Array([1, 100, 0, 40, 0xff]),
  };

  it("an AVCC H.264 track in a WebCodecs realm takes the session", () => {
    expect(
      decodeSessionViable({ videoDecoderAvailable: true, decoderConfig: AVCC }),
    ).toBe(true);
  });

  it("no WebCodecs decoder rules it out", () => {
    expect(
      decodeSessionViable({
        videoDecoderAvailable: false,
        decoderConfig: AVCC,
      }),
    ).toBe(false);
  });

  it("a codec the session cannot anchor rules it out", () => {
    expect(
      decodeSessionViable({
        videoDecoderAvailable: true,
        decoderConfig: {
          codec: "vp09.00.10.08",
          description: AVCC.description,
        },
      }),
    ).toBe(false);
  });

  it("H.264 without its parameter sets rules it out", () => {
    expect(
      decodeSessionViable({
        videoDecoderAvailable: true,
        decoderConfig: { codec: "avc1.640028" },
      }),
    ).toBe(false);
  });
});

describe("detectVideoDecoder", () => {
  const g = globalThis as { VideoDecoder?: unknown };
  const original = g.VideoDecoder;

  afterEach(() => {
    g.VideoDecoder = original;
  });

  it("false in a realm without WebCodecs", () => {
    delete g.VideoDecoder;
    expect(detectVideoDecoder()).toBe(false);
  });

  it("true when the constructor is present", () => {
    g.VideoDecoder = function VideoDecoder(): void {};
    expect(detectVideoDecoder()).toBe(true);
  });
});

describe("detectWebgpuImport", () => {
  const g = globalThis as { GPUDevice?: unknown };
  const origDevice = g.GPUDevice;

  afterEach(() => {
    vi.unstubAllGlobals();
    g.GPUDevice = origDevice;
  });

  it("false without navigator.gpu", () => {
    vi.stubGlobal("navigator", {});
    expect(detectWebgpuImport()).toBe(false);
  });

  it("false when GPUDevice lacks importExternalTexture", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    g.GPUDevice = function GPUDevice(): void {} as unknown;
    expect(detectWebgpuImport()).toBe(false);
  });

  it("true when navigator.gpu and importExternalTexture exist", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const ctor = function GPUDevice(): void {} as unknown as {
      prototype: { importExternalTexture: () => void };
    };
    ctor.prototype.importExternalTexture = (): void => undefined;
    g.GPUDevice = ctor;
    expect(detectWebgpuImport()).toBe(true);
  });
});

describe("idempotentSample", () => {
  it("forwards a single close and no-ops on a second", () => {
    const raw = new FakeVideoSample(1, 0.033);
    const wrapped = idempotentSample(raw);
    wrapped.close();
    wrapped.close();
    wrapped.close();
    expect(raw.closeCount).toBe(1);
  });

  it("forwards draw, toVideoFrame, and the timing fields", () => {
    const raw = new FakeVideoSample(2.5, 0.04);
    const wrapped = idempotentSample(raw);
    expect(wrapped.timestamp).toBe(2.5);
    expect(wrapped.duration).toBe(0.04);
    wrapped.toVideoFrame();
    expect(raw.toVideoFrameCount).toBe(1);
    wrapped.draw({} as OffscreenCanvasRenderingContext2D, 0, 0, 320, 180);
    expect(raw.drawCount).toBe(1);
  });
});

describe("openFrameProvider", () => {
  it("a canvas handle yields canvas frames", async () => {
    const sink: CanvasFrameSource = {
      async getCanvas(t): Promise<WrappedCanvasLike> {
        return {
          canvas: { width: 320, height: 180 } as OffscreenCanvas,
          timestamp: t,
        };
      },
      async *canvases() {},
      async *canvasesAtTimestamps() {},
    };
    const handle: DecodeSourceHandle = {
      track: TRACK,
      sink,
      keyframeProbe: PROBE,
      dispose: async () => undefined,
    };
    const provider = openFrameProvider(handle);
    expect(provider.decodePath).toBe("canvas");
    const frame = await provider.getFrame(1);
    expect(frame?.kind).toBe("canvas");
    expect(frame?.timestamp).toBe(1);
  });

  it("a sample handle yields sample frames wrapped idempotently", async () => {
    const raw = new FakeVideoSample(1);
    const sampleSink: SampleFrameSource = {
      async getSample() {
        return raw;
      },
      async *samples() {},
      async *samplesAtTimestamps() {},
    };
    const handle: SampleSourceHandle = {
      track: TRACK,
      sampleSink,
      keyframeProbe: PROBE,
      dispose: async () => undefined,
    };
    const provider = openFrameProvider(handle);
    expect(provider.decodePath).toBe("sample");
    const frame = await provider.getFrame(1);
    expect(frame?.kind).toBe("sample");
    if (frame?.kind !== "sample") throw new Error("expected sample frame");
    // Double-close the wrapper; the raw underneath sees one real close.
    frame.sample.close();
    frame.sample.close();
    expect(raw.closeCount).toBe(1);
  });

  function sessionHandleWalking(
    covered: Array<[number, number]>,
    reachableFromS = 0,
  ): SessionSourceHandle {
    return {
      track: TRACK,
      session: {
        async frameAt() {
          return null;
        },
        async *framesFrom() {},
        // The walk to a requested timestamp crosses frames nobody asked
        // for; here it yields the requested one plus one before it.
        async *framesCovering(startS, endS) {
          covered.push([startS, endS]);
          yield new FakeVideoSample(startS - 0.5);
          yield new FakeVideoSample(startS);
        },
        framesDecoded: 0,
        reachableFromS,
      },
      keyframeProbe: PROBE,
      dispose: async () => undefined,
    };
  }

  it("a session handle harvests the walk into framesAt", async () => {
    const covered: Array<[number, number]> = [];
    const provider = openFrameProvider(sessionHandleWalking(covered));
    expect(provider.decodePath).toBe("session");

    const yielded: number[] = [];
    for await (const frame of provider.framesAt([2]))
      yielded.push(frame?.timestamp ?? -1);

    expect(yielded).toEqual([1.5, 2]);
  });

  it("only the session path reports a target as dearer than the rest", async () => {
    const session = openFrameProvider(sessionHandleWalking([], 5));
    expect(session.wouldReanchor(4.9)).toBe(true);
    expect(session.wouldReanchor(5)).toBe(false);
    expect(session.wouldReanchor(6)).toBe(false);

    // The sink paths re-position per retrieval, so nothing they are asked
    // for is dearer than anything else.
    const canvas: DecodeSourceHandle = {
      track: TRACK,
      sink: {
        async getCanvas() {
          return null;
        },
        async *canvases() {},
        async *canvasesAtTimestamps() {},
      },
      keyframeProbe: PROBE,
      dispose: async () => undefined,
    };
    expect(openFrameProvider(canvas).wouldReanchor(0)).toBe(false);
  });

  it("framesAt walks to each timestamp in turn, never across the whole request", async () => {
    const covered: Array<[number, number]> = [];
    const provider = openFrameProvider(sessionHandleWalking(covered));

    for await (const _ of provider.framesAt([30, 2, 16])) {
      // Draining the generator is the point; the frames are asserted above.
    }

    // One walk per timestamp, in the order the caller asked for. A single
    // [2, 30] walk would decode every frame of the clip in between, and
    // re-sorting would decide for the caller which frames decode first,
    // which is the caller's to decide: a target behind the read head walks
    // its whole prefix, so what goes first is a latency choice.
    expect(covered).toEqual([
      [30, 30],
      [2, 2],
      [16, 16],
    ]);
  });
});
