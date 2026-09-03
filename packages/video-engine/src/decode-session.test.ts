import { describe, expect, it } from "vitest";

import {
  DecodeSession,
  type EncodedPacketLike,
  type PacketRetrievalOptionsLike,
  type PacketSource,
  type VideoDecoderLike,
} from "./decode-session";
import type { Rotation } from "./rotation";
import { WebVideoEngineError, WebVideoEngineErrorCode } from "./types";
import {
  paintedCorners,
  QUARTER_TURNS,
  TransformRecorder,
  turnedSize,
} from "../test/rotation-probe";

const FPS = 15;
const FRAME_S = 1 / FPS;
/** Sync samples every 2s, matching the clip the session was measured on. */
const KEY_EVERY = 30;
const FRAME_COUNT = 120;

const CONFIG: VideoDecoderConfig = {
  codec: "avc1.424033",
  description: Uint8Array.of(1, 0x42, 0x40, 0x33, 0xff),
};

function clipPackets(): EncodedPacketLike[] {
  return Array.from({ length: FRAME_COUNT }, (_, i) => ({
    data: Uint8Array.of(i & 0xff),
    type: i % KEY_EVERY === 0 ? ("key" as const) : ("delta" as const),
    timestamp: i * FRAME_S,
    duration: FRAME_S,
  }));
}

/** A packet as a reader hands it back: a fresh object every read, so packet
 *  identity is never a way to recognise one, and metadata-only reads carry no
 *  bytes and are refused as the start of a full-data walk. */
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

/** Container-shaped packet reader: key packets are the container's sync table,
 *  which is what anchoring with verification off reads. */
class FakePacketSource implements PacketSource {
  readonly keyProbes: Array<{
    timestamp: number;
    options?: PacketRetrievalOptionsLike;
  }> = [];
  readonly iterations: number[] = [];
  /** Awaited before every packet a walk reads, so a test can pin one reader
   *  mid-walk and drive a second one past it deterministically. */
  beforeYield: (() => Promise<void>) | null = null;
  private readonly all = clipPackets();

  async getKeyPacket(
    timestamp: number,
    options?: PacketRetrievalOptionsLike,
  ): Promise<EncodedPacketLike | null> {
    this.keyProbes.push({ timestamp, options });
    const keys = this.all.filter(
      (p) => p.type === "key" && p.timestamp <= timestamp + 1e-9,
    );
    return keys.length ? read(keys[keys.length - 1], options) : null;
  }

  async getNextKeyPacket(
    packet: EncodedPacketLike,
    options?: PacketRetrievalOptionsLike,
  ): Promise<EncodedPacketLike | null> {
    const next = this.all.find(
      (p) => p.type === "key" && p.timestamp > packet.timestamp,
    );
    return next ? read(next, options) : null;
  }

  async *packets(
    startPacket?: EncodedPacketLike,
    _endPacket?: EncodedPacketLike,
    options?: PacketRetrievalOptionsLike,
  ): AsyncGenerator<EncodedPacketLike, void, unknown> {
    if (
      startPacket &&
      (startPacket as ReadPacket).metadataOnly &&
      !options?.metadataOnly
    ) {
      throw new TypeError(
        "startPacket can only be metadata-only if options.metadataOnly is enabled.",
      );
    }
    const from = startPacket
      ? this.all.findIndex((p) => p.timestamp >= startPacket.timestamp - 1e-9)
      : 0;
    this.iterations.push(this.all[from].timestamp);
    for (let i = from; i < this.all.length; i++) {
      if (this.beforeYield) await this.beforeYield();
      yield read(this.all[i], options);
    }
  }
}

interface FrameLike {
  timestamp: number;
  duration: number;
  closed: boolean;
  close(): void;
}

/**
 * One frame out per chunk in, on a later turn. `holdFrames` is how many pictures
 * it keeps before emitting the oldest, which is what a real decoder's picture
 * buffer does and what decides whether it emits anything at all.
 */
class FakeDecoder implements VideoDecoderLike {
  readonly configs: VideoDecoderConfig[] = [];
  readonly chunks: EncodedVideoChunkInit[] = [];
  readonly frames: FrameLike[] = [];
  resets = 0;
  flushes = 0;
  closes = 0;
  private readonly output: (frame: VideoFrame) => void;
  private held: FrameLike[] = [];

  constructor(
    init: VideoDecoderInit,
    private readonly holdFrames = 0,
  ) {
    this.output = init.output;
  }

  configure(config: VideoDecoderConfig): void {
    this.configs.push(config);
  }

  decode(chunk: EncodedVideoChunkInit): void {
    this.chunks.push(chunk);
    const frame: FrameLike = {
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? 0,
      closed: false,
      close(): void {
        this.closed = true;
      },
    };
    this.frames.push(frame);
    this.held.push(frame);
    queueMicrotask(() => this.emitPast(this.holdFrames));
  }

  async flush(): Promise<void> {
    this.flushes++;
    this.emitPast(0);
  }

  reset(): void {
    this.resets++;
    this.held = [];
  }

  close(): void {
    this.closes++;
  }

  private emitPast(depth: number): void {
    while (this.held.length > depth) {
      this.output(this.held.shift() as unknown as VideoFrame);
    }
  }
}

function openSession(
  holdFrames = 0,
  rotation: Rotation = 0,
  ownership?: {
    readonly outputWidth: number;
    readonly outputHeight: number;
    readonly snapshotFrame: (
      frame: VideoFrame,
      width: number,
      height: number,
    ) => VideoFrame;
  },
): {
  session: DecodeSession;
  packets: FakePacketSource;
  decoders: FakeDecoder[];
} {
  const packets = new FakePacketSource();
  const decoders: FakeDecoder[] = [];
  const session = new DecodeSession({
    packets,
    config: CONFIG,
    rotation,
    ...ownership,
    createDecoder: (init) => {
      const decoder = new FakeDecoder(init, holdFrames);
      decoders.push(decoder);
      return decoder;
    },
  });
  return { session, packets, decoders };
}

async function collect(
  frames: AsyncGenerator<{ timestamp: number; close(): void }, void, unknown>,
): Promise<number[]> {
  const out: number[] = [];
  for await (const frame of frames) {
    out.push(Math.round(frame.timestamp * 1000));
    frame.close();
  }
  return out;
}

describe("DecodeSession anchoring", () => {
  it("a forward seek inside the anchor span reuses the decoder", async () => {
    const { session, packets, decoders } = openSession();

    await session.frameAt(0.5);
    const afterFirst = session.anchorCount;
    await session.frameAt(1.2);

    expect(afterFirst).toBe(1);
    expect(session.anchorCount).toBe(1);
    expect(decoders).toHaveLength(1);
    expect(decoders[0].resets).toBe(0);
    expect(packets.iterations).toEqual([0]);
  });

  it("a forward seek decodes only the packets between the head and the target", async () => {
    const { session, decoders } = openSession();

    await session.frameAt(0.5);
    const walked = decoders[0].chunks.length;
    await session.frameAt(1.2);

    // Eight packets reach 0.5s, plus the ones keeping the decoder fed.
    expect(walked).toBe(13);
    // 0.5s -> 1.2s at 15fps is eleven frames, one of them already decoded
    // ahead of the read; anything near eighteen means it re-walked from the
    // anchor.
    expect(decoders[0].chunks.length - walked).toBe(10);
  });

  it("a decoder that holds pictures back still yields the frame asked for", async () => {
    // Eight held is well inside what H.264 allows, and nothing comes out
    // until the ninth chunk goes in, so a session that submits only as far
    // as the frame it wants waits forever.
    const { session } = openSession(8);

    const frame = await session.frameAt(0);

    expect(frame?.timestamp).toBe(0);
  });

  it("a backward jump re-anchors", async () => {
    const { session, packets, decoders } = openSession();

    await session.frameAt(1.2);
    await session.frameAt(0.4);

    expect(session.anchorCount).toBe(2);
    expect(decoders).toHaveLength(1);
    expect(decoders[0].resets).toBe(1);
    expect(packets.iterations).toEqual([0, 0]);
  });

  it("a jump past the next anchor re-anchors", async () => {
    const { session, packets } = openSession();

    await session.frameAt(0.5);
    await session.frameAt(4.5);

    expect(session.anchorCount).toBe(2);
    expect(packets.iterations).toEqual([0, 4]);
  });

  it("the anchor is read with key verification off", async () => {
    const { session, packets } = openSession();

    await session.frameAt(0.5);

    expect(packets.keyProbes[0].options).toEqual({ verifyKeyPackets: false });
  });

  it("the anchor is read with its bytes, so the walk can start from it", async () => {
    const { session, decoders } = openSession();

    await expect(session.frameAt(0.5)).resolves.not.toBeNull();

    expect(decoders[0].chunks[0].data).not.toHaveLength(0);
  });
});

describe("DecodeSession chunks", () => {
  it("the anchor carries the recovery-point SEI and nothing after it does", async () => {
    const { session, decoders } = openSession();

    await session.frameAt(0.2);

    const [first, second] = decoders[0].chunks;
    expect(Array.from(first.data as Uint8Array)).toEqual([
      0, 0, 0, 5, 0x06, 0x06, 0x01, 0xc2, 0x80, 0,
    ]);
    expect(Array.from(second.data as Uint8Array)).toEqual([1]);
  });

  it("only the anchor is submitted as a key chunk", async () => {
    const { session, decoders } = openSession();

    await collect(session.framesCovering(0, 2.2));

    // The walk crosses the sync sample at 2.0s. The decoder verifies a key
    // claim against the bitstream, so that sample must go in as a delta.
    expect(decoders[0].chunks.map((c) => c.type)).toEqual([
      "key",
      ...Array<string>(38).fill("delta"),
    ]);
  });

  it("the decoder is configured for prompt per-frame emission", async () => {
    const { session, decoders } = openSession();

    await session.frameAt(0.2);

    expect(decoders[0].configs[0].optimizeForLatency).toBe(true);
  });

  it("a source the recovery-point SEI cannot open is rejected", () => {
    expect(
      () =>
        new DecodeSession({
          packets: new FakePacketSource(),
          config: { codec: "vp09.00.10.08" },
          createDecoder: (init) => new FakeDecoder(init),
          rotation: 0,
        }),
    ).toThrow(/not AVCC-framed H.264/);
  });
});

describe("DecodeSession frames", () => {
  it("owns decoder output pixels before queueing them", async () => {
    const snapshots: Array<{ width: number; height: number }> = [];
    const { session, decoders } = openSession(0, 0, {
      outputWidth: 320,
      outputHeight: 180,
      snapshotFrame: (frame, width, height) => {
        snapshots.push({ width, height });
        return {
          timestamp: frame.timestamp,
          duration: frame.duration,
          close: () => undefined,
        } as unknown as VideoFrame;
      },
    });

    const landed = await session.frameAt(0.5);

    expect(landed).not.toBeNull();
    expect(snapshots).not.toHaveLength(0);
    expect(
      snapshots.every(({ width, height }) => width === 320 && height === 180),
    ).toBe(true);
    expect(landed?.independentPixels).toBe(true);
    expect(decoders[0].frames.every((frame) => frame.closed)).toBe(true);
    landed?.close();
  });

  it("framesCovering yields the walk from the anchor, not just the span", async () => {
    const { session } = openSession();

    const covered = await collect(session.framesCovering(1.0, 1.2));

    expect(covered[0]).toBe(0);
    expect(covered[covered.length - 1]).toBe(1200);
    expect(covered).toHaveLength(19);
  });

  it("framesFrom drops the walk and starts at the requested position", async () => {
    const { session } = openSession();

    const iter = session.framesFrom(1.0);
    const first = await iter.next();
    const second = await iter.next();
    await iter.return(undefined);

    expect(Math.round((first.value?.timestamp ?? 0) * 1000)).toBe(1000);
    expect(Math.round((second.value?.timestamp ?? 0) * 1000)).toBe(1067);
  });

  it("frameAt lands on the frame at or before the target", async () => {
    const { session } = openSession();

    const frame = await session.frameAt(1.05);

    expect(Math.round((frame?.timestamp ?? 0) * 1000)).toBe(1000);
  });

  it("the frames walked past are closed and the landed one is not", async () => {
    const { session, decoders } = openSession();

    await session.frameAt(0.5);

    // Seven walked past and closed, the landed one held open, and the ones
    // decoded ahead of the read still queued.
    const closed = decoders[0].frames.map((f) => f.closed);
    expect(closed).toEqual([
      ...Array<boolean>(7).fill(true),
      ...Array<boolean>(6).fill(false),
    ]);
  });

  it("close releases the decoder", async () => {
    const { session, decoders } = openSession();

    await session.frameAt(0.5);
    session.close();

    expect(decoders[0].closes).toBe(1);
    expect(await session.frameAt(1.0)).toBeNull();
    expect(session.anchorCount).toBe(1);
  });
});

/**
 * A decoder can fail in ways that look exactly like a slow one: it refuses to
 * configure, it errors, or it takes every chunk it is handed and answers none of
 * them. Each has to arrive as a typed terminal failure, because the recovery a
 * transient failure earns (drop the work, re-anchor, try again) runs forever
 * against a decoder that was never going to start.
 */
describe("DecodeSession decoder failure", () => {
  /** Reproduces a machine with no decoder session left to hand out: the
   *  constructor succeeds and configure is what refuses. */
  class RefusingDecoder implements VideoDecoderLike {
    configureCalls = 0;
    constructor(private readonly onConfigure: () => never) {}
    configure(): void {
      this.configureCalls += 1;
      this.onConfigure();
    }
    decode(): void {
      throw new Error("decode on an unconfigured decoder");
    }
    async flush(): Promise<void> {}
    reset(): void {}
    close(): void {}
  }

  /** Takes every chunk and produces nothing: the failure mode with no error of
   *  its own to report, which is the one that used to be invisible. */
  class SilentDecoder implements VideoDecoderLike {
    readonly chunks: EncodedVideoChunkInit[] = [];
    configure(): void {}
    decode(chunk: EncodedVideoChunkInit): void {
      this.chunks.push(chunk);
    }
    async flush(): Promise<void> {}
    reset(): void {}
    close(): void {}
  }

  /** Emits normally until `after` frames have gone out, then goes quiet. */
  class QuittingDecoder implements VideoDecoderLike {
    private emitted = 0;
    private readonly output: (frame: VideoFrame) => void;
    constructor(
      init: VideoDecoderInit,
      private readonly after: number,
    ) {
      this.output = init.output;
    }
    configure(): void {}
    decode(chunk: EncodedVideoChunkInit): void {
      if (this.emitted >= this.after) return;
      this.emitted += 1;
      const frame = {
        timestamp: chunk.timestamp,
        duration: 0,
        close: () => undefined,
      };
      queueMicrotask(() => this.output(frame as unknown as VideoFrame));
    }
    async flush(): Promise<void> {}
    reset(): void {}
    close(): void {}
  }

  const OUTPUT_TIMEOUT_MS = 50;

  function sessionWith(
    createDecoder: (init: VideoDecoderInit) => VideoDecoderLike,
  ): {
    session: DecodeSession;
    packets: FakePacketSource;
  } {
    const packets = new FakePacketSource();
    const session = new DecodeSession({
      packets,
      config: CONFIG,
      createDecoder,
      outputTimeoutMs: OUTPUT_TIMEOUT_MS,
      rotation: 0,
    });
    return { session, packets };
  }

  async function codeOf(
    work: Promise<unknown>,
  ): Promise<WebVideoEngineErrorCode | string> {
    try {
      await work;
      return "resolved";
    } catch (error) {
      return error instanceof WebVideoEngineError ? error.code : String(error);
    }
  }

  it("a decoder that refuses to configure surfaces as a stalled decoder", async () => {
    const { session } = sessionWith(
      () =>
        new RefusingDecoder(() => {
          throw new DOMException(
            "no decoder session available",
            "QuotaExceededError",
          );
        }),
    );

    await expect(codeOf(session.frameAt(0.5))).resolves.toBe(
      WebVideoEngineErrorCode.DecoderStalled,
    );
  });

  it("the configure failure is latched, so retrying does not re-run it", async () => {
    const decoders: RefusingDecoder[] = [];
    const { session, packets } = sessionWith(() => {
      const decoder = new RefusingDecoder(() => {
        throw new Error("no decoder session available");
      });
      decoders.push(decoder);
      return decoder;
    });

    await expect(session.frameAt(0.5)).rejects.toThrow(/refused to configure/);
    const anchorsAfterFirst = packets.keyProbes.length;
    await expect(session.frameAt(2.5)).rejects.toThrow(/refused to configure/);

    // The second ask refuses from the latch: no fresh anchor probe, no
    // second configure. A source that cannot decode is not worth re-walking.
    expect(packets.keyProbes).toHaveLength(anchorsAfterFirst);
    expect(decoders[0].configureCalls).toBe(1);
  });

  it("a decoder that reports an error surfaces as a stalled decoder", async () => {
    const { session } = sessionWith((init) => {
      queueMicrotask(() =>
        init.error(new DOMException("decoder error", "EncodingError")),
      );
      return new SilentDecoder();
    });

    await expect(codeOf(session.frameAt(0.5))).resolves.toBe(
      WebVideoEngineErrorCode.DecoderStalled,
    );
  });

  it("a decoder that takes every chunk and produces nothing surfaces as stalled", async () => {
    const silent = new SilentDecoder();
    const { session } = sessionWith(() => silent);

    const code = await codeOf(session.frameAt(0.5));

    // It acknowledged the requests, which is exactly why nothing else in the
    // pipe could tell: the only evidence is that none came back.
    expect(silent.chunks.length).toBeGreaterThan(0);
    expect(session.framesDecoded).toBe(0);
    expect(code).toBe(WebVideoEngineErrorCode.DecoderStalled);
  });

  it("the silent-decoder failure is latched, so a retry does not wait it out again", async () => {
    const silent = new SilentDecoder();
    const { session } = sessionWith(() => silent);

    await expect(session.frameAt(0.5)).rejects.toThrow(/produced no frame/);
    const submittedOnce = silent.chunks.length;
    await expect(session.frameAt(2.5)).rejects.toThrow(/produced no frame/);

    expect(silent.chunks).toHaveLength(submittedOnce);
  });

  it("a decoder that goes quiet after decoding stays recoverable", async () => {
    const { session } = sessionWith((init) => new QuittingDecoder(init, 4));

    // The walk gets its first frames out, so the decoder demonstrably works
    // and its going quiet is a moment, not a verdict: rebuilding it is worth
    // a try, and calling the source undecodable would be a lie.
    await session.frameAt(0);
    const code = await codeOf(session.frameAt(6));

    expect(session.framesDecoded).toBeGreaterThan(0);
    expect(code).toBe(WebVideoEngineErrorCode.BackendCrashed);
  });
});

/**
 * One decoder serves the scrub and the playback walk at once, so these cover
 * what happens to a walk while another reader moves the decoder underneath it.
 */
describe("DecodeSession reachable position", () => {
  it("reports where the decoder sits, so a caller can tell a cheap ask from a walk", async () => {
    const { session } = openSession();
    // Nothing decoded yet: nothing is cheap.
    expect(session.reachableFromS).toBe(-Infinity);

    await session.frameAt(1.0);
    const afterLanding = session.reachableFromS;
    // The decoder has walked to 1.0 and holds frames past it, so anything
    // from there on costs only the frames in between.
    expect(afterLanding).toBeGreaterThan(0);
    expect(afterLanding).toBeLessThanOrEqual(1.1);

    // A backward jump re-anchors, and the reachable point follows it back to
    // the keyframe the walk restarts from.
    await session.frameAt(5.0);
    expect(session.reachableFromS).toBeGreaterThan(1.0);
  });
});

describe("DecodeSession readers sharing one decoder", () => {
  const MS = (t: number): number => Math.round(t * 1000);

  /** Holds every packet read until the returned release is called, which parks
   *  a reader inside its walk. */
  function pin(packets: FakePacketSource): () => void {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    packets.beforeYield = (): Promise<void> => held;
    return () => {
      packets.beforeYield = null;
      release();
    };
  }

  /** Runs every queued microtask, so a parked reader has reached its gate. */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  it("playback continues across a scrub that re-anchors mid-walk", async () => {
    const { session, packets } = openSession();
    const play = session.framesFrom(1.0);
    const started = await play.next();

    // Park the scrub after it has re-anchored: at that point it has reset
    // the decoder and dropped every decoded frame, which is the state a
    // drag leaves the session in while playback is still holding a walk.
    const release = pin(packets);
    const scrub = session.frameAt(0.2);
    await settle();
    const continued = play.next();
    await settle();
    release();
    const [next, scrubbed] = await Promise.all([continued, scrub]);

    expect(MS(started.value?.timestamp ?? -1)).toBe(1000);
    expect(MS(scrubbed?.timestamp ?? -1)).toBe(200);
    expect(next.done).toBe(false);
    expect(MS(next.value?.timestamp ?? -1)).toBe(1067);
  });

  it("playback continues across a scrub that lands past the anchor span", async () => {
    const { session } = openSession();
    const play = session.framesFrom(1.0);
    await play.next();

    // 5.0 is outside the span the walk is anchored in, so it re-anchors and
    // leaves the decoder four seconds ahead of the playhead.
    await session.frameAt(5.0);
    const next = await play.next();

    expect(next.done).toBe(false);
    expect(MS(next.value?.timestamp ?? -1)).toBe(1067);
  });

  it("a scrub lands on its own target while playback holds a walk open", async () => {
    const { session, packets } = openSession();
    const play = session.framesFrom(0.5);
    await play.next();

    const release = pin(packets);
    const scrub = session.frameAt(3.0);
    await settle();
    const continued = play.next();
    await settle();
    release();
    const [next, landed] = await Promise.all([continued, scrub]);

    expect(MS(landed?.timestamp ?? -1)).toBe(3000);
    expect(MS(next.value?.timestamp ?? -1)).toBe(533);
  });
});

/**
 * An open GOP, as most encoders emit one: the container's sync table names five
 * entry points and only the first is an IDR. Two of the other four are followed
 * by a reference picture that names pictures from before them, which a decoder
 * opened at that sync sample never decoded, and Chromium answers that with a
 * fatal decode error and no frames.
 *
 * Measured on `gop-open.mp4` and `combo-open-gop-pyramid-2997-90k.mp4`: sync
 * samples at 0s, 2s, 4s, 6s and 8s, of which 2s and 6s are the ones a fresh
 * decoder cannot open.
 */
describe("DecodeSession open GOP", () => {
  const OPEN_GOP_FPS = 30;
  const OPEN_GOP_FRAME_S = 1 / OPEN_GOP_FPS;
  const OPEN_GOP_FRAMES = 300;
  const SYNC_EVERY = 60;
  /** Sync samples whose next reference picture names a picture from before
   *  them, in frame indices: 2s and 6s at 30fps. */
  const UNOPENABLE = new Set([60, 180]);
  /** How far back that picture reaches, in frames. */
  const REACH_BACK = 4;
  const PREFIX_WIDTH = 4;
  const NO_REFERENCE = 0xffff;

  /** One access unit, AVCC-framed: a slice NAL whose header says whether it is
   *  an IDR, carrying the index of the earliest picture it references. */
  function accessUnit(index: number): Uint8Array {
    const idr = index === 0;
    // Every sync sample is an intra picture and predicts from nothing; only
    // the first is an IDR, so only the first empties the reference list.
    const refsFrom =
      index % SYNC_EVERY === 0
        ? NO_REFERENCE
        : UNOPENABLE.has(index - 1)
          ? index - 1 - REACH_BACK
          : index - 1;
    const nal = Uint8Array.of(
      idr ? 0x65 : 0x41,
      (refsFrom >> 8) & 0xff,
      refsFrom & 0xff,
    );
    const unit = new Uint8Array(PREFIX_WIDTH + nal.length);
    unit[3] = nal.length;
    unit.set(nal, PREFIX_WIDTH);
    return unit;
  }

  /** The slice NAL of an access unit, skipping whatever the session prepended
   *  to make the chunk a legal entry point. */
  function sliceOf(bytes: Uint8Array): Uint8Array | null {
    let offset = 0;
    while (offset + PREFIX_WIDTH <= bytes.length) {
      const length =
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
      const unit = bytes.subarray(
        offset + PREFIX_WIDTH,
        offset + PREFIX_WIDTH + length,
      );
      const type = unit[0] & 0x1f;
      if (type === 1 || type === 5) return unit;
      offset += PREFIX_WIDTH + length;
    }
    return null;
  }

  function openGopPackets(): EncodedPacketLike[] {
    return Array.from({ length: OPEN_GOP_FRAMES }, (_, i) => ({
      data: accessUnit(i),
      type: i % SYNC_EVERY === 0 ? ("key" as const) : ("delta" as const),
      timestamp: i * OPEN_GOP_FRAME_S,
      duration: OPEN_GOP_FRAME_S,
    }));
  }

  class OpenGopPacketSource implements PacketSource {
    readonly keyProbes: Array<{
      timestamp: number;
      options?: PacketRetrievalOptionsLike;
    }> = [];
    private readonly all = openGopPackets();

    /** With verification on, only a true IDR answers; the container's own sync
     *  table answers otherwise, which is the mediabunny contract the session
     *  reads both anchors through. */
    private keysUpTo(
      timestamp: number,
      verify: boolean | undefined,
    ): EncodedPacketLike[] {
      return this.all.filter(
        (p) =>
          p.type === "key" &&
          p.timestamp <= timestamp + 1e-9 &&
          (!verify || (p.data[PREFIX_WIDTH] & 0x1f) === 5),
      );
    }

    async getKeyPacket(
      timestamp: number,
      options?: PacketRetrievalOptionsLike,
    ): Promise<EncodedPacketLike | null> {
      this.keyProbes.push({ timestamp, options });
      const keys = this.keysUpTo(timestamp, options?.verifyKeyPackets);
      return keys.length ? read(keys[keys.length - 1], options) : null;
    }

    async getNextKeyPacket(
      packet: EncodedPacketLike,
      options?: PacketRetrievalOptionsLike,
    ): Promise<EncodedPacketLike | null> {
      const next = this.all.find(
        (p) => p.type === "key" && p.timestamp > packet.timestamp + 1e-9,
      );
      return next ? read(next, options) : null;
    }

    async *packets(
      startPacket?: EncodedPacketLike,
    ): AsyncGenerator<EncodedPacketLike, void, unknown> {
      const from = startPacket
        ? this.all.findIndex((p) => p.timestamp >= startPacket.timestamp - 1e-9)
        : 0;
      for (let i = from; i < this.all.length; i++) yield read(this.all[i]);
    }
  }

  /**
   * Decodes what it can reconstruct. A chunk naming a picture from before the
   * one the decode opened at has nothing to predict from, so the decoder
   * reports a fatal error and takes nothing further, exactly as a WebCodecs
   * decoder does once it has errored.
   */
  class OpenGopDecoder implements VideoDecoderLike {
    readonly chunks: EncodedVideoChunkInit[] = [];
    errors = 0;
    private openedAtIndex = Number.POSITIVE_INFINITY;
    /** Set the moment the failure is reported, not the moment it happens: a
     *  WebCodecs decode is acknowledged synchronously and answered on the codec
     *  thread, so chunks submitted in between are taken and produce nothing. */
    private dead = false;
    private failing = false;
    private readonly output: (frame: VideoFrame) => void;
    private readonly error: (error: DOMException) => void;

    constructor(init: VideoDecoderInit) {
      this.output = init.output;
      this.error = init.error as (error: DOMException) => void;
    }

    configure(): void {}

    decode(chunk: EncodedVideoChunkInit): void {
      if (this.dead) throw new DOMException("closed", "InvalidStateError");
      this.chunks.push(chunk);
      const index = Math.round((chunk.timestamp / 1e6) * OPEN_GOP_FPS);
      if (chunk.type === "key") this.openedAtIndex = index;
      const slice = sliceOf(chunk.data as Uint8Array);
      const refsFrom = ((slice?.[1] ?? 0) << 8) | (slice?.[2] ?? 0);
      if (refsFrom !== NO_REFERENCE && refsFrom < this.openedAtIndex) {
        this.failing = true;
        this.errors += 1;
        queueMicrotask(() => {
          this.dead = true;
          this.error(new DOMException("Decoding error.", "EncodingError"));
        });
        return;
      }
      if (this.failing) return;
      const frame = {
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 0,
        close: () => undefined,
      };
      queueMicrotask(() => {
        if (!this.dead) this.output(frame as unknown as VideoFrame);
      });
    }

    async flush(): Promise<void> {}
    reset(): void {}
    close(): void {}
  }

  function openGopSession(): {
    session: DecodeSession;
    packets: OpenGopPacketSource;
    decoders: OpenGopDecoder[];
  } {
    const packets = new OpenGopPacketSource();
    const decoders: OpenGopDecoder[] = [];
    const session = new DecodeSession({
      packets,
      config: CONFIG,
      createDecoder: (init) => {
        const decoder = new OpenGopDecoder(init);
        decoders.push(decoder);
        return decoder;
      },
      outputTimeoutMs: 200,
      rotation: 0,
    });
    return { session, packets, decoders };
  }

  const ANCHORS_S = [0, 2, 4, 6, 8];

  it("every sync sample paints, including the ones no decoder can open at", async () => {
    const { session } = openGopSession();

    const landed: Array<number | null> = [];
    for (const anchorS of ANCHORS_S) {
      const frame = await session.frameAt(anchorS);
      landed.push(frame ? Math.round(frame.timestamp * 1000) : null);
      frame?.close();
    }

    expect(landed).toEqual([0, 2000, 4000, 6000, 8000]);
  });

  it("a failed entry point condemns itself, not the session", async () => {
    const { session, decoders } = openGopSession();

    // 2s is one of the two that cannot be opened at, and 4s is a healthy one
    // after it.
    await (await session.frameAt(2))?.close();
    const afterFailure = await session.frameAt(4);

    expect(Math.round(afterFailure?.timestamp ?? -1)).toBe(4);
    expect(decoders.filter((d) => d.errors > 0)).toHaveLength(1);
    afterFailure?.close();
  });

  it("the unopenable entry point is entered from the previous IDR", async () => {
    const { session, packets } = openGopSession();

    const frame = await session.frameAt(6);

    // The container's table answered first; when that answer decoded nothing
    // the anchor is resolved again, reads its own entry point struck off, and
    // asks the bitstream for the last IDR instead.
    expect(packets.keyProbes.map((p) => p.options?.verifyKeyPackets)).toEqual([
      false,
      false,
      true,
    ]);
    expect(Math.round(frame?.timestamp ?? -1)).toBe(6);
    frame?.close();
  });

  it("a re-seek into a condemned GOP does not re-open at the entry point that failed", async () => {
    const { session, decoders } = openGopSession();

    (await session.frameAt(6))?.close();
    (await session.frameAt(0))?.close();
    const landed = await session.frameAt(6);

    // Struck off for good: coming back reads the sync table, sees the entry
    // point rejected, and enters from the IDR without spending another decode
    // error to learn that again.
    expect(Math.round(landed?.timestamp ?? -1)).toBe(6);
    expect(decoders.reduce((n, d) => n + d.errors, 0)).toBe(1);
    landed?.close();
  });

  it("a forward seek inside a recovered span costs no second recovery", async () => {
    const { session, packets, decoders } = openGopSession();

    (await session.frameAt(6))?.close();
    const probesAfterRecovery = packets.keyProbes.length;
    const landed = await session.frameAt(6.5);

    // The span the pre-roll bought runs to the next entry point still worth
    // anchoring at, so the walk continues rather than starting over.
    expect(Math.round((landed?.timestamp ?? -1) * 1000)).toBe(6500);
    expect(packets.keyProbes).toHaveLength(probesAfterRecovery);
    expect(decoders).toHaveLength(2);
    landed?.close();
  });

  it("a source whose only entry point is an unopenable IDR still stalls", async () => {
    const packets = new OpenGopPacketSource();
    const session = new DecodeSession({
      packets,
      config: CONFIG,
      createDecoder: (init) => {
        const decoder = new OpenGopDecoder(init);
        queueMicrotask(() =>
          (init.error as (e: DOMException) => void)(
            new DOMException("Decoding error.", "EncodingError"),
          ),
        );
        return decoder;
      },
      outputTimeoutMs: 200,
      rotation: 0,
    });

    await expect(session.frameAt(6)).rejects.toThrow(/reported an error/);
    await expect(session.frameAt(0)).rejects.toThrow(/reported an error/);
  });
});

describe("DecodeSession rotation", () => {
  it.each(QUARTER_TURNS)(
    "a %i-degree track's frames draw the way mediabunny's own sinks draw them",
    async (rotation) => {
      const { session } = openSession(0, rotation);
      const [width, height] = turnedSize(rotation);
      const recorder = new TransformRecorder();

      const sample = await session.frameAt(0.5);
      sample?.draw(recorder.asContext(), 0, 0, width, height);

      expect(recorder.cornersOver(width, height)).toEqual(
        paintedCorners(rotation),
      );
      sample?.close();
    },
  );

  it.each(QUARTER_TURNS)(
    "carries %i degrees on the frame, since toVideoFrame drops it",
    async (rotation) => {
      const { session } = openSession(0, rotation);

      const sample = await session.frameAt(0.5);

      expect(sample?.rotation).toBe(rotation);
      sample?.close();
    },
  );

  it("a track with no rotation metadata is drawn untouched", async () => {
    const { session } = openSession();
    const calls: unknown[][] = [];
    const context = {
      drawImage: (...args: unknown[]) => calls.push(args),
    } as unknown as OffscreenCanvasRenderingContext2D;

    const sample = await session.frameAt(0.5);
    sample?.draw(context, 0, 0, 640, 360);

    expect(sample?.rotation).toBe(0);
    expect(calls).toEqual([[expect.anything(), 0, 0, 640, 360]]);
    sample?.close();
  });
});
