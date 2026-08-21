import { describe, expect, it, vi, type Mock } from "vitest";

import type { WalkFrameSource, WalkSourceHandle } from "./decode-source";
import {
  DecodeSession,
  type EncodedPacketLike,
  type PacketSource,
  type VideoDecoderLike,
} from "./decode-session";
import { FrameTimeline } from "./frame-timeline";
import { FrameWalker, walkFrames, type WalkedFrame } from "./frame-walker";
import type { ScrubTrackInfo, VideoSampleLike } from "./scrub-cursor";
import { asSec } from "./types";

const FPS = 25;
const FRAME_S = 1 / FPS;

const TRACK: ScrubTrackInfo = {
  width: 1280,
  height: 720,
  decodeWidth: 1280,
  decodeHeight: 720,
  nativeFps: FPS,
  durationS: asSec(10),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

interface FakeSample extends VideoSampleLike {
  closed: boolean;
}

function sampleAt(timestamp: number, duration = FRAME_S): FakeSample {
  return {
    timestamp,
    duration,
    closed: false,
    toVideoFrame: () => ({}) as VideoFrame,
    draw: () => undefined,
    close(): void {
      this.closed = true;
    },
  };
}

/**
 * A source that hands out one sample per listed timestamp, opening on the frame
 * covering startS the way both real decode paths do, so every walk under test
 * receives a frame it has to drop.
 */
class FakeWalkSource implements WalkFrameSource {
  readonly track: ScrubTrackInfo;
  readonly openedAt: number[] = [];
  readonly handedOut: FakeSample[] = [];
  returned = 0;

  constructor(
    private readonly timestamps: readonly number[],
    track: ScrubTrackInfo = TRACK,
  ) {
    this.track = track;
  }

  async *framesFrom(
    startS: number,
  ): AsyncGenerator<VideoSampleLike, void, unknown> {
    this.openedAt.push(startS);
    const from = Math.max(
      0,
      this.timestamps.filter((t) => t <= startS).length - 1,
    );
    try {
      for (let i = from; i < this.timestamps.length; i++) {
        const sample = sampleAt(this.timestamps[i]);
        this.handedOut.push(sample);
        yield sample;
      }
    } finally {
      this.returned += 1;
    }
  }

  /** Samples handed out and never closed: what a consumer is holding, plus
   *  anything the walk leaked. */
  get open(): FakeSample[] {
    return this.handedOut.filter((s) => !s.closed);
  }
}

function evenTimestamps(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i * FRAME_S);
}

async function collect(
  walk: AsyncGenerator<WalkedFrame, void, unknown>,
): Promise<WalkedFrame[]> {
  const frames: WalkedFrame[] = [];
  for await (const frame of walk) {
    frames.push(frame);
    frame.sample.close();
  }
  return frames;
}

describe("walkFrames", () => {
  it("stride 1 yields every frame of the range exactly once", async () => {
    const source = new FakeWalkSource(evenTimestamps(10));
    const frames = await collect(
      walkFrames(source, { startMs: 80, endMs: 280 }),
    );

    expect(frames.map((f) => f.frameIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(frames.map((f) => Math.round(f.timestampMs))).toEqual([
      80, 120, 160, 200, 240,
    ]);
    expect(frames.map((f) => Math.round(f.durationMs))).toEqual([
      40, 40, 40, 40, 40,
    ]);
    expect(new Set(frames.map((f) => f.timestampMs)).size).toBe(frames.length);
  });

  it("the walk counts as many frames as the range holds", async () => {
    const timestamps = evenTimestamps(50);
    const source = new FakeWalkSource(timestamps);
    const frames = await collect(
      walkFrames(source, { startMs: 200, endMs: 1000 }),
    );
    const inRange = timestamps.filter(
      (t) => t * 1000 >= 200 && t * 1000 < 1000,
    );

    expect(frames).toHaveLength(inRange.length);
    expect(frames.map((f) => f.timestampMs)).toEqual(
      inRange.map((t) => t * 1000),
    );
  });

  it("the frame covering the range start is dropped and closed", async () => {
    const source = new FakeWalkSource(evenTimestamps(10));
    const frames = await collect(
      walkFrames(source, { startMs: 90, endMs: 200 }),
    );

    expect(Math.round(frames[0].timestampMs)).toBe(120);
    expect(source.handedOut[0].timestamp).toBe(FRAME_S * 2);
    expect(source.handedOut[0].closed).toBe(true);
  });

  it("the end bound is exclusive, so abutting ranges walk every frame once", async () => {
    const source = new FakeWalkSource(evenTimestamps(10));
    const first = await collect(walkFrames(source, { startMs: 0, endMs: 160 }));
    const second = await collect(
      walkFrames(source, { startMs: 160, endMs: 320 }),
    );
    const walked = [...first, ...second].map((f) => Math.round(f.timestampMs));

    expect(walked).toEqual([0, 40, 80, 120, 160, 200, 240, 280]);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("stride steps in index space, not in time", async () => {
    // Uneven spacing: a time-space stride would land between frames here.
    const timestamps = [0, 0.04, 0.1, 0.14, 0.3, 0.34, 0.4, 0.44];
    const source = new FakeWalkSource(timestamps);
    const frames = await collect(walkFrames(source, { stride: 2 }));

    expect(frames.map((f) => f.frameIndex)).toEqual([0, 2, 4, 6]);
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 100, 300, 400]);
  });

  it("stride 3 keeps its index spacing to the end of the range", async () => {
    const source = new FakeWalkSource(evenTimestamps(20));
    const frames = await collect(walkFrames(source, { stride: 3 }));

    expect(frames.map((f) => f.frameIndex)).toEqual([0, 3, 6, 9, 12, 15, 18]);
  });

  it("the frames a stride skips are closed", async () => {
    const source = new FakeWalkSource(evenTimestamps(10));
    const frames = await collect(walkFrames(source, { stride: 2 }));

    expect(frames).toHaveLength(5);
    expect(source.open).toEqual([]);
  });

  it("an empty range yields nothing and never opens the stream", async () => {
    const source = new FakeWalkSource(evenTimestamps(10));

    expect(
      await collect(walkFrames(source, { startMs: 200, endMs: 200 })),
    ).toEqual([]);
    expect(
      await collect(walkFrames(source, { startMs: 300, endMs: 100 })),
    ).toEqual([]);
    expect(source.openedAt).toEqual([]);
    expect(source.handedOut).toEqual([]);
  });

  it("a break returns the stream and closes every sample but the one in hand", async () => {
    const source = new FakeWalkSource(evenTimestamps(10));
    const held: WalkedFrame[] = [];
    for await (const frame of walkFrames(source)) {
      held.push(frame);
      if (held.length === 2) break;
    }

    expect(source.returned).toBe(1);
    expect(source.open).toEqual(held.map((f) => f.sample));
    for (const frame of held) frame.sample.close();
    expect(source.open).toEqual([]);
  });

  it("the walk opens at the track's own first timestamp", async () => {
    const trimmed: ScrubTrackInfo = { ...TRACK, firstTimestampS: asSec(12.5) };
    const source = new FakeWalkSource([12.5, 12.54, 12.58], trimmed);
    const frames = await collect(walkFrames(source));

    expect(source.openedAt).toEqual([12.5]);
    expect(frames.map((f) => f.frameIndex)).toEqual([0, 1, 2]);
    expect(frames[0].timestampMs).toBeCloseTo(12500, 6);
  });

  it("a stride that is not a positive integer is refused", async () => {
    const source = new FakeWalkSource(evenTimestamps(4));

    await expect(collect(walkFrames(source, { stride: 0 }))).rejects.toThrow(
      RangeError,
    );
    await expect(collect(walkFrames(source, { stride: 1.5 }))).rejects.toThrow(
      RangeError,
    );
    expect(source.openedAt).toEqual([]);
  });
});

/**
 * The same walk over the real DecodeSession, fed packets in decode order by a
 * decoder that reorders them the way a picture buffer does. Presentation order
 * is the decoder's to produce and the walk's to preserve, and this is where both
 * claims are checked against the code that makes them.
 */
const REORDER_CONFIG: VideoDecoderConfig = {
  codec: "avc1.424033",
  description: Uint8Array.of(1, 0x42, 0x40, 0x33, 0xff),
};

/** Presentation timestamps in the order an IBBP encode submits them. */
const DECODE_ORDER = [0, 3, 1, 2, 4, 7, 5, 6];

class ReorderedPacketSource implements PacketSource {
  private readonly all: EncodedPacketLike[] = DECODE_ORDER.map((frame, i) => ({
    data: Uint8Array.of(i),
    type: i === 0 ? ("key" as const) : ("delta" as const),
    timestamp: frame * FRAME_S,
    duration: FRAME_S,
  }));

  async getKeyPacket(): Promise<EncodedPacketLike | null> {
    return { ...this.all[0] };
  }

  async getNextKeyPacket(): Promise<EncodedPacketLike | null> {
    return null;
  }

  async *packets(): AsyncGenerator<EncodedPacketLike, void, unknown> {
    for (const packet of this.all) yield { ...packet };
  }
}

interface HeldFrame {
  timestamp: number;
  duration: number;
  closed: boolean;
  close(): void;
}

/** Emits the oldest picture it holds by presentation time once its buffer is
 *  over depth, which is what turns decode order back into presentation order. */
class ReorderingDecoder implements VideoDecoderLike {
  private held: HeldFrame[] = [];
  private readonly output: (frame: VideoFrame) => void;

  constructor(
    init: VideoDecoderInit,
    private readonly depth: number,
  ) {
    this.output = init.output;
  }

  configure(): void {}

  decode(chunk: EncodedVideoChunkInit): void {
    this.held.push({
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? 0,
      closed: false,
      close(): void {
        this.closed = true;
      },
    });
    queueMicrotask(() => this.emit(this.depth));
  }

  async flush(): Promise<void> {
    this.emit(0);
  }

  reset(): void {
    this.held = [];
  }

  close(): void {}

  private emit(depth: number): void {
    while (this.held.length > depth) {
      this.held.sort((a, b) => a.timestamp - b.timestamp);
      this.output(this.held.shift() as unknown as VideoFrame);
    }
  }
}

describe("walkFrames over reordered content", () => {
  it("B-frame reordered packets are walked in presentation order", async () => {
    const session = new DecodeSession({
      packets: new ReorderedPacketSource(),
      config: REORDER_CONFIG,
      createDecoder: (init) => new ReorderingDecoder(init, 2),
    });
    const source: WalkFrameSource = {
      track: TRACK,
      framesFrom: (startS) => session.framesFrom(startS),
    };

    const frames = await collect(walkFrames(source));
    session.close();

    expect(frames).toHaveLength(DECODE_ORDER.length);
    expect(frames.map((f) => f.frameIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(frames.map((f) => Math.round(f.timestampMs))).toEqual([
      0, 40, 80, 120, 160, 200, 240, 280,
    ]);
  });

  it("stride 2 over reordered content stays on even source frames", async () => {
    const session = new DecodeSession({
      packets: new ReorderedPacketSource(),
      config: REORDER_CONFIG,
      createDecoder: (init) => new ReorderingDecoder(init, 2),
    });
    const source: WalkFrameSource = {
      track: TRACK,
      framesFrom: (startS) => session.framesFrom(startS),
    };

    const frames = await collect(walkFrames(source, { stride: 2 }));
    session.close();

    expect(frames.map((f) => f.frameIndex)).toEqual([0, 2, 4, 6]);
    expect(frames.map((f) => Math.round(f.timestampMs))).toEqual([
      0, 80, 160, 240,
    ]);
  });
});

describe("FrameWalker", () => {
  function makeWalker(timestamps: readonly number[]): {
    walker: FrameWalker;
    source: FakeWalkSource;
    disposed: Mock;
  } {
    const source = new FakeWalkSource(timestamps);
    const disposed = vi.fn();
    const handle: WalkSourceHandle = {
      track: source.track,
      framesFrom: (startS) => source.framesFrom(startS),
      dispose: async () => {
        disposed();
      },
    };
    return { walker: new FrameWalker(handle), source, disposed };
  }

  it("metadata reflects the opened track", () => {
    const { walker } = makeWalker(evenTimestamps(4));
    expect(walker.metadata).toEqual({
      durationS: 10,
      width: 1280,
      height: 720,
      nativeFps: FPS,
      firstTimestampS: 0,
    });
  });

  it("a close mid-walk ends the walk, closes the frame in hand, and disposes", async () => {
    const { walker, source, disposed } = makeWalker(evenTimestamps(10));
    const seen: WalkedFrame[] = [];
    for await (const frame of walker.walkFrames()) {
      seen.push(frame);
      frame.sample.close();
      if (seen.length === 2) await walker.close();
    }

    expect(seen).toHaveLength(2);
    expect(source.returned).toBe(1);
    expect(source.open).toEqual([]);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("a closed walker walks nothing", async () => {
    const { walker, source } = makeWalker(evenTimestamps(10));
    await walker.close();

    expect(await collect(walker.walkFrames())).toEqual([]);
    expect(source.openedAt).toEqual([]);
  });
});
