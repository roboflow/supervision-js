import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  normalizeMedia,
} from "#media/media-normalization";

const mockState = vi.hoisted(() => {
  const normalizationMock = {
    blobSourceConstructor: vi.fn(),
    bufferTargetConstructor: vi.fn(),
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
    inputDispose: vi.fn(),
    inputFormat: { mimeType: "video/mp4", name: "MP4" },
    inputMimeType: 'video/mp4; codecs="avc1.42e01e"',
    outputConstructor: vi.fn(),
    outputFormatInstances: [] as string[],
    outputTargets: [] as Array<{ buffer: ArrayBuffer | null }>,
    primaryVideoTrack: {
      getDisplayHeight: vi.fn(async () => 720),
      getDisplayWidth: vi.fn(async () => 1280),
      type: "video",
    },
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

  class Input {
    constructor(options: unknown) {
      normalizationMock.inputConstructor(options);
    }

    dispose = normalizationMock.inputDispose;

    getDurationFromMetadata = vi.fn(async () => 1.25);

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
    constructor() {
      normalizationMock.outputFormatInstances.push("webm");
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
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
  };
});

describe("normalizeMedia", () => {
  beforeEach(() => {
    normalizationMock.blobSourceConstructor.mockClear();
    normalizationMock.bufferTargetConstructor.mockClear();
    normalizationMock.conversionInit.mockClear();
    normalizationMock.conversionInstance = undefined;
    normalizationMock.conversionOptions.length = 0;
    normalizationMock.inputConstructor.mockClear();
    normalizationMock.inputDispose.mockClear();
    normalizationMock.inputFormat = { mimeType: "video/mp4", name: "MP4" };
    normalizationMock.inputMimeType = 'video/mp4; codecs="avc1.42e01e"';
    normalizationMock.outputConstructor.mockClear();
    normalizationMock.outputFormatInstances.length = 0;
    normalizationMock.outputTargets.length = 0;
    normalizationMock.primaryVideoTrack.getDisplayHeight.mockClear();
    normalizationMock.primaryVideoTrack.getDisplayHeight.mockResolvedValue(720);
    normalizationMock.primaryVideoTrack.getDisplayWidth.mockClear();
    normalizationMock.primaryVideoTrack.getDisplayWidth.mockResolvedValue(1280);
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
