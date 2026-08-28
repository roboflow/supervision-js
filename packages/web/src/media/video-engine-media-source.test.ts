import { SourceKind } from "supervision-js-web-video-engine";
import type { UrlVideoSource } from "supervision-js-web-video-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVideoEngineMediaRendererSource,
  openVideoEngineMediaSource,
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
  options: [] as unknown[],
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
  VideoEngine: class {
    readonly dispose = engine.dispose;
    readonly load = engine.load;

    constructor(options: unknown) {
      engine.options.push(options);
    }
  },
}));

const analysisModule = vi.hoisted(() => () => ({
  AnalysisSession: { open: analysis.open },
}));

vi.mock("supervision-js-web-video-engine", engineModule);

vi.mock("supervision-js-web-video-engine/analysis", analysisModule);

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
    engine.load.mockResolvedValue(READY_SNAPSHOT);
    analysis.open.mockResolvedValue({
      close: analysis.close,
      extractFrames: analysis.extractFrames,
      framesAtTimestamps: analysis.framesAtTimestamps,
    });
    stubExtraction(createFrames([0, 0.04, 0.08]));
  });

  it("reads metadata from the engine ready snapshot", async () => {
    const source = await openVideoEngineMediaSource({ source: urlSource });

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

  it("reports the declared mime type of a stream source", async () => {
    const source = await openVideoEngineMediaSource({
      source: {
        kind: SourceKind.Stream,
        mimeType: "video/webm",
        stream: new ReadableStream<Uint8Array>(),
      },
    });

    expect(source.metadata.mimeType).toBe("video/webm");
  });

  it("leaves the frame rate unknown when the engine reports none", async () => {
    engine.load.mockResolvedValue({ ...READY_SNAPSHOT, nativeFps: null });

    const source = await openVideoEngineMediaSource({ source: urlSource });

    expect(source.metadata.estimatedFrameRate).toBeNull();
    expect(source.metadata.estimatedFrameCount).toBeNull();
  });

  it("opens the analysis entry only once the first frame is pulled", async () => {
    const source = await openVideoEngineMediaSource({
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
    const source = await openVideoEngineMediaSource({ source: urlSource });

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
    const source = await openVideoEngineMediaSource({ source: urlSource });

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
    const source = await openVideoEngineMediaSource({ source: urlSource });

    const timestamps = [];
    for await (const sample of source.sampleSink.samplesAtTimestamps!([
      0.01, 0.05,
    ])) {
      timestamps.push(sample?.timestamp ?? null);
    }

    expect(timestamps).toEqual([null, 0.04]);
  });

  it("refuses to draw a closed sample", async () => {
    const source = await openVideoEngineMediaSource({ source: urlSource });
    const sample = await source.sampleSink.getSample(0);

    sample?.close();

    expect(() =>
      sample?.draw({} as CanvasRenderingContext2D, 0, 0),
    ).toThrowError(/closed/);
  });

  it("walks one frame at a time and stops at the end of the track", async () => {
    const source = await openVideoEngineMediaSource({ source: urlSource });

    const timestamps = await collectTimestamps(source.sampleSink.samples(0));

    expect(timestamps).toEqual([0, 0.04, 0.08]);
  });

  it("stops walking at the requested end timestamp", async () => {
    const source = await openVideoEngineMediaSource({ source: urlSource });

    const timestamps = await collectTimestamps(
      source.sampleSink.samples(0, 0.05),
    );

    expect(timestamps).toEqual([0, 0.04]);
  });

  it("yields nothing when no frame covers the requested start", async () => {
    stubExtraction(createFrames([5]));
    const source = await openVideoEngineMediaSource({ source: urlSource });

    const timestamps = await collectTimestamps(source.sampleSink.samples(0));

    expect(timestamps).toEqual([]);
  });

  it("disposes the engine and the opened analysis entry", async () => {
    const source = await openVideoEngineMediaSource({ source: urlSource });
    await source.sampleSink.getSample(0);

    source.input.dispose();

    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(analysis.close).toHaveBeenCalledTimes(1));
  });

  it("disposes the engine when loading the source fails", async () => {
    engine.load.mockRejectedValue(new Error("source unreadable"));

    await expect(
      openVideoEngineMediaSource({ source: urlSource }),
    ).rejects.toThrowError("source unreadable");
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("opens the same source through the renderer source contract", async () => {
    const rendererSource = createVideoEngineMediaRendererSource({
      source: urlSource,
    });

    const source = await rendererSource.open();

    expect(source.metadata.primaryVideoWidth).toBe(1920);
    expect(engine.options).toEqual([
      { presentation: "frames", previewWidth: 320, source: urlSource },
    ]);
  });

  it("leaves the decode resolution to the engine when no display box is given", async () => {
    const rendererSource = createVideoEngineMediaRendererSource({
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { decodeStrategy?: unknown };
    expect(lastOptions.decodeStrategy).toBeUndefined();
  });

  it("decodes to the display box the caller composites into", async () => {
    const rendererSource = createVideoEngineMediaRendererSource({
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
    const rendererSource = createVideoEngineMediaRendererSource({
      decodeStrategy: { kind: "native" },
      display: { boxWidth: 1080, boxHeight: 854, devicePixelRatio: 2 },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { decodeStrategy?: unknown };
    expect(lastOptions.decodeStrategy).toEqual({ kind: "native" });
  });

  it("holds scrub previews to one width across every box big enough for them", async () => {
    const rendererSource = createVideoEngineMediaRendererSource({
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
    const rendererSource = createVideoEngineMediaRendererSource({
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
    const rendererSource = createVideoEngineMediaRendererSource({
      display: { boxWidth: 100, boxHeight: 200, devicePixelRatio: 3 },
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { previewWidth?: number };
    expect(lastOptions.previewWidth).toBe(200);
  });

  it("lets the caller size scrub previews themselves", async () => {
    const rendererSource = createVideoEngineMediaRendererSource({
      previewWidth: 480,
      source: urlSource,
    });

    await rendererSource.open();

    const lastOptions = engine.options.at(-1) as { previewWidth?: number };
    expect(lastOptions.previewWidth).toBe(480);
  });
});
