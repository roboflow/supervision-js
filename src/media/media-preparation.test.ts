import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareMedia,
  prepareMediaProgressively,
  MediaPreparationError,
} from "#media/media-preparation";
import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  MediaProbeIssueCode,
  MediaProbeStatus,
} from "#types/media-normalization";

const mediaPreparationMock = vi.hoisted(() => ({
  normalizeMedia: vi.fn(),
  normalizeMediaProgressively: vi.fn(),
  probeMedia: vi.fn(),
}));

vi.mock("#media/media-normalization", () => ({
  normalizeMedia: mediaPreparationMock.normalizeMedia,
  normalizeMediaProgressively: mediaPreparationMock.normalizeMediaProgressively,
}));

vi.mock("#media/media-probe", () => ({
  probeMedia: mediaPreparationMock.probeMedia,
}));

describe("prepareMedia", () => {
  beforeEach(() => {
    mediaPreparationMock.normalizeMedia.mockReset();
    mediaPreparationMock.normalizeMediaProgressively.mockReset();
    mediaPreparationMock.probeMedia.mockReset();
  });

  it("probes media and normalizes with the selected target profile", async () => {
    const source = new Blob(["source"], { type: "video/mp4" });
    const normalizedMedia = {
      blob: new Blob(["normalized"], { type: "video/webm" }),
      container: MediaNormalizationContainer.WebM,
      extension: "webm",
      inputMetadata: createInputMetadata(),
      mimeType: "video/webm",
      size: 10,
    };
    const probe = {
      canRead: true,
      inputMetadata: createInputMetadata(),
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
        height: 720,
        videoCodec: MediaNormalizationVideoCodec.Vp8,
        width: 1280,
      },
    };
    mediaPreparationMock.probeMedia.mockResolvedValue(probe);
    mediaPreparationMock.normalizeMedia.mockResolvedValue(normalizedMedia);

    const prepared = await prepareMedia(source, {
      normalization: {
        audio: { discard: true },
        video: { keyFrameInterval: 2 },
      },
    });

    expect(mediaPreparationMock.probeMedia).toHaveBeenCalledWith(
      source,
      undefined,
    );
    expect(mediaPreparationMock.normalizeMedia).toHaveBeenCalledWith(source, {
      audio: { discard: true },
      container: MediaNormalizationContainer.WebM,
      video: {
        codec: MediaNormalizationVideoCodec.Vp8,
        forceTranscode: true,
        frameRate: 30,
        height: 720,
        keyFrameInterval: 2,
        width: 1280,
      },
    });
    expect(prepared).toEqual({
      normalizedMedia,
      probe,
    });
  });

  it("throws with probe details when media cannot be prepared", async () => {
    const source = new Blob(["source"], { type: "video/x-ms-wmv" });
    const probe = {
      canRead: true,
      inputMetadata: createInputMetadata(),
      issues: [
        {
          code: MediaProbeIssueCode.TargetVideoCannotEncode,
          message: "No requested normalization target can be encoded.",
        },
      ],
      primaryVideo: {
        canDecode: true,
        codec: "wmv",
        height: 720,
        width: 1280,
      },
      status: MediaProbeStatus.Unsupported,
      target: null,
    };
    mediaPreparationMock.probeMedia.mockResolvedValue(probe);

    await expect(prepareMedia(source)).rejects.toMatchObject({
      name: "MediaPreparationError",
      probe,
    });
    await expect(prepareMedia(source)).rejects.toBeInstanceOf(
      MediaPreparationError,
    );
    expect(mediaPreparationMock.normalizeMedia).not.toHaveBeenCalled();
  });

  it("probes media and progressively normalizes with the selected target profile", async () => {
    const source = new Blob(["source"], { type: "video/mp4" });
    const progressiveMedia = {
      cancel: vi.fn(async () => undefined),
      completion: Promise.resolve({
        blob: new Blob(["normalized"], { type: "video/webm" }),
        container: MediaNormalizationContainer.WebM,
        extension: "webm",
        inputMetadata: createInputMetadata(),
        mimeType: "video/webm",
        size: 10,
      }),
      container: MediaNormalizationContainer.WebM,
      extension: "webm",
      inputMetadata: createInputMetadata(),
      mimeType: "video/webm",
      rendererSource: { open: vi.fn() },
    };
    const probe = {
      canRead: true,
      inputMetadata: createInputMetadata(),
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
        height: 720,
        videoCodec: MediaNormalizationVideoCodec.Vp8,
        width: 1280,
      },
    };

    mediaPreparationMock.probeMedia.mockResolvedValue(probe);
    mediaPreparationMock.normalizeMediaProgressively.mockResolvedValue(
      progressiveMedia,
    );

    const prepared = await prepareMediaProgressively(source, {
      normalization: {
        audio: { discard: true },
        video: { keyFrameInterval: 2 },
      },
    });

    expect(mediaPreparationMock.probeMedia).toHaveBeenCalledWith(
      source,
      undefined,
    );
    expect(
      mediaPreparationMock.normalizeMediaProgressively,
    ).toHaveBeenCalledWith(source, {
      audio: { discard: true },
      container: MediaNormalizationContainer.WebM,
      video: {
        codec: MediaNormalizationVideoCodec.Vp8,
        forceTranscode: true,
        frameRate: 30,
        height: 720,
        keyFrameInterval: 2,
        width: 1280,
      },
    });
    expect(prepared).toEqual({
      normalizedMedia: progressiveMedia,
      probe,
    });
  });
});

function createInputMetadata() {
  return {
    detectedMimeType: "video/mp4",
    duration: 1,
    formatMimeType: "video/mp4",
    formatName: "MP4",
    primaryVideoHeight: 720,
    primaryVideoWidth: 1280,
    sourceMimeType: "video/mp4",
  };
}
