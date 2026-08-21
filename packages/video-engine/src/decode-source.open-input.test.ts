/**
 * Open-path tests: the codec-decodability check (T4a) and the non-zero track
 * origin (T4b). They exercise the real openInput through openDecodeSource by
 * mocking the mediabunny module so the fake Input's primary track controls
 * canDecode() and the packet table the frame timeline is built from.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDecodeSource } from "./decode-source";
import {
  SourceKind,
  VideoEngineError,
  VideoEngineErrorCode,
  type VideoSource,
} from "./types";

interface FakeTrackConfig {
  canDecode: boolean;
  firstTimestamp: number;
  hasTrack?: boolean;
  packetCount?: number;
}

/** A whole multiple of both 30fps and every origin these tests use, so the fake
 *  table needs no rounding and its times are exact. */
const TICK_RATE = 600;

let trackConfig: FakeTrackConfig = { canDecode: true, firstTimestamp: 0 };

class FakeVideoTrack {
  displayWidth = 320;
  displayHeight = 180;
  canDecode(): Promise<boolean> {
    return Promise.resolve(trackConfig.canDecode);
  }
  getTimeResolution(): Promise<number> {
    return Promise.resolve(TICK_RATE);
  }
  computeDuration(): Promise<number> {
    return Promise.resolve(5);
  }
  computePacketStats(): Promise<{ averagePacketRate: number }> {
    return Promise.resolve({ averagePacketRate: 30 });
  }
}

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  UrlSource: class {
    constructor(readonly url: string) {}
  },
  BlobSource: class {},
  ReadableStreamSource: class {},
  Input: class {
    getPrimaryVideoTrack(): Promise<FakeVideoTrack | null> {
      return Promise.resolve(
        trackConfig.hasTrack === false ? null : new FakeVideoTrack(),
      );
    }
    dispose(): void {}
  },
  CanvasSink: class {
    constructor(
      readonly track: unknown,
      readonly opts: unknown,
    ) {}
  },
  VideoSampleSink: class {},
  EncodedPacketSink: class {
    constructor(readonly track: unknown) {}
    async *packets(): AsyncGenerator<
      { timestamp: number; duration: number },
      void,
      unknown
    > {
      const count = trackConfig.packetCount ?? 5;
      // Decode order, which on a real B-frame source is not presentation
      // order: the table has to sort itself.
      for (const step of [...Array(count).keys()].reverse()) {
        yield {
          timestamp: trackConfig.firstTimestamp + step / 30,
          duration: 1 / 30,
        };
      }
    }
  },
}));

const SOURCE: VideoSource = {
  kind: SourceKind.Url,
  url: "https://example.test/v.mp4",
};

afterEach(() => {
  trackConfig = { canDecode: true, firstTimestamp: 0 };
});

describe("openInput decodability (T4a)", () => {
  it("an undecodable track surfaces VideoEngineError(DecodeUnsupported)", async () => {
    trackConfig = { canDecode: false, firstTimestamp: 0 };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: VideoEngineErrorCode.DecodeUnsupported,
    });
  });

  it("the thrown value is a typed VideoEngineError, not a bare Error", async () => {
    trackConfig = { canDecode: false, firstTimestamp: 0 };
    const error = await openDecodeSource({ source: SOURCE }).catch((e) => e);
    expect(error).toBeInstanceOf(VideoEngineError);
  });

  it("no video track also surfaces DecodeUnsupported", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 0, hasTrack: false };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: VideoEngineErrorCode.DecodeUnsupported,
    });
  });

  it("a decodable track opens without throwing", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 0 };
    const handle = await openDecodeSource({ source: SOURCE });
    expect(handle.track.decodeWidth).toBe(320);
  });
});

describe("openInput track origin (T4b)", () => {
  it("the resolved track carries the real first timestamp", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 2.5 };
    const handle = await openDecodeSource({ source: SOURCE });
    expect(handle.track.firstTimestampS).toBe(2.5);
  });

  it("a negative first timestamp flows through verbatim", async () => {
    trackConfig = { canDecode: true, firstTimestamp: -0.4 };
    const handle = await openDecodeSource({ source: SOURCE });
    expect(handle.track.firstTimestampS).toBe(-0.4);
  });

  it("the origin defaults to 0 when the track reports zero", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 0 };
    const handle = await openDecodeSource({ source: SOURCE });
    expect(handle.track.firstTimestampS).toBe(0);
  });
});

describe("openInput frame timeline", () => {
  it("a track with no packets fails the load", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 0, packetCount: 0 };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: VideoEngineErrorCode.DecodeUnsupported,
    });
  });

  it("the timeline is presentation-ordered whatever order the packets arrive in", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 1, packetCount: 5 };
    const { timeline } = (await openDecodeSource({ source: SOURCE })).track;

    expect(timeline.frameCount).toBe(5);
    expect([...Array(5).keys()].map((i) => timeline.ticksAt(i))).toEqual([
      600, 620, 640, 660, 680,
    ]);
  });

  it("the origin is the timeline's own first frame", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 2.5 };
    const { firstTimestampS, timeline } = (
      await openDecodeSource({ source: SOURCE })
    ).track;

    expect(firstTimestampS).toBe(timeline.timeAt(0));
  });
});
