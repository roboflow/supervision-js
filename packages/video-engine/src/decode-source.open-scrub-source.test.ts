/**
 * Decode-path selection. Mocks mediabunny so the fake primary track controls the
 * codec the gates reason over, and pins the realm globals they probe, so these
 * run the real openScrubSource rather than a stubbed decision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openFrameProvider,
  openScrubSource,
  openWalkSource,
} from "./decode-source";
import { viewportResolution } from "./decode-resolution";
import { SourceKind, type VideoSource } from "./types";

const AVCC: VideoDecoderConfig = {
  codec: "avc1.640028",
  description: new Uint8Array([1, 100, 0, 40, 0xff]),
};

const VP9: VideoDecoderConfig = { codec: "vp09.00.10.08" };

let decoderConfig: VideoDecoderConfig | null = AVCC;

class FakeVideoTrack {
  displayWidth = 2840;
  displayHeight = 2840;
  canDecode(): Promise<boolean> {
    return Promise.resolve(true);
  }
  getFirstTimestamp(): Promise<number> {
    return Promise.resolve(0);
  }
  computeDuration(): Promise<number> {
    return Promise.resolve(40);
  }
  computePacketStats(): Promise<{ averagePacketRate: number }> {
    return Promise.resolve({ averagePacketRate: 15 });
  }
  getTimeResolution(): Promise<number> {
    return Promise.resolve(15);
  }
  getDecoderConfig(): Promise<VideoDecoderConfig | null> {
    return Promise.resolve(decoderConfig);
  }
}

/** Sinks built over the opened track, in construction order: the observable
 *  trace of which decode path a call chose. */
const mockSinksBuilt: string[] = [];

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  UrlSource: class {
    constructor(readonly url: string) {}
  },
  BlobSource: class {},
  ReadableStreamSource: class {},
  Input: class {
    getPrimaryVideoTrack(): Promise<FakeVideoTrack> {
      return Promise.resolve(new FakeVideoTrack());
    }
    dispose(): void {}
  },
  CanvasSink: class {
    constructor(
      readonly track: unknown,
      readonly opts: unknown,
    ) {
      mockSinksBuilt.push("CanvasSink");
    }
  },
  VideoSampleSink: class {
    constructor() {
      mockSinksBuilt.push("VideoSampleSink");
    }
  },
  EncodedPacketSink: class {
    constructor(readonly track: unknown) {
      mockSinksBuilt.push("EncodedPacketSink");
    }
    async *packets(): AsyncGenerator<
      { timestamp: number; duration: number },
      void,
      unknown
    > {
      for (let i = 0; i < 4; i++) yield { timestamp: i / 15, duration: 1 / 15 };
    }
  },
}));

const SOURCE: VideoSource = {
  kind: SourceKind.Url,
  url: "https://example.test/v.mp4",
};

/** The sampler's shape: a 2840px source previewed in a 900px box. */
const DOWNSCALED = {
  source: SOURCE,
  decodeStrategy: viewportResolution(),
  viewport: { displayWidth: 900, devicePixelRatio: 1 },
};

const realm = globalThis as {
  VideoDecoder?: unknown;
  GPUDevice?: unknown;
};
const original = {
  VideoDecoder: realm.VideoDecoder,
  GPUDevice: realm.GPUDevice,
};

function installWebgpuImport(): void {
  vi.stubGlobal("navigator", { gpu: {} });
  const ctor = function GPUDevice(): void {} as unknown as {
    prototype: { importExternalTexture: () => void };
  };
  ctor.prototype.importExternalTexture = (): void => undefined;
  realm.GPUDevice = ctor;
}

beforeEach(() => {
  mockSinksBuilt.length = 0;
  decoderConfig = AVCC;
  realm.VideoDecoder = function VideoDecoder(): void {};
  vi.stubGlobal("navigator", {});
  delete realm.GPUDevice;
});

afterEach(() => {
  vi.unstubAllGlobals();
  realm.VideoDecoder = original.VideoDecoder;
  realm.GPUDevice = original.GPUDevice;
});

async function pathFor(
  options: Parameters<typeof openScrubSource>[0],
): Promise<string> {
  return openFrameProvider(await openScrubSource(options)).decodePath;
}

describe("openScrubSource", () => {
  it("an AVCC H.264 source takes the session", async () => {
    expect(await pathFor({ source: SOURCE })).toBe("session");
  });

  it("a viewport downscale still takes the session", async () => {
    expect(await pathFor(DOWNSCALED)).toBe("session");
  });

  it("the downscale still sizes the canvas and the cache blits", async () => {
    const handle = await openScrubSource(DOWNSCALED);
    expect(handle.track.decodeWidth).toBe(900);
    expect(handle.track.width).toBe(2840);
  });

  it("pinning the 2D renderer does not rule out the session", async () => {
    expect(await pathFor({ ...DOWNSCALED, prefer2d: true })).toBe("session");
  });

  it("a codec the session cannot anchor falls back to the canvas sink", async () => {
    decoderConfig = VP9;
    expect(await pathFor(DOWNSCALED)).toBe("canvas");
  });

  it("a track exposing no decoder config falls back to the canvas sink", async () => {
    decoderConfig = null;
    expect(await pathFor(DOWNSCALED)).toBe("canvas");
  });

  it("a realm without WebCodecs falls back to the canvas sink", async () => {
    delete realm.VideoDecoder;
    expect(await pathFor(DOWNSCALED)).toBe("canvas");
  });

  it("a non-session codec at native size with webgpu takes the zero-copy sink", async () => {
    decoderConfig = VP9;
    installWebgpuImport();
    expect(await pathFor({ source: SOURCE })).toBe("sample");
  });
});

describe("openWalkSource", () => {
  it("an AVCC H.264 source walks on the decode session", async () => {
    await openWalkSource(SOURCE);
    // Packet sinks only, so no frame sink was built: the timeline's walk at
    // open and the session's own packet reader.
    expect(new Set(mockSinksBuilt)).toEqual(new Set(["EncodedPacketSink"]));
  });

  it("a codec the session cannot anchor walks on the sample sink", async () => {
    decoderConfig = VP9;
    await openWalkSource(SOURCE);
    expect(mockSinksBuilt).toContain("VideoSampleSink");
  });

  it("a walk never rides the canvas sink, which has no samples to hand out", async () => {
    decoderConfig = VP9;
    delete realm.VideoDecoder;
    await openWalkSource(SOURCE);
    expect(mockSinksBuilt).not.toContain("CanvasSink");
  });
});
