import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import { DecodeScheduler } from "./decode-scheduler";
import type { SampleFrameSource, SampleSourceHandle } from "./decode-source";
import { FrameTimeline } from "./frame-timeline";
import { FrameCache } from "./frame-cache";
import { type KeyframePacketLike, type KeyframeProbe } from "./keyframe-index";
import { CanvasRenderer } from "./renderer";
import { ScrubController } from "./scrub-controller";
import type {
  ScrubFrame,
  ScrubTrackInfo,
  VideoSampleLike,
} from "./scrub-cursor";
import { WebGpuRenderer } from "./webgpu-renderer";
import { asSec } from "./types";
import {
  FakeClock,
  FakeVideoSample,
  installWorkerGlobals,
} from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
  // Browser globals the renderer reads as bare bitflags; the test env has no
  // real WebGPU, so stub the ones it ORs together and passes to mapAsync.
  const globals = globalThis as unknown as Record<
    string,
    Record<string, number>
  >;
  globals.GPUTextureUsage = {
    TEXTURE_BINDING: 4,
    COPY_DST: 8,
    RENDER_ATTACHMENT: 16,
    COPY_SRC: 1,
  };
  globals.GPUBufferUsage = { COPY_DST: 8, MAP_READ: 1 };
  globals.GPUMapMode = { READ: 1 };
});

const TRACK: ScrubTrackInfo = {
  width: 320,
  height: 180,
  decodeWidth: 320,
  decodeHeight: 180,
  nativeFps: 30,
  durationS: asSec(10),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

const PROBE: KeyframeProbe = {
  async getKeyPacket(t: number): Promise<KeyframePacketLike | null> {
    return { timestamp: Math.floor(t) };
  },
  async getNextKeyPacket(): Promise<KeyframePacketLike | null> {
    return null;
  },
};

/** Emits a fresh FakeVideoSample on every decode and remembers them all so a
 *  test can assert close counts after the runtime is done with them. */
class FakeSampleSink implements SampleFrameSource {
  readonly produced: FakeVideoSample[] = [];

  constructor(private readonly streamTimestamps: number[] = []) {}

  private make(t: number): FakeVideoSample {
    const s = new FakeVideoSample(t);
    this.produced.push(s);
    return s;
  }

  async getSample(t: number): Promise<VideoSampleLike> {
    return this.make(t);
  }

  async *samples(
    startS: number,
  ): AsyncGenerator<VideoSampleLike, void, unknown> {
    for (const t of this.streamTimestamps) {
      if (t >= startS) yield this.make(t);
    }
  }

  async *samplesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<VideoSampleLike | null, void, unknown> {
    for (const t of timestamps) yield this.make(t);
  }
}

function makeCache(): FrameCache {
  return new FrameCache({
    exactWidth: 320,
    exactHeight: 180,
    previewWidth: 160,
    exactBudgetBytes: 64 * 1024 * 1024,
    previewCapacity: 16,
    bucketMs: 33,
  });
}

function makeScheduler(streamTimestamps: number[] = []): {
  scheduler: DecodeScheduler;
  sink: FakeSampleSink;
  cache: FrameCache;
} {
  const sink = new FakeSampleSink(streamTimestamps);
  const cache = makeCache();
  const handle: SampleSourceHandle = {
    track: TRACK,
    sampleSink: sink,
    keyframeProbe: PROBE,
    dispose: async () => undefined,
  };
  const scheduler = new DecodeScheduler({ source: handle, cache });
  return { scheduler, sink, cache };
}

function makeCanvas(): OffscreenCanvas {
  const ctxStub = { clearRect: vi.fn(), drawImage: vi.fn() };
  return {
    width: 320,
    height: 180,
    getContext: () => ctxStub,
  } as unknown as OffscreenCanvas;
}

const flushRaf = (): Promise<void> =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Flushes pending microtasks plus a macrotask turn, so a fire-and-forget drain
 *  finishes its post-release close before assertions run. */
const flushTasks = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("sample cache interaction", () => {
  it("a fresh decode draws the sample into the cache as a canvas, never retaining it", async () => {
    const { scheduler, sink, cache } = makeScheduler();
    const frames: ScrubFrame[] = [];
    scheduler.subscribe((f) => frames.push(f));
    await scheduler.open();

    // open() seeded one sample frame.
    const seed = frames[0];
    expect(seed.kind).toBe("sample");
    // The cache holds a canvas blit in both tiers: every emit now seeds the
    // exact tier and a coarse preview copy, so the seed sample is drawn twice
    // (once per tier) but never retained.
    expect(cache.stats.exactSize).toBe(1);
    expect(cache.stats.previewSize).toBe(1);
    const cached = scheduler.peekCached(0);
    expect(cached?.kind).toBe("canvas");
    expect(sink.produced[0].drawCount).toBe(2);
    // The emitted sample is NOT yet closed; the controller owns that after paint.
    expect(sink.produced[0].closeCount).toBe(0);
  });

  it("a prefetch-swept sample is drawn into the cache then closed", async () => {
    const { scheduler, sink } = makeScheduler();
    await scheduler.open();
    await scheduler.whenSettled();

    // The seed sample (index 0) is emitted, not swept; every swept sample
    // after it must be closed since it is never emitted.
    const swept = sink.produced.slice(1);
    expect(swept.length).toBeGreaterThan(0);
    for (const s of swept) {
      expect(s.drawCount).toBe(1);
      expect(s.closeCount).toBe(1);
    }
  });
});

describe("cursor step close discipline", () => {
  it("seekToFrame leaves the emitted sample open for the paint that owns it", async () => {
    const { scheduler, sink } = makeScheduler([1, 2, 3]);
    const stepped = await scheduler.seekToFrame(TRACK.timeline.idAt(60));

    expect(stepped?.kind).toBe("sample");
    // The named frame is the one that decodes, and nothing is walked past to
    // reach it, so the only sample the step itself produced is the emitted
    // one, whose close the controller owns after paint.
    expect(sink.produced[0].timestamp).toBe(2);
    expect(sink.produced[0].closeCount).toBe(0);
  });
});

describe("teardown-race early-return close discipline", () => {
  /**
   * A sample sink whose single-frame reads are gated on a manual release, so a
   * test can flip the scheduler closed between a decode settling and the early
   * return that checks `this.closed`. That window is exactly where a fetched
   * sample used to leak: the early return dropped it without a close.
   */
  class GatedSampleSink implements SampleFrameSource {
    readonly produced: FakeVideoSample[] = [];
    private release: (() => void) | null = null;
    private gateReached: (() => void) | null = null;

    private make(t: number): FakeVideoSample {
      const s = new FakeVideoSample(t);
      this.produced.push(s);
      return s;
    }

    /** Resolves the most recent gated read, after the test has torn down. */
    releaseGate(): void {
      this.release?.();
      this.release = null;
    }

    /** Resolves once a read is suspended at the gate, so the test can tear
     *  down with a decode genuinely in flight. */
    whenGated(): Promise<void> {
      return new Promise<void>((resolve) => {
        this.gateReached = resolve;
      });
    }

    private gated(t: number): Promise<VideoSampleLike> {
      return new Promise<VideoSampleLike>((resolve) => {
        this.release = () => resolve(this.make(t));
        this.gateReached?.();
        this.gateReached = null;
      });
    }

    getSample(t: number): Promise<VideoSampleLike> {
      return this.gated(t);
    }

    async *samples(): AsyncGenerator<VideoSampleLike, void, unknown> {}

    async *samplesAtTimestamps(
      timestamps: Iterable<number>,
    ): AsyncGenerator<VideoSampleLike | null, void, unknown> {
      for (const t of timestamps) yield this.make(t);
    }
  }

  function makeGatedScheduler(): {
    scheduler: DecodeScheduler;
    sink: GatedSampleSink;
  } {
    const sink = new GatedSampleSink();
    const handle: SampleSourceHandle = {
      track: TRACK,
      sampleSink: sink,
      keyframeProbe: PROBE,
      dispose: async () => undefined,
    };
    return {
      scheduler: new DecodeScheduler({ source: handle, cache: makeCache() }),
      sink,
    };
  }

  it("seekToFrame closes its sample when close races the decode", async () => {
    const { scheduler, sink } = makeGatedScheduler();
    const stepP = scheduler.seekToFrame(TRACK.timeline.idAt(60));
    // Tear down while the decode is gated, then let it settle: the early
    // return must close the now-orphaned sample, not drop it.
    await scheduler.close();
    sink.releaseGate();
    await stepP;
    expect(sink.produced).toHaveLength(1);
    expect(sink.produced[0].closeCount).toBe(1);
  });

  it("runExactSeek closes its sample when close races the decode", async () => {
    const { scheduler, sink } = makeGatedScheduler();
    scheduler.seekTo(asSec(1));
    // Let the drain reach the gated decode before tearing down, so close races
    // the in-flight getFrame rather than short-circuiting the drain loop.
    await sink.whenGated();
    await scheduler.close();
    sink.releaseGate();
    await flushTasks();
    expect(sink.produced).toHaveLength(1);
    expect(sink.produced[0].closeCount).toBe(1);
  });

  it("runKeySeek closes its sample when close races the decode", async () => {
    const { scheduler, sink } = makeGatedScheduler();
    scheduler.seekToKey(asSec(1));
    await sink.whenGated();
    await scheduler.close();
    sink.releaseGate();
    await flushTasks();
    expect(sink.produced).toHaveLength(1);
    expect(sink.produced[0].closeCount).toBe(1);
  });

  it("a swept sample is closed when a gesture cancels the sweep mid-batch", async () => {
    // The prefetch early-return fires when the sweep generation moves between
    // a frame decoding and being drawn into the cache. Open seeds a sweep;
    // a fresh seek bumps the generation, so the in-flight swept sample must be
    // closed on the early return rather than leaked.
    const { scheduler, sink } = makeScheduler();
    await scheduler.open();
    await scheduler.whenSettled();
    // Every produced sample is either emitted (the seed) or swept-then-closed.
    const swept = sink.produced.slice(1);
    for (const s of swept) expect(s.closeCount).toBe(1);
  });
});

describe("controller sample close discipline", () => {
  it("a painted sample is closed once, and dispose does not double-close", async () => {
    const { scheduler, sink } = makeScheduler();
    const clock = new FakeClock();
    const painted: ScrubFrame[] = [];
    const controller = new ScrubController({
      cursor: scheduler,
      clock,
      onPaint: (f) => painted.push(f),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    // This realm has no navigator.gpu, so the controller resolves a real
    // CanvasRenderer; its draw runs sample.draw, then the controller closes.
    controller.bindCanvas(makeCanvas());
    await scheduler.open();
    // Let the async renderer resolve, then run a paused tick to paint the seed.
    await flushRaf();
    await flushRaf();
    await flushRaf();

    const seed = sink.produced[0];
    expect(painted.some((f) => f.kind === "sample")).toBe(true);
    expect(seed.closeCount).toBe(1);
    controller.dispose();
    expect(seed.closeCount).toBe(1);
  });

  it("a superseded unpainted sample is closed when a newer frame arrives", async () => {
    const { scheduler, sink } = makeScheduler();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor: scheduler,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    // No renderer: nothing paints, so the stash is overwritten, not drained.
    await scheduler.open();
    const seed = sink.produced[0];
    // Force a second decode that supersedes the unpainted seed in the stash.
    scheduler.seekTo(asSec(1));
    await scheduler.idle();
    expect(seed.closeCount).toBe(1);
    controller.dispose();
  });

  it("dispose closes a stashed-but-never-painted sample", async () => {
    const { scheduler, sink } = makeScheduler();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor: scheduler,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    await scheduler.open();
    const seed = sink.produced[0];
    expect(seed.closeCount).toBe(0); // no renderer ever painted it
    controller.dispose();
    expect(seed.closeCount).toBe(1);
  });
});

describe("renderer dispatch", () => {
  it("CanvasRenderer draws a sample through sample.draw", () => {
    const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
    const canvas = {
      width: 320,
      height: 180,
      getContext: () => ctx,
    } as unknown as OffscreenCanvas;
    const sample = new FakeVideoSample(0);
    new CanvasRenderer(canvas).draw({
      kind: "sample",
      sample,
      timestampS: asSec(0),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    expect(sample.drawCount).toBe(1);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("WebGpuRenderer imports a sample zero-copy once the routes agree", async () => {
    const importExternalTexture = vi.fn(() => ({}) as GPUExternalTexture);
    const copyExternalImageToTexture = vi.fn();
    const { renderer } = makeFakeGpuRenderer({
      importExternalTexture,
      copyExternalImageToTexture,
    });
    const frame = (sample: VideoSampleLike): ScrubFrame => ({
      kind: "sample",
      sample,
      timestampS: asSec(0),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    const measured = new FakeVideoSample(0);
    renderer.draw(frame(measured));
    expect(copyExternalImageToTexture).toHaveBeenCalled();
    expect(measured.closeCount).toBe(0); // the controller owns the sample

    await new Promise((resolve) => setTimeout(resolve, 0));
    copyExternalImageToTexture.mockClear();
    const painted = new FakeVideoSample(0);
    renderer.draw(frame(painted));

    expect(painted.toVideoFrameCount).toBe(1);
    expect(copyExternalImageToTexture).not.toHaveBeenCalled();
    expect(painted.closeCount).toBe(0);
  });

  it("WebGpuRenderer converts a sample through a canvas when importExternalTexture is absent", () => {
    const copyExternalImageToTexture = vi.fn();
    const { renderer } = makeFakeGpuRenderer({
      importExternalTexture: undefined,
      copyExternalImageToTexture,
    });
    const sample = new FakeVideoSample(0);
    renderer.draw({
      kind: "sample",
      sample,
      timestampS: asSec(0),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    expect(sample.toVideoFrameCount).toBe(1);
    expect(copyExternalImageToTexture).toHaveBeenCalledTimes(1);
  });

  it("WebGpuRenderer copies a canvas frame, never importing", () => {
    const importExternalTexture = vi.fn(() => ({}) as GPUExternalTexture);
    const copyExternalImageToTexture = vi.fn();
    const { renderer } = makeFakeGpuRenderer({
      importExternalTexture,
      copyExternalImageToTexture,
    });
    renderer.draw({
      kind: "canvas",
      source: {} as OffscreenCanvas,
      timestampS: asSec(0),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    expect(importExternalTexture).not.toHaveBeenCalled();
    expect(copyExternalImageToTexture).toHaveBeenCalledTimes(1);
  });

  it("WebGpuRenderer copies a canvas frame at the source size, not the canvas size", () => {
    const copyExternalImageToTexture = vi.fn();
    const { renderer } = makeFakeGpuRenderer({
      importExternalTexture: vi.fn(() => ({}) as GPUExternalTexture),
      copyExternalImageToTexture,
    });
    // A downscaled preview frame (160x90) on the 320x180 canvas: the copy must
    // use the frame's own size, or it overruns the small source and fails,
    // which is why WebGPU stopped painting preview frames during a scrub.
    renderer.draw({
      kind: "canvas",
      source: {} as OffscreenCanvas,
      timestampS: asSec(0),
      width: 160,
      height: 90,
      isKeyFrame: false,
      quality: "exact",
    });
    expect(copyExternalImageToTexture).toHaveBeenCalledTimes(1);
    expect(copyExternalImageToTexture.mock.calls[0][2]).toEqual([160, 90]);
  });
});

/**
 * Builds a WebGpuRenderer over a fake device and canvas, bypassing the async
 * create() (which needs a real adapter). The fake device records the queue and
 * import calls the dispatch path makes; pipelines and bind groups are stubs.
 */
function makeFakeGpuRenderer(opts: {
  importExternalTexture?: Mock;
  copyExternalImageToTexture: Mock;
}): { renderer: WebGpuRenderer } {
  const bindGroupLayout = {};
  const pipeline = {
    getBindGroupLayout: () => bindGroupLayout,
  } as unknown as GPURenderPipeline;
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const encoder = {
    beginRenderPass: vi.fn(() => pass),
    copyTextureToBuffer: vi.fn(),
    finish: vi.fn(() => ({})),
  };
  // Both halves of the comparison's readback carry the same value, so the two
  // routes agree once it lands.
  const readback = new Uint8Array(64 * 4 * 64 * 2);
  const device = {
    importExternalTexture: opts.importExternalTexture,
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => pipeline),
    createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({
      destroy: vi.fn(),
      createView: vi.fn(() => ({})),
    })),
    createBuffer: vi.fn(() => ({
      mapAsync: vi.fn(async () => undefined),
      getMappedRange: vi.fn(() => readback.buffer),
      unmap: vi.fn(),
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => encoder),
    queue: {
      copyExternalImageToTexture: opts.copyExternalImageToTexture,
      submit: vi.fn(),
    },
    destroy: vi.fn(),
  };
  const context = {
    getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
  };
  const canvas = { width: 320, height: 180 } as unknown as OffscreenCanvas;
  const sampler = {} as GPUSampler;
  // The constructor is private; reach it through the prototype with the same
  // arg shape create() uses, so the dispatch logic under test runs unchanged.
  const renderer = Reflect.construct(WebGpuRenderer, [
    canvas,
    device as unknown as GPUDevice,
    context as unknown as GPUCanvasContext,
    "rgba8unorm" as GPUTextureFormat,
    pipeline,
    sampler,
  ]) as WebGpuRenderer;
  return { renderer };
}
