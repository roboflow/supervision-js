import { SourceKind } from "#web-video-engine";
import type { BlobVideoSource, UrlVideoSource } from "#web-video-engine";
import type { PresentedVideoFrame } from "#renderers/presented-frame-channel";
import { MediaErrorKind } from "supervision-js-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaSourceError } from "./media-errors";
import {
  createWebVideoEngineMediaRendererSource,
  openWebVideoEngineMediaSource,
  type WebVideoEngineMediaSourceOptions,
} from "./video-engine-media-source";

type ReadySnapshot = {
  readonly canDecode: boolean;
  readonly codec: string | null;
  readonly durationMs: number;
  readonly firstTimestampMs: number;
  readonly nativeFps: number | null;
  readonly naturalHeight: number;
  readonly naturalWidth: number;
};

type FakeFrame = {
  readonly canvas: OffscreenCanvas;
  readonly height: number;
  readonly timestampS: number;
  readonly width: number;
};

const engine = vi.hoisted(() => ({
  dispose: vi.fn(async () => undefined),
  load: vi.fn(),
  onPresentedFrame: vi.fn(),
  options: [] as unknown[],
  presentedHandler: null as
    | ((presented: {
        frame: { close(): void };
        frameId: { index: number; ticks: number };
        mediaTimeS: number;
        paintSeq: number;
      }) => void)
    | null,
}));

const analysis = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  extractFrames: vi.fn(),
  framesAtTimestamps: vi.fn(),
  open: vi.fn(),
}));

const engineModule = vi.hoisted(() => () => ({
  SourceKind: { Blob: "blob", Stream: "stream", Url: "url" },
  displayBoxResolution: (options: unknown) => ({
    kind: "displayBox",
    ...(options as object),
  }),
  WebVideoEngine: class {
    readonly dispose = engine.dispose;
    readonly load = engine.load;
    onPresentedFrame = engine.onPresentedFrame;

    constructor(options: unknown) {
      engine.options.push(options);
    }
  },
}));

const analysisModule = vi.hoisted(() => () => ({
  AnalysisSession: { open: analysis.open },
}));

vi.mock("#web-video-engine", engineModule);

vi.mock("#web-video-engine/analysis", analysisModule);

const READY_SNAPSHOT: ReadySnapshot = {
  canDecode: true,
  codec: "avc1.640028",
  durationMs: 4000,
  firstTimestampMs: 40,
  nativeFps: 25,
  naturalHeight: 1080,
  naturalWidth: 1920,
};

const urlSource: UrlVideoSource = {
  kind: SourceKind.Url,
  url: "https://example.test/clip.mp4",
};

function createFrames(timestamps: readonly number[]): FakeFrame[] {
  return timestamps.map((timestampS) => ({
    canvas: { timestampS } as unknown as OffscreenCanvas,
    height: 1080,
    timestampS,
    width: 1920,
  }));
}

function presentedFrame(mediaTimeS: number, close = vi.fn()) {
  return {
    frame: { close },
    frameId: {
      index: Math.round(mediaTimeS * 1000),
      ticks: Math.round(mediaTimeS * 1000),
    },
    mediaTimeS,
    paintSeq: Math.round(mediaTimeS * 1000) + 1,
  };
}

/**
 * Answers like mediabunny's canvas sink: the last frame starting at or before
 * the timestamp, nothing before the first frame, and the final frame for every
 * timestamp past the end of the track.
 */
function stubExtraction(frames: readonly FakeFrame[]) {
  const covering = (timestamp: number) =>
    frames.reduce<FakeFrame | null>(
      (found, frame) => (frame.timestampS <= timestamp + 1e-6 ? frame : found),
      null,
    );

  analysis.extractFrames.mockImplementation(
    async (timestamps: readonly number[]) =>
      timestamps
        .map(covering)
        .filter((frame): frame is FakeFrame => frame !== null),
  );
  analysis.framesAtTimestamps.mockImplementation(async function* (
    timestamps: readonly number[],
  ) {
    for (const timestamp of timestamps) yield covering(timestamp);
  });
}

async function collectTimestamps(
  samples: AsyncGenerator<{ readonly timestamp: number }, void, unknown>,
) {
  const timestamps: number[] = [];
  for await (const sample of samples) timestamps.push(sample.timestamp);
  return timestamps;
}

describe("video engine media source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine.options.length = 0;
    engine.presentedHandler = null;
    engine.onPresentedFrame.mockImplementation((handler) => {
      engine.presentedHandler = handler;
    });
    engine.load.mockResolvedValue(READY_SNAPSHOT);
    analysis.open.mockResolvedValue({
      close: analysis.close,
      extractFrames: analysis.extractFrames,
      framesAtTimestamps: analysis.framesAtTimestamps,
    });
    stubExtraction(createFrames([0, 0.04, 0.08]));
  });

  it("reads metadata from the engine ready snapshot", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    expect(source.metadata).toEqual({
      audioTrackCount: 0,
      canRead: true,
      duration: 4,
      estimatedFrameCount: 100,
      estimatedFrameRate: 25,
      firstTimestamp: 0.04,
      formatMimeType: null,
      formatName: "video-engine",
      mimeType: null,
      primaryVideoHeight: 1080,
      primaryVideoWidth: 1920,
      trackCount: 1,
      videoTrackCount: 1,
    });
    expect(source.engine).toBeDefined();
  });

  it("opens a blob source through the engine and the analysis entry", async () => {
    const blobSource: BlobVideoSource = {
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      kind: SourceKind.Blob,
    };

    const source = await openWebVideoEngineMediaSource({ source: blobSource });
    await source.sampleSink.getSample(0);

    expect(engine.options[0]).toMatchObject({ source: blobSource });
    expect(analysis.open).toHaveBeenCalledWith({
      decodeStrategy: undefined,
      source: blobSource,
    });
    expect(source.metadata.mimeType).toBeNull();
  });

  it("refuses a one-shot stream before anything reads it", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const source = {
      kind: SourceKind.Stream,
      mimeType: "video/webm",
      stream,
    } as unknown as WebVideoEngineMediaSourceOptions["source"];

    await expect(
      openWebVideoEngineMediaSource({ source }),
    ).rejects.toMatchObject({
      kind: MediaErrorKind.Unreadable,
      name: "MediaSourceError",
    });

    expect(engine.options).toHaveLength(0);
    expect(engine.load).not.toHaveBeenCalled();
    expect(analysis.open).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("leaves the frame rate unknown when the engine reports none", async () => {
    engine.load.mockResolvedValue({ ...READY_SNAPSHOT, nativeFps: null });

    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    expect(source.metadata.estimatedFrameRate).toBeNull();
    expect(source.metadata.estimatedFrameCount).toBeNull();
  });

  it("opens the analysis entry only once the first frame is pulled", async () => {
    const source = await openWebVideoEngineMediaSource({
      frameDecodeStrategy: { kind: "capped", maxWidth: 320 },
      source: urlSource,
    });
    expect(analysis.open).not.toHaveBeenCalled();

    await source.sampleSink.getSample(0);
    await source.sampleSink.getSample(0.05);

    expect(analysis.open).toHaveBeenCalledTimes(1);
    expect(analysis.open).toHaveBeenCalledWith({
      decodeStrategy: { kind: "capped", maxWidth: 320 },
      source: urlSource,
    });
  });

  it("grabs a single frame at the requested timestamp", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const sample = await source.sampleSink.getSample(0.05);

    expect(analysis.extractFrames).toHaveBeenCalledWith([0.05]);
    expect(sample?.timestamp).toBe(0.04);
    expect(sample?.duration).toBeCloseTo(0.04);

    const context = {
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    sample?.draw(context, 1, 2, 30, 40);
    expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ timestampS: 0.04 }),
      1,
      2,
      30,
      40,
    );
  });

  it("grabs a set of timestamps in one extraction", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const timestamps = [];
    for await (const sample of source.sampleSink.samplesAtTimestamps!([
      0.01, 0.05, 0.09,
    ])) {
      timestamps.push(sample?.timestamp ?? null);
    }

    expect(analysis.framesAtTimestamps).toHaveBeenCalledTimes(1);
    expect(analysis.framesAtTimestamps).toHaveBeenCalledWith([
      0.01, 0.05, 0.09,
    ]);
    expect(analysis.extractFrames).not.toHaveBeenCalled();
    expect(timestamps).toEqual([0, 0.04, 0.08]);
  });

  it("keeps a gap on the timestamp it belongs to", async () => {
    stubExtraction(createFrames([0.04]));
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const timestamps = [];
    for await (const sample of source.sampleSink.samplesAtTimestamps!([
      0.01, 0.05,
    ])) {
      timestamps.push(sample?.timestamp ?? null);
    }

    expect(timestamps).toEqual([null, 0.04]);
  });

  it("refuses to draw a closed sample", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });
    const sample = await source.sampleSink.getSample(0);

    sample?.close();

    expect(() =>
      sample?.draw({} as CanvasRenderingContext2D, 0, 0),
    ).toThrowError(/closed/);
  });

  it("walks one frame at a time and stops at the end of the track", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const timestamps = await collectTimestamps(source.sampleSink.samples(0));

    expect(timestamps).toEqual([0, 0.04, 0.08]);
  });

  it("stops walking at the requested end timestamp", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const timestamps = await collectTimestamps(
      source.sampleSink.samples(0, 0.05),
    );

    expect(timestamps).toEqual([0, 0.04]);
  });

  it("yields nothing when no frame covers the requested start", async () => {
    stubExtraction(createFrames([5]));
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const timestamps = await collectTimestamps(source.sampleSink.samples(0));

    expect(timestamps).toEqual([]);
  });

  it("disposes the engine and the opened analysis entry", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });
    await source.sampleSink.getSample(0);

    source.input.dispose();

    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(analysis.close).toHaveBeenCalledTimes(1));
  });

  it("disposes the engine when loading the source fails", async () => {
    engine.load.mockRejectedValue(new Error("source unreadable"));

    await expect(
      openWebVideoEngineMediaSource({ source: urlSource }),
    ).rejects.toThrowError("source unreadable");
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains only the newest seed until the renderer subscribes", async () => {
    let finishLoad!: (snapshot: ReadySnapshot) => void;
    engine.load.mockReturnValue(
      new Promise<ReadySnapshot>((resolve) => {
        finishLoad = resolve;
      }),
    );
    const opening = openWebVideoEngineMediaSource({ source: urlSource });
    await vi.waitFor(() => expect(engine.presentedHandler).not.toBeNull());
    const replaced = presentedFrame(0);
    const retained = presentedFrame(0.04);
    engine.presentedHandler!(replaced);
    engine.presentedHandler!(retained);
    expect(replaced.frame.close).toHaveBeenCalledOnce();

    finishLoad(READY_SNAPSHOT);
    const source = await opening;
    const accepted = vi.fn((presented: PresentedVideoFrame) =>
      presented.frame.close(),
    );
    source.engine.onPresentedFrame(accepted);

    expect(accepted).toHaveBeenCalledExactlyOnceWith(retained);
    expect(retained.frame.close).toHaveBeenCalledOnce();
  });

  it("closes an unclaimed retained seed when the source is disposed", async () => {
    const source = await openWebVideoEngineMediaSource({ source: urlSource });
    const retained = presentedFrame(0);
    engine.presentedHandler!(retained);

    source.input.dispose();

    expect(retained.frame.close).toHaveBeenCalledOnce();
  });

  it("forwards an injected worker factory into the engine", async () => {
    const workerFactory = vi.fn(() => ({}) as Worker);

    await openWebVideoEngineMediaSource({ source: urlSource, workerFactory });

    expect(engine.options.at(-1)).toMatchObject({
      presentation: "frames",
      source: urlSource,
      workerFactory,
    });
  });

  it("classifies a worker blocked by browser policy as unsupported", async () => {
    const blocked = new DOMException("worker blocked", "SecurityError");
    engine.load.mockRejectedValue(blocked);

    await expect(
      openWebVideoEngineMediaSource({ source: urlSource }),
    ).rejects.toMatchObject({
      cause: blocked,
      kind: MediaErrorKind.EnvironmentUnsupported,
      name: "MediaSourceError",
    });
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it("wraps failures raised while a timestamp batch is being iterated", async () => {
    const failure = new Error("decoder failed during batch iteration");
    analysis.framesAtTimestamps.mockImplementation(() => ({
      async next() {
        throw failure;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    }));
    const source = await openWebVideoEngineMediaSource({ source: urlSource });

    const consume = async () => {
      for await (const _sample of source.sampleSink.samplesAtTimestamps!([0])) {
        // The iterator fails before producing a sample.
      }
    };

    await expect(consume()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MediaSourceError &&
        error.kind === MediaErrorKind.Decode &&
        error.cause === failure,
    );
  });

  it("opens the same source through the renderer source contract", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      source: urlSource,
    });

    const source = await rendererSource.open();

    expect(source.metadata.primaryVideoWidth).toBe(1920);
    expect(engine.options).toEqual([
      { presentation: "frames", previewWidth: 320, source: urlSource },
    ]);
  });

  it("leaves the decode resolution to the engine when no display box is given", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { decodeStrategy?: unknown };
    expect(lastOptions.decodeStrategy).toBeUndefined();
  });

  it("decodes to the display box the caller composites into", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      display: {
        boxWidth: 1080,
        boxHeight: 854,
        devicePixelRatio: 2,
        maxDevicePixelRatio: 2,
      },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { decodeStrategy?: unknown };
    expect(lastOptions.decodeStrategy).toEqual({
      kind: "displayBox",
      boxWidth: 1080,
      boxHeight: 854,
      devicePixelRatio: 2,
      maxDevicePixelRatio: 2,
    });
  });

  it("lets an explicit decode strategy win over the display box", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      decodeStrategy: { kind: "native" },
      display: { boxWidth: 1080, boxHeight: 854, devicePixelRatio: 2 },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { decodeStrategy?: unknown };
    expect(lastOptions.decodeStrategy).toEqual({ kind: "native" });
  });

  it("holds scrub previews to one width across every box big enough for them", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      display: {
        boxWidth: 1080,
        boxHeight: 854,
        devicePixelRatio: 2,
        maxDevicePixelRatio: 2,
      },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { previewWidth?: number };
    expect(lastOptions.previewWidth).toBe(320);
  });

  it("keeps a scrub preview no wider than the device pixels of a small box", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      display: {
        boxWidth: 180,
        boxHeight: 320,
        devicePixelRatio: 2,
        maxDevicePixelRatio: 1.5,
      },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { previewWidth?: number };
    expect(lastOptions.previewWidth).toBe(270);
  });

  it("caps an unstated pixel-ratio ceiling the way the decode strategy does", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      display: { boxWidth: 100, boxHeight: 200, devicePixelRatio: 3 },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { previewWidth?: number };
    expect(lastOptions.previewWidth).toBe(200);
  });

  it("lets the caller size scrub previews themselves", async () => {
    const rendererSource = createWebVideoEngineMediaRendererSource({
      previewWidth: 480,
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { previewWidth?: number };
    expect(lastOptions.previewWidth).toBe(480);
  });
});
