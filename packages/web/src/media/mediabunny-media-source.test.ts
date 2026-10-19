import { describe, expect, it, vi } from "vitest";

import { openMediabunnyMediaSource } from "./mediabunny-media-source";

const mediabunny = vi.hoisted(() => {
  const getTimeResolution = vi.fn(async () => 10_000_000);
  const track = {
    computePacketStats: vi.fn(async () => ({ averagePacketRate: 24 })),
    getDisplayHeight: vi.fn(async () => 720),
    getDisplayWidth: vi.fn(async () => 1280),
    getFirstTimestamp: vi.fn(async () => -0.08),
    getTimeResolution,
  };

  return {
    dispose: vi.fn(),
    getTimeResolution,
    track,
    videoSampleSink: {},
  };
});

vi.mock("mediabunny", () => {
  class Input {
    canRead = vi.fn(async () => true);
    dispose = mediabunny.dispose;
    getAudioTracks = vi.fn(async () => []);
    getDurationFromMetadata = vi.fn(async () => 2);
    getFormat = vi.fn(async () => ({ mimeType: "video/mp4", name: "MP4" }));
    getMimeType = vi.fn(async () => "video/mp4");
    getPrimaryVideoTrack = vi.fn(async () => mediabunny.track);
    getTracks = vi.fn(async () => [mediabunny.track]);
    getVideoTracks = vi.fn(async () => [mediabunny.track]);
  }

  class UrlSource {}

  class VideoSampleSink {
    constructor(track: unknown) {
      expect(track).toBe(mediabunny.track);
      return mediabunny.videoSampleSink;
    }
  }

  return {
    Input,
    MATROSKA: {},
    MP4: {},
    QTFF: {},
    UrlSource,
    VideoSampleSink,
    WEBM: {},
  };
});

describe("openMediabunnyMediaSource", () => {
  it("preserves the track time resolution through presentation normalization", async () => {
    const source = await openMediabunnyMediaSource("sample.mp4");

    expect(mediabunny.getTimeResolution).toHaveBeenCalledOnce();
    expect(source.metadata).toEqual(
      expect.objectContaining({
        firstTimestamp: 0,
        timeResolution: 10_000_000,
      }),
    );
    expect(source.sampleSink).not.toBe(mediabunny.videoSampleSink);
  });
});
