import { describe, expect, it } from "vitest";

import {
  DecodeSession,
  type EncodedPacketLike,
  type PacketRetrievalOptionsLike,
  type PacketSource,
  type VideoDecoderLike,
} from "./decode-session";
import { FrameTimeline } from "./frame-timeline";

/**
 * The 9s basketball fixture as its container states itself: H.264 High 8-bit,
 * 25fps, timescale 25000, one sync sample every 30 frames, pts == dts on every
 * packet (ffprobe reports has_b_frames 0), so nothing in it is reordered and
 * every frame lands on a whole 1000-tick multiple.
 */
const TICK_RATE = 25000;
const TICKS_PER_FRAME = 1000;
const FRAME_COUNT = 225;
const KEY_EVERY = 30;
const FRAME_S = TICKS_PER_FRAME / TICK_RATE;
const MICROSECONDS_PER_SECOND = 1e6;

const CONFIG: VideoDecoderConfig = {
  codec: "avc1.640028",
  description: Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff),
};

const timeline = FrameTimeline.from({
  lastDurationTicks: TICKS_PER_FRAME,
  tickRate: TICK_RATE,
  ticks: Float64Array.from(
    { length: FRAME_COUNT },
    (_, index) => index * TICKS_PER_FRAME,
  ),
});

/**
 * The fixture's detection frames: one per source frame, each covering
 * `[index / 25, (index + 1) / 25)`, which is what
 * `demo/fixtures/basketball_sam3/detections/*.json` carries.
 */
function detectionFrameAt(mediaTimeS: number): number {
  const at = Math.floor(mediaTimeS / FRAME_S + 1e-9);
  return Math.min(Math.max(at, 0), FRAME_COUNT - 1);
}

function clipPackets(): EncodedPacketLike[] {
  return Array.from({ length: FRAME_COUNT }, (_, index) => ({
    data: Uint8Array.of(index & 0xff),
    type: index % KEY_EVERY === 0 ? ("key" as const) : ("delta" as const),
    timestamp: (index * TICKS_PER_FRAME) / TICK_RATE,
    duration: FRAME_S,
  }));
}

interface ReadPacket extends EncodedPacketLike {
  readonly metadataOnly: boolean;
}

function read(
  packet: EncodedPacketLike,
  options?: PacketRetrievalOptionsLike,
): ReadPacket {
  if (options?.metadataOnly)
    return { ...packet, data: new Uint8Array(0), metadataOnly: true };
  return { ...packet, metadataOnly: false };
}

class FixturePacketSource implements PacketSource {
  private readonly all = clipPackets();

  async getKeyPacket(
    timestamp: number,
    options?: PacketRetrievalOptionsLike,
  ): Promise<EncodedPacketLike | null> {
    const keys = this.all.filter(
      (packet) => packet.type === "key" && packet.timestamp <= timestamp + 1e-9,
    );
    return keys.length ? read(keys[keys.length - 1], options) : null;
  }

  async getNextKeyPacket(
    packet: EncodedPacketLike,
    options?: PacketRetrievalOptionsLike,
  ): Promise<EncodedPacketLike | null> {
    const next = this.all.find(
      (candidate) =>
        candidate.type === "key" && candidate.timestamp > packet.timestamp,
    );
    return next ? read(next, options) : null;
  }

  async *packets(
    startPacket?: EncodedPacketLike,
    _endPacket?: EncodedPacketLike,
    options?: PacketRetrievalOptionsLike,
  ): AsyncGenerator<EncodedPacketLike, void, unknown> {
    const from = startPacket
      ? this.all.findIndex(
          (packet) => packet.timestamp >= startPacket.timestamp - 1e-9,
        )
      : 0;
    for (let index = from; index < this.all.length; index++) {
      yield read(this.all[index], options);
    }
  }
}

/** The picture a decoder handed back, recognisable independently of the
 *  timestamp the decoder chose to stamp on it. */
interface FakeFrame {
  timestamp: number;
  duration: number;
  pictureIndex: number;
  closed: boolean;
  clone(): FakeFrame;
  close(): void;
}

/** How a decoder stamps a picture, given the chunk that produced it and the
 *  first chunk it was handed since the last configure(), both in microseconds. */
type StampMicroseconds = (chunkUs: number, firstChunkUs: number) => number;

const echo: StampMicroseconds = (chunkUs) => chunkUs;

/** A decoder that restates every picture against the first chunk it was given
 *  since configure(), so a GOP anchored at 6s comes back stamped from zero. */
const rebasedPerConfigure: StampMicroseconds = (chunkUs, firstChunkUs) =>
  chunkUs - firstChunkUs;

/** A decoder whose stamps run a whole frame ahead of the chunk they came from. */
const oneFrameAhead: StampMicroseconds = (chunkUs) =>
  chunkUs + FRAME_S * MICROSECONDS_PER_SECOND;

/** Half a millisecond of stamp noise, well inside one 40ms frame gap. */
const subFrameNoise: StampMicroseconds = (chunkUs) => chunkUs + 500;

class FakeDecoder implements VideoDecoderLike {
  private readonly output: (frame: VideoFrame) => void;
  private held: FakeFrame[] = [];
  private firstChunkUs: number | null = null;
  private decodedCount = 0;

  constructor(
    init: VideoDecoderInit,
    private readonly stamp: StampMicroseconds,
    private readonly dropEvery = 0,
  ) {
    this.output = init.output;
  }

  configure(): void {
    this.firstChunkUs = null;
  }

  decode(chunk: EncodedVideoChunkInit): void {
    this.firstChunkUs ??= chunk.timestamp;
    const frame: FakeFrame = {
      timestamp: this.stamp(chunk.timestamp, this.firstChunkUs),
      duration: chunk.duration ?? 0,
      pictureIndex: Math.round(
        chunk.timestamp / (FRAME_S * MICROSECONDS_PER_SECOND),
      ),
      closed: false,
      clone(): FakeFrame {
        return this;
      },
      close(): void {
        this.closed = true;
      },
    };
    this.decodedCount += 1;

    if (this.dropEvery > 0 && this.decodedCount % this.dropEvery === 0) {
      return;
    }

    this.held.push(frame);
    queueMicrotask(() => this.emit());
  }

  async flush(): Promise<void> {
    this.emit();
  }

  reset(): void {
    this.held = [];
  }

  close(): void {}

  private emit(): void {
    while (this.held.length > 0) {
      this.output(this.held.shift() as unknown as VideoFrame);
    }
  }
}

function openSession(stamp: StampMicroseconds, dropEvery = 0): DecodeSession {
  return new DecodeSession({
    packets: new FixturePacketSource(),
    config: CONFIG,
    createDecoder: (init) => new FakeDecoder(init, stamp, dropEvery),
    rotation: 0,
  });
}

/**
 * The whole mapping the screen depends on, for one seek: the picture the
 * session handed out, and the detection frame the position it published for
 * that picture selects. A disagreement between the two is annotations drawn
 * over a different moment's pixels.
 */
async function seekTo(
  session: DecodeSession,
  targetS: number,
): Promise<{ pictureIndex: number; detectionFrameIndex: number }> {
  const sample = await session.frameAt(targetS);
  if (!sample) throw new Error(`no frame at ${targetS}s`);
  const picture = sample.toVideoFrame() as unknown as FakeFrame;
  const landing = timeline.landingAt(timeline.indexOfDecoded(sample.timestamp));
  sample.close();
  return {
    pictureIndex: picture.pictureIndex,
    detectionFrameIndex: detectionFrameAt(landing.mediaTimeS),
  };
}

/** A sync sample and a target ten frames into the same GOP, since a walk from
 *  the anchor and a landing on the anchor itself fail differently. */
const SEEKS: readonly { targetS: number; frameIndex: number }[] = [
  { targetS: 6.0, frameIndex: 150 },
  { targetS: 6.4, frameIndex: 160 },
];

describe.each([
  { name: "echoes the chunk it was given", stamp: echo },
  { name: "stamps from its own origin", stamp: rebasedPerConfigure },
  { name: "stamps a frame ahead", stamp: oneFrameAhead },
  { name: "stamps half a millisecond late", stamp: subFrameNoise },
])("a decoder that $name", ({ stamp }) => {
  it.each(SEEKS)(
    "draws frame $frameIndex's detections over frame $frameIndex's pixels at $targetS s",
    async ({ targetS, frameIndex }) => {
      const session = openSession(stamp);

      expect(await seekTo(session, targetS)).toEqual({
        pictureIndex: frameIndex,
        detectionFrameIndex: frameIndex,
      });
    },
  );

  it("publishes the container's own timestamps across a playback walk", async () => {
    const session = openSession(stamp);
    const published: number[] = [];

    for await (const sample of session.framesFrom(6.0)) {
      published.push(Math.round(sample.timestamp * TICK_RATE));
      sample.close();
      if (published.length === 5) break;
    }

    expect(published).toEqual([150, 151, 152, 153, 154].map((i) => i * 1000));
  });
});

describe("a decoder that silently drops an output", () => {
  it.each(SEEKS)(
    "still draws frame $frameIndex's detections over frame $frameIndex's pixels",
    async ({ targetS, frameIndex }) => {
      // Pairing each picture with the earliest packet still owed would shift
      // every picture after the drop onto a neighbour's detections, and stay
      // shifted, which is what a wrong position looks like on screen.
      const session = openSession(echo, 7);

      expect(await seekTo(session, targetS)).toEqual({
        pictureIndex: frameIndex,
        detectionFrameIndex: frameIndex,
      });
    },
  );

  it("publishes the container's own timestamps across a playback walk", async () => {
    const session = openSession(echo, 7);
    const published: number[] = [];

    for await (const sample of session.framesFrom(6.0)) {
      published.push(Math.round(sample.timestamp * TICK_RATE));
      sample.close();
      if (published.length === 5) break;
    }

    for (const [at, ticks] of published.entries()) {
      expect(ticks % 1000).toBe(0);
      if (at > 0) expect(ticks).toBeGreaterThan(published[at - 1] as number);
    }
  });
});
