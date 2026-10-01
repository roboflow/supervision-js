import {
  createDepthPreviewTrackReader,
  type DepthPreviewTrackOptions,
  type DepthPreviewTrackReader,
} from "../packages/web/src/media/depth-preview-track";
import type { TrackFrameIndex } from "../packages/web/src/media/mediabunny-frame-clock";

/**
 * How a fake decoder treats what it is fed, after the ways real ones do:
 *
 * - `outputs` returns each frame as soon as it is fed.
 * - `holdsUntilFlush` returns nothing until `flush()`, and then everything,
 *   which decoders that wait for more input do at the end of a short clip.
 * - `silent` returns nothing, and its `flush()` never settles.
 * - `refusesConfig` throws from `configure()`.
 *
 * Each takes only a key frame after `configure()` or `flush()`, as WebCodecs
 * requires.
 */
export type FakeDecoderBehaviour =
  "outputs" | "holdsUntilFlush" | "silent" | "refusesConfig";

/** A clip of `frameCount` frames, each decoding to `luma(index)`. */
export interface FakeDecoderClip {
  readonly frameCount: number;
  /** A key frame every this many frames. */
  readonly keyEvery: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly luma: (index: number) => Uint8Array;
}

/**
 * The depth preview probe as a fake clip: two 256x256 frames holding every
 * code `c` as a 16x16 block, decoded through `decode`.
 */
export function fakeProbeClip(
  decode: (code: number) => number = (code) => code,
): FakeDecoderClip {
  const luma = new Uint8Array(256 * 256);

  for (let code = 0; code < 256; code += 1) {
    const top = (code >> 4) * 16;
    const left = (code & 15) * 16;

    for (let y = top; y < top + 16; y += 1) {
      luma.fill(decode(code), y * 256 + left, y * 256 + left + 16);
    }
  }

  return {
    frameCount: 2,
    frameRate: 24,
    height: 256,
    keyEvery: 24,
    luma: () => luma,
    width: 256,
  };
}

export interface FakeDecoderLog {
  readonly configured: (HardwareAcceleration | undefined)[];
  created: number;
  fed: number;
  flushes: number;
  /** Frames handed to `output`. */
  outputs: number;
}

/** A constant-rate track from zero with a key frame every `keyEvery` frames. */
export function uniformTrackFrameIndex(
  frameCount: number,
  frameRate: number,
  keyEvery: number,
): TrackFrameIndex {
  const times = Float64Array.from(
    { length: frameCount },
    (_, index) => index / frameRate,
  );

  return {
    keyIndices: Int32Array.from(
      { length: Math.ceil(frameCount / keyEvery) },
      (_, key) => key * keyEvery,
    ),
    sourceTimes: times,
    times,
  };
}

/** A track reader over `clip`, decoding through a fake decoder. */
export function openFakeDepthPreviewTrack(
  behaviour:
    | FakeDecoderBehaviour
    | ((options: DepthPreviewTrackOptions) => FakeDecoderBehaviour),
  clip: FakeDecoderClip,
  options: DepthPreviewTrackOptions = {},
  log: FakeDecoderLog = createFakeDecoderLog(),
): DepthPreviewTrackReader {
  const timeline = uniformTrackFrameIndex(
    clip.frameCount,
    clip.frameRate,
    clip.keyEvery,
  );

  return createDepthPreviewTrackReader({
    VideoDecoder: createFakeDecoderClass(
      typeof behaviour === "function" ? behaviour(options) : behaviour,
      clip,
      timeline,
      log,
    ),
    config: {
      codec: "avc1.64001f",
      hardwareAcceleration: options.hardwareAcceleration,
    },
    copier: options.copier,
    correction: options.correction,
    height: clip.height,
    packetSink: createFakePacketSink(timeline) as never,
    timeline,
    width: clip.width,
  });
}

export function createFakeDecoderLog(): FakeDecoderLog {
  return { configured: [], created: 0, fed: 0, flushes: 0, outputs: 0 };
}

interface FakeChunk {
  readonly timestamp: number;
  readonly type: "key" | "delta";
}

function createFakePacketSink(timeline: TrackFrameIndex) {
  const keys = new Set(timeline.keyIndices);
  const packet = (index: number) => ({
    index,
    timestamp: timeline.sourceTimes[index],
    type: keys.has(index) ? "key" : "delta",
    toEncodedVideoChunk: (): FakeChunk => ({
      timestamp: Math.trunc(timeline.sourceTimes[index] * 1_000_000),
      type: keys.has(index) ? "key" : "delta",
    }),
  });

  return {
    async getKeyPacket(time: number) {
      let index = 0;

      for (const key of timeline.keyIndices) {
        if (timeline.sourceTimes[key] <= time + 1e-9) index = key;
      }
      return packet(index);
    },
    async getFirstKeyPacket() {
      return packet(0);
    },
    async *packets(start?: { index: number }) {
      for (
        let index = start?.index ?? 0;
        index < timeline.times.length;
        index += 1
      ) {
        yield packet(index);
      }
    },
  };
}

function createFakeDecoderClass(
  behaviour: FakeDecoderBehaviour,
  clip: FakeDecoderClip,
  timeline: TrackFrameIndex,
  log: FakeDecoderLog,
): typeof VideoDecoder {
  class FakeVideoDecoder {
    state: CodecState = "unconfigured";
    decodeQueueSize = 0;
    private needsKey = true;
    private held: number[] = [];

    constructor(
      private readonly init: {
        output: (frame: VideoFrame) => void;
        error: (error: DOMException) => void;
      },
    ) {
      log.created += 1;
    }

    configure(config: VideoDecoderConfig) {
      if (behaviour === "refusesConfig") {
        throw new DOMException(
          "No decoder takes this configuration.",
          "NotSupportedError",
        );
      }
      log.configured.push(config.hardwareAcceleration);
      this.state = "configured";
      this.needsKey = true;
    }

    decode(chunk: FakeChunk) {
      if (this.state !== "configured") {
        throw new DOMException("Not configured.", "InvalidStateError");
      }
      if (this.needsKey && chunk.type !== "key") {
        throw new DOMException(
          "A key frame is required after configure() or flush().",
          "DataError",
        );
      }
      this.needsKey = false;
      log.fed += 1;
      if (behaviour === "silent") return;
      if (behaviour === "holdsUntilFlush") {
        this.held.push(chunk.timestamp);
        return;
      }
      queueMicrotask(() => this.emit(chunk.timestamp));
    }

    flush(): Promise<void> {
      log.flushes += 1;
      if (behaviour === "silent") return new Promise(() => undefined);

      for (const timestamp of this.held.splice(0)) this.emit(timestamp);
      this.needsKey = true;
      return Promise.resolve();
    }

    reset() {
      this.held = [];
      this.state = "unconfigured";
    }

    close() {
      this.held = [];
      this.state = "closed";
    }

    private emit(timestamp: number) {
      if (this.state !== "configured") return;

      const index = timeline.sourceTimes.findIndex(
        (time) => Math.abs(time - timestamp / 1_000_000) < 1e-6,
      );

      log.outputs += 1;
      this.init.output(
        createFakeFrame(timestamp, clip.luma(index), clip) as never,
      );
    }
  }

  return FakeVideoDecoder as unknown as typeof VideoDecoder;
}

function createFakeFrame(
  timestamp: number,
  luma: Uint8Array,
  clip: FakeDecoderClip,
) {
  const { height, width } = clip;

  return {
    codedHeight: height,
    codedWidth: width,
    format: "I420",
    timestamp,
    visibleRect: { height, width, x: 0, y: 0 },
    allocationSize: () => width * height * 2,
    async copyTo(destination: ArrayBuffer) {
      new Uint8Array(destination).set(luma);
      return [{ offset: 0, stride: width }];
    },
    close: () => undefined,
  };
}
