import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MediaProbeIssueCode,
  MediaProbeStatus,
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  normalizeMedia,
  normalizeMediaProgressively,
  probeMedia,
} from "#media/media-normalization";

const mockState = vi.hoisted(() => {
  const normalizationMock = {
    blobSourceConstructor: vi.fn(),
    bufferTargetConstructor: vi.fn(),
    canEncodeVideo: vi.fn(),
    conversionInit: vi.fn(),
    conversionInstance: undefined as
      | {
          discardedTracks: Array<{
            reason: string;
            track: { type: string };
          }>;
          cancel: ReturnType<typeof vi.fn>;
          execute: ReturnType<typeof vi.fn>;
          isValid: boolean;
          onProgress?: (progress: number, processedTime: number) => unknown;
        }
      | undefined,
    conversionOptions: [] as unknown[],
    inputConstructor: vi.fn(),
    inputCanRead: vi.fn(async () => true),
    inputDispose: vi.fn(),
    inputFormat: { mimeType: "video/mp4", name: "MP4" },
    inputGetAudioTracks: vi.fn(async () => [{ type: "audio" }]),
    inputGetDurationFromMetadata: vi.fn(
      async (): Promise<number | null> => 1.25,
    ),
    inputGetTracks: vi.fn(async () => [{ type: "video" }, { type: "audio" }]),
    inputGetVideoTracks: vi.fn(async () => [{ type: "video" }]),
    inputMimeType: 'video/mp4; codecs="avc1.42e01e"',
    appendOnlyStreamTargetConstructor: vi.fn(),
    outputConstructor: vi.fn(),
    outputFormatInstances: [] as string[],
    outputFormatOptions: [] as unknown[],
    outputTargets: [] as Array<{ buffer: ArrayBuffer | null }>,
    readableStreamSourceConstructor: vi.fn(),
    primaryVideoTrack: {
      canDecode: vi.fn(async () => true),
      computePacketStats: vi.fn(async () => ({ averagePacketRate: 24 })),
      getCodec: vi.fn(async () => "avc"),
      getDisplayHeight: vi.fn(async () => 720),
      getDisplayWidth: vi.fn(async () => 1280),
      getFirstTimestamp: vi.fn(async () => 0),
      type: "video",
    },
    videoSampleSinkConstructor: vi.fn(),
  };

  return { normalizationMock };
});

const normalizationMock = mockState.normalizationMock;

vi.mock("mediabunny", () => {
  class BlobSource {
    constructor(blob: Blob) {
      normalizationMock.blobSourceConstructor(blob);
    }
  }

  class BufferTarget {
    buffer: ArrayBuffer | null = new Uint8Array([1, 2, 3, 4]).buffer;

    constructor() {
      normalizationMock.bufferTargetConstructor();
      normalizationMock.outputTargets.push(this);
    }
  }

  class AppendOnlyStreamTarget {
    constructor(writable: WritableStream<Uint8Array>) {
      normalizationMock.appendOnlyStreamTargetConstructor(writable);
    }
  }

  class Input {
    constructor(options: unknown) {
      normalizationMock.inputConstructor(options);
    }

    dispose = normalizationMock.inputDispose;

    getAudioTracks = normalizationMock.inputGetAudioTracks;

    getDurationFromMetadata = normalizationMock.inputGetDurationFromMetadata;

    getTracks = normalizationMock.inputGetTracks;

    getVideoTracks = normalizationMock.inputGetVideoTracks;

    canRead = normalizationMock.inputCanRead;

    getFormat = vi.fn(async () => normalizationMock.inputFormat);

    getMimeType = vi.fn(async () => normalizationMock.inputMimeType);

    getPrimaryVideoTrack = vi.fn(
      async () => normalizationMock.primaryVideoTrack,
    );
  }

  class Mp4OutputFormat {
    constructor() {
      normalizationMock.outputFormatInstances.push("mp4");
    }
  }

  class Output {
    constructor(options: unknown) {
      normalizationMock.outputConstructor(options);
    }
  }

  class WebMOutputFormat {
    constructor(options?: unknown) {
      normalizationMock.outputFormatInstances.push("webm");
      normalizationMock.outputFormatOptions.push(options);
    }
  }

  class ReadableStreamSource {
    constructor(stream: ReadableStream<Uint8Array>, options?: unknown) {
      normalizationMock.readableStreamSourceConstructor(stream, options);
    }
  }

  class UrlSource {
    constructor() {
      // URL sources are not used by these tests.
    }
  }

  class VideoSampleSink {
    constructor(track: unknown) {
      normalizationMock.videoSampleSinkConstructor(track);
    }
  }

  class Conversion {
    static async init(options: unknown) {
      normalizationMock.conversionInit(options);
      normalizationMock.conversionOptions.push(options);

      const conversion = normalizationMock.conversionInstance ?? {
        cancel: vi.fn(async () => undefined),
        discardedTracks: [],
        execute: vi.fn(async () => undefined),
        isValid: true,
      };

      normalizationMock.conversionInstance = conversion;

      return conversion;
    }
  }

  return {
    ALL_FORMATS: [{ name: "mock-format" }],
    AppendOnlyStreamTarget,
    BlobSource,
    BufferTarget,
    canEncodeVideo: normalizationMock.canEncodeVideo,
    Conversion,
    Input,
    MATROSKA: { name: "Matroska" },
    MP4: { name: "MP4" },
    Mp4OutputFormat,
    Output,
    QTFF: { name: "QuickTime" },
    ReadableStreamSource,
    UrlSource,
    VideoSampleSink,
    WEBM: { name: "WebM" },
    WebMOutputFormat,
  };
});

describe("normalizeMedia", () => {
  beforeEach(() => {
    normalizationMock.blobSourceConstructor.mockClear();
    normalizationMock.appendOnlyStreamTargetConstructor.mockClear();
    normalizationMock.bufferTargetConstructor.mockClear();
    normalizationMock.canEncodeVideo.mockClear();
    normalizationMock.canEncodeVideo.mockImplementation(
      async (codec: string) => codec === "vp9",
    );
    normalizationMock.conversionInit.mockClear();
    normalizationMock.conversionInstance = undefined;
    normalizationMock.conversionOptions.length = 0;
    normalizationMock.inputConstructor.mockClear();
    normalizationMock.inputCanRead.mockClear();
    normalizationMock.inputCanRead.mockResolvedValue(true);
    normalizationMock.inputDispose.mockClear();
    normalizationMock.inputFormat = { mimeType: "video/mp4", name: "MP4" };
    normalizationMock.inputGetAudioTracks.mockClear();
    normalizationMock.inputGetAudioTracks.mockResolvedValue([
      { type: "audio" },
    ]);
    normalizationMock.inputGetDurationFromMetadata.mockClear();
    normalizationMock.inputGetDurationFromMetadata.mockResolvedValue(1.25);
    normalizationMock.inputGetTracks.mockClear();
    normalizationMock.inputGetTracks.mockResolvedValue([
      { type: "video" },
      { type: "audio" },
    ]);
    normalizationMock.inputGetVideoTracks.mockClear();
    normalizationMock.inputGetVideoTracks.mockResolvedValue([
      { type: "video" },
    ]);
    normalizationMock.inputMimeType = 'video/mp4; codecs="avc1.42e01e"';
    normalizationMock.outputConstructor.mockClear();
    normalizationMock.outputFormatInstances.length = 0;
    normalizationMock.outputFormatOptions.length = 0;
    normalizationMock.outputTargets.length = 0;
    normalizationMock.readableStreamSourceConstructor.mockClear();
    normalizationMock.primaryVideoTrack.canDecode.mockClear();
    normalizationMock.primaryVideoTrack.canDecode.mockResolvedValue(true);
    normalizationMock.primaryVideoTrack.computePacketStats.mockClear();
    normalizationMock.primaryVideoTrack.computePacketStats.mockResolvedValue({
      averagePacketRate: 24,
    });
    normalizationMock.primaryVideoTrack.getCodec.mockClear();
    normalizationMock.primaryVideoTrack.getCodec.mockResolvedValue("avc");
    normalizationMock.primaryVideoTrack.getDisplayHeight.mockClear();
    normalizationMock.primaryVideoTrack.getDisplayHeight.mockResolvedValue(720);
    normalizationMock.primaryVideoTrack.getDisplayWidth.mockClear();
    normalizationMock.primaryVideoTrack.getDisplayWidth.mockResolvedValue(1280);
    normalizationMock.primaryVideoTrack.getFirstTimestamp.mockClear();
    normalizationMock.primaryVideoTrack.getFirstTimestamp.mockResolvedValue(0);
    normalizationMock.videoSampleSinkConstructor.mockClear();
  });

  it("probes media and selects the first encodable normalization target", async () => {
    normalizationMock.canEncodeVideo.mockImplementation(
      async (codec: string) => codec === "vp8",
    );

    const probe = await probeMedia(new Blob(["source"], { type: "video/mp4" }));

    expect(probe).toMatchObject({
      canRead: true,
      inputMetadata: {
        detectedMimeType: 'video/mp4; codecs="avc1.42e01e"',
        duration: 1.25,
        formatMimeType: "video/mp4",
        formatName: "MP4",
        primaryVideoHeight: 720,
        primaryVideoWidth: 1280,
        sourceMimeType: "video/mp4",
      },
      issues: [],
      primaryVideo: {
        canDecode: true,
        codec: "avc",
        height: 720,
        width: 1280,
      },
      status: MediaProbeStatus.Supported,
      target: {
        container: MediaNormalizationContainer.WebM,
        frameRate: 30,
        videoCodec: MediaNormalizationVideoCodec.Vp8,
      },
    });
    expect(normalizationMock.inputCanRead).toHaveBeenCalledOnce();
    expect(
      normalizationMock.primaryVideoTrack.canDecode,
    ).toHaveBeenCalledOnce();
    expect(normalizationMock.canEncodeVideo).toHaveBeenCalledTimes(2);
    expect(normalizationMock.canEncodeVideo).toHaveBeenNthCalledWith(1, "vp9", {
      height: 720,
      width: 1280,
    });
    expect(normalizationMock.canEncodeVideo).toHaveBeenNthCalledWith(2, "vp8", {
      height: 720,
      width: 1280,
    });
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("reports unsupported media when the primary video cannot decode", async () => {
    normalizationMock.primaryVideoTrack.canDecode.mockResolvedValue(false);

    const probe = await probeMedia(
      new Blob(["source"], { type: "video/x-ms-wmv" }),
    );

    expect(probe.status).toBe(MediaProbeStatus.Unsupported);
    expect(probe.target).toBeNull();
    expect(probe.primaryVideo).toMatchObject({
      canDecode: false,
      codec: "avc",
      height: 720,
      width: 1280,
    });
    expect(probe.issues).toEqual([
      {
        code: MediaProbeIssueCode.PrimaryVideoCannotDecode,
        message: "Primary video track cannot be decoded by this browser.",
      },
    ]);
    expect(normalizationMock.canEncodeVideo).not.toHaveBeenCalled();
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("reports unsupported media when no target profile can encode", async () => {
    normalizationMock.canEncodeVideo.mockResolvedValue(false);

    const probe = await probeMedia(new Blob(["source"], { type: "video/mp4" }));

    expect(probe.status).toBe(MediaProbeStatus.Unsupported);
    expect(probe.target).toBeNull();
    expect(probe.issues).toEqual([
      {
        code: MediaProbeIssueCode.TargetVideoCannotEncode,
        message:
          "No requested normalization target can be encoded by this browser.",
      },
    ]);
    expect(normalizationMock.canEncodeVideo).toHaveBeenCalledTimes(2);
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("configures default WebM VP9 30fps video-only normalization", async () => {
    const inputBlob = new Blob(["source"], { type: "video/mp4" });

    const normalized = await normalizeMedia(inputBlob);

    expect(normalizationMock.blobSourceConstructor).toHaveBeenCalledWith(
      inputBlob,
    );
    expect(normalizationMock.inputConstructor).toHaveBeenCalledWith({
      formats: [{ name: "mock-format" }],
      source: expect.any(Object),
    });
    expect(normalizationMock.outputFormatInstances).toEqual(["webm"]);
    expect(normalizationMock.conversionInit).toHaveBeenCalledWith({
      audio: { discard: true },
      input: expect.any(Object),
      output: expect.any(Object),
      showWarnings: false,
      tracks: "primary",
      video: {
        codec: "vp9",
        forceTranscode: true,
        frameRate: 30,
        keyFrameInterval: 1,
      },
    });
    expect(normalized).toMatchObject({
      container: MediaNormalizationContainer.WebM,
      extension: "webm",
      inputMetadata: {
        detectedMimeType: 'video/mp4; codecs="avc1.42e01e"',
        duration: 1.25,
        formatMimeType: "video/mp4",
        formatName: "MP4",
        primaryVideoHeight: 720,
        primaryVideoWidth: 1280,
        sourceMimeType: "video/mp4",
      },
      mimeType: "video/webm",
      size: 4,
    });
    expect(normalized.blob.type).toBe("video/webm");
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
    expect(
      normalizationMock.conversionInstance?.execute,
    ).toHaveBeenCalledOnce();
  });

  it("configures progressive WebM normalization as append-only", async () => {
    const inputBlob = new Blob(["source"], { type: "video/mp4" });

    const normalized = await normalizeMediaProgressively(inputBlob);

    expect(
      normalizationMock.appendOnlyStreamTargetConstructor,
    ).toHaveBeenCalledOnce();
    expect(normalizationMock.outputFormatInstances).toEqual(["webm"]);
    expect(normalizationMock.outputFormatOptions).toEqual([
      { appendOnly: true },
    ]);
    expect(normalizationMock.conversionInit).toHaveBeenCalledWith({
      audio: { discard: true },
      input: expect.any(Object),
      output: expect.any(Object),
      showWarnings: false,
      tracks: "primary",
      video: {
        codec: "vp9",
        forceTranscode: true,
        frameRate: 30,
        keyFrameInterval: 1,
      },
    });
    expect(
      normalizationMock.readableStreamSourceConstructor,
    ).toHaveBeenCalledWith(expect.any(ReadableStream), {
      maxCacheSize: 512 * 2 ** 20,
    });
    await expect(normalized.completion).resolves.toMatchObject({
      container: MediaNormalizationContainer.WebM,
      extension: "webm",
      mimeType: "video/webm",
      size: 0,
    });
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("carries source duration into progressive renderer sources for live playback loops", async () => {
    const normalized = await normalizeMediaProgressively(
      new Blob(["source"], { type: "video/mp4" }),
    );

    normalizationMock.inputGetDurationFromMetadata.mockResolvedValueOnce(null);

    const source = await normalized.rendererSource.open();

    expect(source.metadata.duration).toBe(1.25);
    expect(source.metadata.estimatedFrameCount).toBe(30);
    expect(source.metadata.estimatedFrameRate).toBe(24);
    expect(
      normalizationMock.primaryVideoTrack.computePacketStats,
    ).toHaveBeenCalledWith(120, { skipLiveWait: true });
    expect(normalizationMock.videoSampleSinkConstructor).toHaveBeenCalledWith(
      normalizationMock.primaryVideoTrack,
    );

    source.input.dispose();
  });

  it("rejects already-aborted signals before conversion starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      normalizeMedia(new Blob(["source"]), { signal: controller.signal }),
    ).rejects.toThrow("Media normalization was aborted.");

    expect(normalizationMock.blobSourceConstructor).not.toHaveBeenCalled();
    expect(normalizationMock.conversionInit).not.toHaveBeenCalled();
    expect(normalizationMock.inputDispose).not.toHaveBeenCalled();
  });

  it("cancels in-flight conversion when the signal aborts", async () => {
    const controller = new AbortController();
    let rejectExecute!: (error: Error) => void;
    const conversionCanceledError = new Error("Conversion has been canceled.");
    conversionCanceledError.name = "ConversionCanceledError";
    normalizationMock.conversionInstance = {
      cancel: vi.fn(async () => {
        rejectExecute(conversionCanceledError);
      }),
      discardedTracks: [],
      execute: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectExecute = reject;
          }),
      ),
      isValid: true,
    };
    const normalizedPromise = normalizeMedia(new Blob(["source"]), {
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(
        normalizationMock.conversionInstance?.execute,
      ).toHaveBeenCalledOnce();
    });

    controller.abort();

    await expect(normalizedPromise).rejects.toThrow(
      "Media normalization was aborted.",
    );
    expect(normalizationMock.conversionInstance.cancel).toHaveBeenCalledOnce();
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("forwards conversion progress events", async () => {
    const onProgress = vi.fn();
    let finishExecute!: () => void;
    normalizationMock.conversionInstance = {
      cancel: vi.fn(async () => undefined),
      discardedTracks: [],
      execute: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishExecute = resolve;
          }),
      ),
      isValid: true,
    };
    const normalizedPromise = normalizeMedia(new Blob(["source"]), {
      onProgress,
    });

    await vi.waitFor(() => {
      expect(normalizationMock.conversionInstance?.onProgress).toEqual(
        expect.any(Function),
      );
    });

    normalizationMock.conversionInstance.onProgress?.(0.5, 2.25);
    finishExecute();
    await normalizedPromise;

    expect(onProgress).toHaveBeenCalledWith({
      processedTime: 2.25,
      progress: 0.5,
    });
  });

  it("uses MP4 output and AVC defaults when requested", async () => {
    const normalized = await normalizeMedia(new Blob(["source"]), {
      container: MediaNormalizationContainer.Mp4,
    });

    expect(normalizationMock.outputFormatInstances).toEqual(["mp4"]);
    expect(normalizationMock.conversionInit).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          codec: "avc",
          frameRate: 30,
        }),
      }),
    );
    expect(normalized).toMatchObject({
      container: MediaNormalizationContainer.Mp4,
      extension: "mp4",
      mimeType: "video/mp4",
    });
    expect(normalized.blob.type).toBe("video/mp4");
  });

  it("throws a helpful error when Mediabunny marks conversion invalid", async () => {
    normalizationMock.conversionInstance = {
      cancel: vi.fn(async () => undefined),
      discardedTracks: [
        {
          reason: "no_encodable_target_codec",
          track: { type: "video" },
        },
      ],
      execute: vi.fn(async () => undefined),
      isValid: false,
    };

    await expect(normalizeMedia(new Blob(["source"]))).rejects.toThrow(
      "Mediabunny conversion is invalid: discarded tracks: video (no_encodable_target_codec).",
    );
    expect(normalizationMock.conversionInstance.execute).not.toHaveBeenCalled();
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("disposes input when execution fails", async () => {
    normalizationMock.conversionInstance = {
      cancel: vi.fn(async () => undefined),
      discardedTracks: [],
      execute: vi.fn(async () => {
        throw new Error("encode failed");
      }),
      isValid: true,
    };

    await expect(normalizeMedia(new Blob(["source"]))).rejects.toThrow(
      "encode failed",
    );
    expect(normalizationMock.inputDispose).toHaveBeenCalledOnce();
  });

  it("allows callers to override video options", async () => {
    await normalizeMedia(new Blob(["source"]), {
      video: {
        bitrate: 1_000_000,
        codec: MediaNormalizationVideoCodec.Vp8,
        forceTranscode: false,
        frameRate: 24,
        height: 720,
        keyFrameInterval: 2,
        width: 1280,
      },
    });

    expect(normalizationMock.conversionInit).toHaveBeenCalledWith(
      expect.objectContaining({
        video: {
          bitrate: 1_000_000,
          codec: "vp8",
          forceTranscode: false,
          frameRate: 24,
          height: 720,
          keyFrameInterval: 2,
          width: 1280,
        },
      }),
    );
  });
});
