import { SourceKind } from "@roboflow/video-engine";
import type { UrlVideoSource } from "@roboflow/video-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVideoEngineMediaRendererSource,
  openVideoEngineMediaSource,
} from "./video-engine-media-source";

type ReadySnapshot = {
  readonly canDecode: boolean;
  readonly codec: string | null;
  readonly durationMs: number;
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
  open: vi.fn(),
}));

vi.mock("@roboflow/video-engine", () => ({
  SourceKind: { Blob: "blob", Stream: "stream", Url: "url" },
  VideoEngine: class {
    readonly dispose = engine.dispose;
    readonly load = engine.load;

    constructor(options: unknown) {
      engine.options.push(options);
    }
  },
}));

vi.mock("@roboflow/video-engine/analysis", () => ({
  AnalysisSession: { open: analysis.open },
}));

const READY_SNAPSHOT: ReadySnapshot = {
  canDecode: true,
  codec: "avc1.640028",
  durationMs: 4000,
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
  analysis.extractFrames.mockImplementation(
    async (timestamps: readonly number[]) =>
      timestamps
        .map((timestamp) =>
          frames.reduce<FakeFrame | null>(
            (covering, frame) =>
              frame.timestampS <= timestamp + 1e-6 ? frame : covering,
            null,
          ),
        )
        .filter((frame): frame is FakeFrame => frame !== null),
  );
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
      firstTimestamp: 0,
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
    expect(engine.options).toEqual([{ source: urlSource }]);
  });
});
