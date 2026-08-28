import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedVideoSample, DecodedVideoSampleSink } from "supervision";

import {
  UploadedMediaKind,
  extractInferenceFrameBatches,
  type PreparedUploadMedia,
} from "./upload-media";

const FRAME_RATE = 30;

const media = (frameCount: number): PreparedUploadMedia => ({
  blob: null,
  duration: frameCount / FRAME_RATE,
  frameCount,
  frameRate: FRAME_RATE,
  height: 4,
  kind: UploadedMediaKind.Video,
  sourceFile: null,
  statusLabel: "test upload",
  width: 4,
});

class RecordingContext {
  drawn: number | null = null;

  drawImage() {}
}

/** Enough of the encode path for the extractor: the canvas hands back whatever
 *  the sample it last drew declared, so an encoded frame is traceable to it. */
class FakeCanvas {
  readonly context = new RecordingContext();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext() {
    return this.context;
  }

  async convertToBlob() {
    return new Blob([String(this.context.drawn)]);
  }
}

function installEncodeGlobals() {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(width: number, height: number) {
        return new FakeCanvas(width, height);
      }
    },
  );
  vi.stubGlobal(
    "FileReader",
    class {
      result: string | null = null;
      private readonly listeners = new Map<string, () => void>();

      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, listener);
      }

      readAsDataURL(blob: Blob) {
        void blob.text().then((text) => {
          this.result = `data:image/jpeg;base64,${btoa(text)}`;
          this.listeners.get("load")?.();
        });
      }
    },
  );
}

interface RecordingSink extends DecodedVideoSampleSink {
  /** One pass is one walk over the track: a seek plus a GOP decode. */
  readonly passes: number[][];
  readonly singleGrabs: number[];
}

function createSample(timestamp: number): DecodedVideoSample {
  const context = { drawn: timestamp };

  return {
    close() {},
    draw(target) {
      (target as unknown as RecordingContext).drawn = context.drawn;
    },
    duration: 1 / FRAME_RATE,
    timestamp,
  };
}

/**
 * A decoder answers with the frame being displayed at the requested time, not a
 * frame minted at that time, so a request lands on the clip's own grid and the
 * sample carries that grid's duration.
 */
function createNativeGridSink(nativeFrameRate: number): DecodedVideoSampleSink {
  const nativeDuration = 1 / nativeFrameRate;

  return {
    async getSample(timestamp) {
      return snapped(timestamp);
    },
    async *samples() {},
    async *samplesAtTimestamps(timestamps) {
      for (const timestamp of timestamps) {
        yield snapped(timestamp);
      }
    },
  };

  function snapped(timestamp: number): DecodedVideoSample {
    const displayTime =
      Math.floor(timestamp / nativeDuration + 1e-9) * nativeDuration;

    return {
      close() {},
      draw(target) {
        (target as unknown as RecordingContext).drawn = displayTime;
      },
      duration: nativeDuration,
      timestamp: displayTime,
    };
  }
}

function createSink(options: { batched: boolean; missing?: number }) {
  const passes: number[][] = [];
  const singleGrabs: number[] = [];
  const sampleAt = (timestamp: number, index: number) =>
    index === options.missing ? null : createSample(timestamp);

  const sink: RecordingSink = {
    async getSample(timestamp) {
      singleGrabs.push(timestamp);
      passes.push([timestamp]);
      return sampleAt(timestamp, singleGrabs.length - 1);
    },
    async *samples() {},
    passes,
    singleGrabs,
  };

  if (options.batched) {
    let grabbed = 0;
    sink.samplesAtTimestamps = async function* (timestamps) {
      const requested = [...timestamps];
      passes.push(requested);

      for (const timestamp of requested) {
        yield sampleAt(timestamp, grabbed);
        grabbed += 1;
      }
    };
  }

  return sink;
}

async function collect(
  sink: DecodedVideoSampleSink,
  frameCount: number,
  batchSize = 30,
) {
  const batches = [];

  for await (const batch of extractInferenceFrameBatches({
    batchSize,
    media: media(frameCount),
    sampleSink: sink,
  })) {
    batches.push(batch);
  }

  return batches;
}

describe("extractInferenceFrameBatches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes a whole batch in one pass over the track", async () => {
    installEncodeGlobals();
    const sink = createSink({ batched: true });

    await collect(sink, 30);

    expect(sink.passes).toHaveLength(1);
    expect(sink.passes[0]).toHaveLength(30);
    expect(sink.singleGrabs).toEqual([]);
  });

  it("takes one pass per batch across a longer clip", async () => {
    installEncodeGlobals();
    const sink = createSink({ batched: true });

    const batches = await collect(sink, 75);

    expect(sink.passes.map((pass) => pass.length)).toEqual([30, 30, 15]);
    expect(batches.map((batch) => batch.length)).toEqual([30, 30, 15]);
  });

  it("numbers frames on the synthetic grid and encodes the sample it drew", async () => {
    installEncodeGlobals();
    const sink = createSink({ batched: true });

    const batches = await collect(sink, 4, 2);

    expect(batches.flat().map((frame) => frame.frameIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(batches.flat().map((frame) => frame.mediaTime)).toEqual([
      0.5 / FRAME_RATE,
      1.5 / FRAME_RATE,
      2.5 / FRAME_RATE,
      3.5 / FRAME_RATE,
    ]);
    expect(batches.flat().map((frame) => atob(frame.imageBase64))).toEqual([
      String(0.5 / FRAME_RATE),
      String(1.5 / FRAME_RATE),
      String(2.5 / FRAME_RATE),
      String(3.5 / FRAME_RATE),
    ]);
  });

  it("blames the frame a gap in the batch belongs to", async () => {
    installEncodeGlobals();
    const sink = createSink({ batched: true, missing: 2 });

    await expect(collect(sink, 4, 4)).rejects.toThrowError(
      "Unable to decode uploaded frame #2.",
    );
  });

  it("grabs one frame at a time from a source with no batch entry", async () => {
    installEncodeGlobals();
    const sink = createSink({ batched: false });

    const batches = await collect(sink, 4, 2);

    expect(sink.singleGrabs).toHaveLength(4);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2]);
  });

  it.each([
    ["59.94fps, faster than the grid", 60000 / 1001],
    ["60fps", 60],
    ["30fps, the grid itself", 30],
    ["23.976fps, slower than the grid", 24000 / 1001],
  ])("declares coverage that meets the next sample at %s", async (_, fps) => {
    installEncodeGlobals();
    const sink = createNativeGridSink(fps);

    const frames = (await collect(sink, 90)).flat();

    for (const [index, frame] of frames.slice(0, -1).entries()) {
      expect(frame.mediaTime + frame.duration).toBeGreaterThanOrEqual(
        frames[index + 1].mediaTime - 1e-6,
      );
    }
  });
});
