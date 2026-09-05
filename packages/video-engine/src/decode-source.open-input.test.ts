/**
 * Open-path tests: the codec-decodability check (T4a) and the non-zero track
 * origin (T4b). They exercise the real openInput through openDecodeSource by
 * mocking the mediabunny module so the fake Input's primary track controls
 * canDecode() and the packet table the frame timeline is built from.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDecodeSource } from "./decode-source";
import type { Rotation } from "./rotation";
import {
  SourceKind,
  WebVideoEngineError,
  WebVideoEngineErrorCode,
  type VideoSource,
} from "./types";

interface FakeTrackConfig {
  canDecode: boolean;
  codec?: string;
  firstTimestamp: number;
  /** The track's quarter turn, with the display size already turned by it, the
   *  way mediabunny reports a track carrying a display matrix. */
  rotation?: Rotation;
  displayWidth?: number;
  displayHeight?: number;
  hasTrack?: boolean;
  containerUnreadable?: boolean;
  otherTrackCount?: number;
  packetCount?: number;
}

/** A whole multiple of both 30fps and every origin these tests use, so the fake
 *  table needs no rounding and its times are exact. */
const TICK_RATE = 600;

let trackConfig: FakeTrackConfig = { canDecode: true, firstTimestamp: 0 };

class FakeVideoTrack {
  get rotation(): Rotation {
    return trackConfig.rotation ?? 0;
  }
  get displayWidth(): number {
    return trackConfig.displayWidth ?? 320;
  }
  get displayHeight(): number {
    return trackConfig.displayHeight ?? 180;
  }
  canDecode(): Promise<boolean> {
    return Promise.resolve(trackConfig.canDecode);
  }
  getDecoderConfig(): Promise<{ codec: string } | null> {
    return Promise.resolve(
      trackConfig.codec ? { codec: trackConfig.codec } : null,
    );
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

vi.mock("mediabunny", () => {
  class FakeUnsupportedInputFormatError extends Error {}
  return {
    ALL_FORMATS: [],
    UnsupportedInputFormatError: FakeUnsupportedInputFormatError,
    UrlSource: class {
      constructor(readonly url: string) {}
    },
    BlobSource: class {},
    ReadableStreamSource: class {},
    Input: class {
      getPrimaryVideoTrack(): Promise<FakeVideoTrack | null> {
        if (trackConfig.containerUnreadable) {
          return Promise.reject(
            new FakeUnsupportedInputFormatError(
              "Input has an unsupported or unrecognizable format.",
            ),
          );
        }
        return Promise.resolve(
          trackConfig.hasTrack === false ? null : new FakeVideoTrack(),
        );
      }
      getTracks(): Promise<unknown[]> {
        return Promise.resolve(
          Array(trackConfig.otherTrackCount ?? 0).fill({}),
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
  };
});

const SOURCE: VideoSource = {
  kind: SourceKind.Url,
  url: "https://example.test/v.mp4",
};

afterEach(() => {
  trackConfig = { canDecode: true, firstTimestamp: 0 };
});

describe("openInput decodability (T4a)", () => {
  it("an undecodable track surfaces WebVideoEngineError(DecodeUnsupported)", async () => {
    trackConfig = { canDecode: false, firstTimestamp: 0 };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.DecodeUnsupported,
    });
  });

  it("the refusal names the codec the browser turned down", async () => {
    trackConfig = {
      canDecode: false,
      codec: "hev1.2.4.L150.B0",
      firstTimestamp: 0,
    };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toThrow(
      "hev1.2.4.L150.B0",
    );
  });

  it("a track whose decoder config cannot be read still names the refusal", async () => {
    trackConfig = { canDecode: false, firstTimestamp: 0 };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toThrow(
      /codec \(unknown\)/,
    );
  });

  it("the thrown value is a typed WebVideoEngineError, not a bare Error", async () => {
    trackConfig = { canDecode: false, firstTimestamp: 0 };
    const error = await openDecodeSource({ source: SOURCE }).catch((e) => e);
    expect(error).toBeInstanceOf(WebVideoEngineError);
  });

  it("a container the demuxer will not open blames the container", async () => {
    trackConfig = {
      canDecode: true,
      containerUnreadable: true,
      firstTimestamp: 0,
    };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.ContainerUnreadable,
    });
  });

  it("a container that opens with no track parsed out of it does not blame the file", async () => {
    trackConfig = { canDecode: true, firstTimestamp: 0, hasTrack: false };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.VideoTrackUnreadable,
    });
  });

  it("listed tracks with no video among them is the one case that says the file has none", async () => {
    trackConfig = {
      canDecode: true,
      firstTimestamp: 0,
      hasTrack: false,
      otherTrackCount: 2,
    };
    await expect(openDecodeSource({ source: SOURCE })).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.NoVideoTrack,
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

  it("negative pre-roll is hidden without losing a straddling frame's source address", async () => {
    trackConfig = { canDecode: true, firstTimestamp: -0.02 };
    const handle = await openDecodeSource({ source: SOURCE });
    expect(handle.track.firstTimestampS).toBe(0);
    expect(handle.track.timeline.timeAt(0)).toBe(0);
    expect(handle.track.timeline.sourceTimeAt(0)).toBe(-0.02);
    expect(handle.track.timeline.toData().sourceTicks?.[0]).toBe(-12);
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
      code: WebVideoEngineErrorCode.DecodeUnsupported,
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

describe("openInput rotation", () => {
  it("publishes the track's turn beside dimensions it has already been applied to", async () => {
    trackConfig = {
      canDecode: true,
      firstTimestamp: 0,
      rotation: 270,
      displayWidth: 180,
      displayHeight: 320,
    };

    const handle = await openDecodeSource({ source: SOURCE });

    expect(handle.track.rotation).toBe(270);
    // Turning here as well would square the turn: mediabunny's display size is
    // the turned size already.
    expect([handle.track.width, handle.track.height]).toEqual([180, 320]);
    expect([handle.track.decodeWidth, handle.track.decodeHeight]).toEqual([
      180, 320,
    ]);
  });

  it("a track with no display matrix publishes no turn", async () => {
    const handle = await openDecodeSource({ source: SOURCE });

    expect(handle.track.rotation).toBe(0);
    expect([handle.track.width, handle.track.height]).toEqual([320, 180]);
  });
});
