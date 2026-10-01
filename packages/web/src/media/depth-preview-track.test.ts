import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFakeDecoderLog,
  openFakeDepthPreviewTrack,
  type FakeDecoderClip,
} from "../../../../test/fake-video-decoder";
import {
  createDepthPreviewTrackReader,
  FLUSH_SILENCE_MILLISECONDS,
  readDepthPreviewTimeline,
  type DepthPreviewTimeline,
} from "./depth-preview-track";

const WIDTH = 8;
const HEIGHT = 4;
const FPS = 24;

describe("readDepthPreviewTimeline", () => {
  it("puts frames in presentation order from the first one, with their key frames", () => {
    // Decode order of an IBBP stream: 0 3 1 2 6 4 5, key frames at 0 and 4.
    const ticks = [0, 3, 1, 2, 6, 4, 5].map((frame) => frame * 1000);
    const timeline = readDepthPreviewTimeline(
      ticks.map((tick) => ({
        durationTicks: 1000,
        key: tick === 0 || tick === 4000,
        ticks: tick + 500,
      })),
      24000,
    );

    expect([...timeline.times]).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((frame) => (frame * 1000) / 24000),
    );
    expect(timeline.sourceTimes[0]).toBeCloseTo(500 / 24000);
    expect([...timeline.keyIndices]).toEqual([0, 4]);
  });

  it("keeps one frame per instant and drops pre-roll that ends before zero, as the engine does", () => {
    const timeline = readDepthPreviewTimeline(
      [
        { durationTicks: 10, key: true, ticks: -20 },
        { durationTicks: 10, key: false, ticks: -10 },
        { durationTicks: 10, key: false, ticks: 0 },
        { durationTicks: 10, key: true, ticks: 0 },
        { durationTicks: 10, key: false, ticks: 10 },
      ],
      100,
    );

    expect([...timeline.times]).toEqual([0, 0.1]);
    expect([...timeline.keyIndices]).toEqual([0]);
  });

  it("refuses a track with nothing presented", () => {
    expect(() =>
      readDepthPreviewTimeline(
        [{ durationTicks: 10, key: true, ticks: -10 }],
        100,
      ),
    ).toThrow(RangeError);
  });
});

describe("depth preview track reader", () => {
  afterEach(() => {
    FakeDecoder.instances.length = 0;
  });

  it("decodes from the key frame before the asked frame and hands back its luma plane", async () => {
    const { reader, sink } = createReader({ frameCount: 48, keyEvery: 24 });
    const run = reader.decode(30);
    const first = await run.next();

    expect(sink.keyLookups).toEqual([timeline(48, 24).sourceTimes[30]]);
    expect(first?.index).toBe(24);
    expect(first?.width).toBe(WIDTH);
    expect([...first!.luma]).toEqual(expectedLuma(24));
    expect(reader.getStats().lumaPath).toBe("plane");
    run.cancel();
    reader.dispose();
  });

  it("reads rows of a plane wider than the frame", async () => {
    const { reader } = createReader({ frameCount: 4, stride: WIDTH + 8 });
    const frame = await reader.decode(0).next();

    expect([...frame!.luma]).toEqual(expectedLuma(0));
    reader.dispose();
  });

  it("takes green from a frame the browser hands over in RGB, and says so", async () => {
    const { reader } = createReader({ format: "BGRX", frameCount: 4 });
    const frame = await reader.decode(0).next();

    expect([...frame!.luma]).toEqual(expectedLuma(0));
    expect(reader.getStats().lumaPath).toBe("rgb");
    reader.dispose();
  });

  it("maps codes through a correction table", async () => {
    const correction = Uint8Array.from({ length: 256 }, (_, code) =>
      Math.min(255, code + 1),
    );
    const { reader } = createReader({ correction, frameCount: 4 });
    const frame = await reader.decode(0).next();

    expect([...frame!.luma]).toEqual(expectedLuma(0).map((code) => code + 1));
    reader.dispose();
  });

  it("hands frames to a copier that takes them, and copies on the page those it declines", async () => {
    let declined = 0;
    const copier = {
      copy: (frame: VideoFrame) => {
        if ((frame as unknown as FakeFrame).timestamp === 0) {
          declined += 1;
          return null;
        }
        frame.close();
        return Promise.resolve({
          busyMs: 0,
          height: HEIGHT,
          luma: new Uint8Array(WIDTH * HEIGHT).fill(99),
          path: "plane" as const,
          width: WIDTH,
        });
      },
      destroy: () => undefined,
      offMainThread: true,
    };
    const { reader } = createReader({ copier, frameCount: 4 });
    const run = reader.decode(0);
    const first = await run.next();
    const second = await run.next();

    expect(declined).toBe(1);
    expect([...first!.luma]).toEqual(expectedLuma(0));
    expect(second!.luma[0]).toBe(99);
    reader.dispose();
  });

  it("closes frames it is told not to keep without copying them", async () => {
    const { reader } = createReader({ frameCount: 8 });
    const run = reader.decode(0, { keep: (index) => index >= 3 });
    const frame = await run.next();

    expect(frame?.index).toBe(3);
    expect(reader.getStats().framesSkipped).toBe(3);
    expect(FakeFrame.copied).not.toContain(0);
    run.cancel();
    await settle();
    expect(FakeFrame.open).toBe(0);
    reader.dispose();
  });

  it("restarts by resetting its one decoder, never by opening a second", async () => {
    const { reader } = createReader({ frameCount: 48, keyEvery: 12 });
    const first = reader.decode(0);

    await first.next();

    const second = reader.decode(30);

    expect(await first.next()).toBeNull();
    expect((await second.next())?.index).toBe(24);
    expect(FakeDecoder.instances).toHaveLength(1);
    expect(FakeDecoder.instances[0].resets).toBe(1);
    expect(reader.getStats()).toMatchObject({
      decodersCreated: 1,
      liveDecoders: 1,
      runsStarted: 2,
    });
    reader.dispose();
    expect(FakeDecoder.instances[0].state).toBe("closed");
    expect(reader.getStats().liveDecoders).toBe(0);
  });

  it("lets a cancelled run go at once, whatever read it was waiting on", async () => {
    const { reader, sink } = createReader({ frameCount: 8 });
    let release: () => void = () => undefined;

    sink.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = reader.decode(0);
    const pending = run.next();

    run.cancel();
    await expect(pending).resolves.toBeNull();
    release();
    reader.dispose();
  });

  it("flushes at the end of the track and then reports the end", async () => {
    const { reader } = createReader({ frameCount: 3, holdOutputs: 2 });
    const run = reader.decode(0);
    const indices: number[] = [];

    for (let frame = await run.next(); frame; frame = await run.next()) {
      indices.push(frame.index);
    }

    expect(indices).toEqual([0, 1, 2]);
    expect(FakeDecoder.instances[0].flushes).toBe(1);
    reader.dispose();
  });

  it("fails the run on a decoder error and opens a fresh decoder for the next", async () => {
    const { reader } = createReader({ frameCount: 8 });
    const run = reader.decode(0);

    await run.next();
    FakeDecoder.instances[0].fail(new Error("decoder lost"));
    await expect(run.next()).rejects.toThrow("decoder lost");
    expect(reader.getStats().liveDecoders).toBe(0);

    const next = reader.decode(0);

    expect((await next.next())?.index).toBe(0);
    expect(FakeDecoder.instances).toHaveLength(2);
    expect(reader.getStats().liveDecoders).toBe(1);
    reader.dispose();
  });

  it("flushes a decoder that holds every frame, at the next key frame, and loses none", async () => {
    const log = createFakeDecoderLog();
    const reader = openFakeDepthPreviewTrack(
      "holdsUntilFlush",
      clip({ frameCount: 60, keyEvery: 24 }),
      {},
      log,
    );
    const run = reader.decode(0);
    const indices: number[] = [];

    for (let frame = await run.next(); frame; frame = await run.next()) {
      indices.push(frame.index);
    }

    expect(indices).toEqual(Array.from({ length: 60 }, (_, index) => index));
    // Two flushes before key frames 24 and 48, so the decoder is handed a
    // key frame after each, and one at the end.
    expect(log.flushes).toBe(3);
    reader.dispose();
  });

  it("fails a run whose decoder never finishes a flush", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    try {
      const reader = openFakeDepthPreviewTrack(
        "silent",
        clip({ frameCount: 2, keyEvery: 24 }),
      );
      const failed = expect(reader.decode(0).next()).rejects.toThrow(
        "The depth preview decoder returned no frame for 3 s of a flush.",
      );

      await vi.advanceTimersByTimeAsync(FLUSH_SILENCE_MILLISECONDS + 100);
      await failed;
      reader.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a run at once when the decoder will not take its configuration", () => {
    const reader = openFakeDepthPreviewTrack(
      "refusesConfig",
      clip({ frameCount: 2, keyEvery: 24 }),
    );

    expect(() => reader.decode(0)).toThrow(
      "No decoder takes this configuration.",
    );
    reader.dispose();
  });

  it("never keeps more than a few frames in flight in the decoder", async () => {
    const { reader } = createReader({ frameCount: 200, holdOutputs: 1000 });
    const run = reader.decode(0);
    const next = run.next();

    await settle(20);
    expect(FakeDecoder.instances[0].fed).toBeLessThanOrEqual(24);
    run.cancel();
    await next;
    reader.dispose();
  });
});

function clip(options: {
  frameCount: number;
  keyEvery: number;
}): FakeDecoderClip {
  return {
    ...options,
    frameRate: FPS,
    height: HEIGHT,
    luma: (index) => Uint8Array.from(expectedLuma(index)),
    width: WIDTH,
  };
}

function timeline(frameCount: number, keyEvery: number): DepthPreviewTimeline {
  return readDepthPreviewTimeline(
    Array.from({ length: frameCount }, (_, index) => ({
      durationTicks: 1,
      key: index % keyEvery === 0,
      ticks: index,
    })),
    FPS,
  );
}

function expectedLuma(index: number) {
  return Array.from(
    { length: WIDTH * HEIGHT },
    (_, pixel) => (index * 7 + pixel) & 0xff,
  );
}

function settle(turns = 4) {
  return new Promise((resolve) => setTimeout(resolve, turns));
}

interface ReaderOptions {
  readonly frameCount: number;
  readonly keyEvery?: number;
  readonly format?: string;
  readonly stride?: number;
  readonly correction?: Uint8Array;
  readonly copier?: Parameters<
    typeof createDepthPreviewTrackReader
  >[0]["copier"];
  /** Frames the decoder holds before it outputs the first one. */
  readonly holdOutputs?: number;
}

function createReader(options: ReaderOptions) {
  const keyEvery = options.keyEvery ?? 1000;
  const line = timeline(options.frameCount, keyEvery);
  const sink = new FakePacketSink(line);

  FakeFrame.copied = [];
  FakeFrame.open = 0;
  FakeDecoder.frameOptions = {
    format: options.format ?? "I420",
    holdOutputs: options.holdOutputs ?? 0,
    stride: options.stride ?? WIDTH,
    timeline: line,
  };

  const reader = createDepthPreviewTrackReader({
    VideoDecoder: FakeDecoder as unknown as typeof VideoDecoder,
    config: { codec: "avc1.64001f" },
    copier: options.copier,
    correction: options.correction,
    height: HEIGHT,
    packetSink: sink as unknown as Parameters<
      typeof createDepthPreviewTrackReader
    >[0]["packetSink"],
    timeline: line,
    width: WIDTH,
  });

  return { reader, sink };
}

interface FakePacket {
  readonly index: number;
  readonly timestamp: number;
  toEncodedVideoChunk(): { timestamp: number };
}

class FakePacketSink {
  keyLookups: number[] = [];
  gate: Promise<void> | null = null;

  constructor(private readonly line: DepthPreviewTimeline) {}

  private packet(index: number): FakePacket {
    const timestamp = this.line.sourceTimes[index];

    return {
      index,
      timestamp,
      toEncodedVideoChunk: () => ({
        timestamp: Math.trunc(timestamp * 1_000_000),
      }),
    };
  }

  async getKeyPacket(time: number) {
    this.keyLookups.push(time);

    let index = 0;

    for (const key of this.line.keyIndices) {
      if (this.line.sourceTimes[key] <= time + 1e-9) index = key;
    }

    return this.packet(index) as never;
  }

  async getFirstKeyPacket() {
    return this.packet(0) as never;
  }

  async *packets(start?: FakePacket) {
    for (
      let index = start?.index ?? 0;
      index < this.line.times.length;
      index += 1
    ) {
      if (this.gate) await this.gate;
      yield this.packet(index) as never;
    }
  }
}

class FakeFrame {
  static copied: number[] = [];
  static open = 0;
  readonly codedWidth = WIDTH;
  readonly codedHeight = HEIGHT;
  readonly visibleRect = { height: HEIGHT, width: WIDTH, x: 0, y: 0 };
  closed = false;

  constructor(
    readonly timestamp: number,
    readonly format: string,
    private readonly stride: number,
    private readonly index: number,
  ) {
    FakeFrame.open += 1;
  }

  allocationSize() {
    return this.format === "I420"
      ? this.stride * HEIGHT * 2
      : WIDTH * HEIGHT * 4;
  }

  async copyTo(destination: ArrayBuffer) {
    const bytes = new Uint8Array(destination);
    const luma = expectedLuma(this.index);

    FakeFrame.copied.push(this.index);
    if (this.format === "I420") {
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          bytes[y * this.stride + x] = luma[y * WIDTH + x];
        }
      }
      return [{ offset: 0, stride: this.stride }];
    }
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
      bytes[pixel * 4] = 1;
      bytes[pixel * 4 + 1] = luma[pixel];
      bytes[pixel * 4 + 2] = 2;
    }
    return [{ offset: 0, stride: WIDTH * 4 }];
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    FakeFrame.open -= 1;
  }
}

class FakeDecoder {
  static instances: FakeDecoder[] = [];
  static frameOptions: {
    format: string;
    holdOutputs: number;
    stride: number;
    timeline: DepthPreviewTimeline;
  };
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  decodeQueueSize = 0;
  resets = 0;
  flushes = 0;
  fed = 0;
  private held: number[] = [];
  private listeners: (() => void)[] = [];

  constructor(
    private readonly init: {
      output: (frame: FakeFrame) => void;
      error: (error: unknown) => void;
    },
  ) {
    FakeDecoder.instances.push(this);
  }

  addEventListener(_type: string, listener: () => void) {
    this.listeners.push(listener);
  }

  configure() {
    this.state = "configured";
  }

  decode(chunk: { timestamp: number }) {
    this.fed += 1;
    this.held.push(chunk.timestamp);
    if (this.held.length > FakeDecoder.frameOptions.holdOutputs) {
      const timestamp = this.held.shift()!;

      queueMicrotask(() => this.emit(timestamp));
    }
  }

  private emit(timestamp: number) {
    if (this.state !== "configured") return;

    const { format, stride, timeline: line } = FakeDecoder.frameOptions;
    const index = line.sourceTimes.findIndex(
      (time) => Math.abs(time - timestamp / 1_000_000) < 1e-6,
    );

    this.init.output(new FakeFrame(timestamp, format, stride, index));
    for (const listener of this.listeners) listener();
  }

  async flush() {
    this.flushes += 1;
    for (const timestamp of this.held.splice(0)) this.emit(timestamp);
  }

  reset() {
    this.resets += 1;
    this.held = [];
    this.state = "unconfigured";
  }

  close() {
    this.state = "closed";
  }

  fail(error: unknown) {
    this.state = "closed";
    this.init.error(error);
  }
}
