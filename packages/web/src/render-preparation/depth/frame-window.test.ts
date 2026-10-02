import { describe, expect, it, vi } from "vitest";
import type { DepthMap } from "supervision-js-core";

import type {
  DepthPreviewDecodeOptions,
  DepthPreviewDecodeRun,
  DepthPreviewLumaFrame,
} from "#media/depth-preview-track";
import {
  RenderPreparationArtifactKind,
  RenderPreparationGateHoldReason,
} from "#types/render-preparation";
import { createDepthFrameWindow, type DepthFrameSource } from "./frame-window";

const FPS = 10;
const FRAME_BYTES = 4;

const thresholds = (resumeAtSeconds: number, stopBelowSeconds = 0.1) => ({
  enabled: true,
  resumeAtSeconds,
  stopBelowSeconds,
});

describe("depth preview window", () => {
  it("decodes from the playhead to its prefetch target and stops there", async () => {
    const { source, window } = setup({ prefetchSeconds: 0.5 });

    window.setPlayhead(0);
    await source.drain();

    expect(source.starts).toEqual([0]);
    expect(stored(window, 0, 20)).toEqual([0, 1, 2, 3, 4]);
    expect(window.leadSeconds(0)).toBeCloseTo(0.5);
    expect(window.leadSeconds(2)).toBeCloseTo(0.3);
    expect(window.leadSeconds(9)).toBe(0);
  });

  it("keeps decoding as the playhead moves, and drops what falls behind the retained span", async () => {
    const { source, window } = setup({
      prefetchSeconds: 0.3,
      retainSeconds: 0.2,
    });

    window.setPlayhead(0);
    await source.drain();
    window.setPlayhead(5);
    await source.drain();

    expect(source.starts).toEqual([0, 5]);
    expect(stored(window, 0, 20)).toEqual([5, 6, 7]);

    window.setPlayhead(6);
    await source.drain();
    expect(source.starts).toEqual([0, 5]);
    expect(stored(window, 0, 20)).toEqual([5, 6, 7, 8]);
  });

  it("continues the run it has when the playhead lands inside its reach", async () => {
    const { source, window } = setup({ keyEvery: 10, prefetchSeconds: 0.3 });

    window.setPlayhead(0);
    await source.drain();
    window.setPlayhead(2);
    await source.drain();

    expect(source.starts).toEqual([0]);
    expect(stored(window, 0, 20)).toEqual([2, 3, 4]);
  });

  it("restarts at the key frame of a seek outside the run, cancelling the old one", async () => {
    const { source, window } = setup({ keyEvery: 10, prefetchSeconds: 0.2 });

    window.setPlayhead(0);
    await source.drain();
    window.setPlayhead(25);
    await source.drain();

    expect(source.starts).toEqual([0, 25]);
    expect(source.cancelled).toBe(1);
    expect(stored(window, 20, 30)).toEqual([25, 26]);
  });

  it("restarts for a gap behind the run instead of waiting for frames it passed", async () => {
    const { source, window } = setup({
      keyEvery: 4,
      prefetchSeconds: 0.5,
      retainSeconds: 0,
    });

    window.setPlayhead(8);
    await source.drain();
    window.setPlayhead(3);
    await source.drain();

    expect(source.starts).toEqual([8, 3]);
    expect(window.getEntry(3)).not.toBeNull();
  });

  it("holds no more bytes than its budget, dropping what is farthest ahead first", async () => {
    const { source, window } = setup({
      maxBytes: FRAME_BYTES * 4,
      prefetchSeconds: 2,
      retainSeconds: 0,
    });

    window.setPlayhead(0);
    await source.drain();
    expect(stored(window, 0, 30)).toEqual([0, 1, 2, 3]);

    window.setPlayhead(2);
    await source.drain();
    expect(stored(window, 0, 30)).toEqual([2, 3, 4, 5]);
  });

  it("asks for a frame not decoded yet to wait, and a short lead to wait until the resume lead", async () => {
    const { source, window } = setup({ gated: true, prefetchSeconds: 1 });

    window.setPlayhead(0);
    expect(window.needsPlaybackGateWait(0, thresholds(0.3))).toBe(true);

    let ready = false;
    const wait = window
      .waitForReady(0, thresholds(0.3), undefined)
      .then(() => (ready = true));

    await source.release(2);
    expect(ready).toBe(false);
    expect(window.getDiagnostics().gateHold).toMatchObject({
      reason: RenderPreparationGateHoldReason.LeadBelowRequirement,
    });

    await source.release(2);
    await wait;
    expect(ready).toBe(true);
    expect(window.needsPlaybackGateWait(0, thresholds(0.3))).toBe(false);
    expect(window.getDiagnostics()).toMatchObject({
      gateHold: null,
      gateHoldCount: 1,
      kind: RenderPreparationArtifactKind.DepthFrame,
    });
  });

  it("lets a wait go when its signal aborts, and never holds with the gate off", async () => {
    const { window } = setup({ gated: true });
    const abort = new AbortController();
    const wait = window.waitForReady(0, thresholds(1), abort.signal);

    abort.abort();
    await expect(wait).resolves.toBeUndefined();
    expect(
      window.needsPlaybackGateWait(0, { ...thresholds(1), enabled: false }),
    ).toBe(false);
  });

  it("asks a stop for no more lead than its budget can hold", async () => {
    const { source, window } = setup({
      maxBytes: FRAME_BYTES * 3,
      prefetchSeconds: 5,
      retainSeconds: 0,
    });

    await window.waitForReady(0, thresholds(2), undefined);
    await source.drain();

    expect(stored(window, 0, 30)).toEqual([0, 1, 2]);
    expect(window.needsPlaybackGateWait(0, thresholds(2, 2))).toBe(false);
  });

  it("hands the next decoded frames over for uploading ahead", async () => {
    const { source, window } = setup({ prefetchSeconds: 0.5 });

    window.setPlayhead(0);
    await source.drain();

    expect(window.upcoming(1, 2).map(({ index }) => index)).toEqual([2, 3]);
    expect(window.upcoming(0, 2, 2).map(({ index }) => index)).toEqual([2, 3]);
    expect(window.upcoming(4, 2)).toEqual([]);
  });

  it("stops and lets every wait go when the decoder fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { source, window } = setup({ failAt: 1, prefetchSeconds: 1 });
    const wait = window.waitForReady(0, thresholds(0.5), undefined);

    await source.drain();
    await wait;

    expect(window.failure).toBeInstanceOf(Error);
    expect(window.needsPlaybackGateWait(0, thresholds(0.5))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps every frame a run reaches back over while a drag heads backwards, so the next steps back start no run", async () => {
    const { source, window } = setup({ keyEvery: 10, prefetchSeconds: 1 });

    window.setScrubbing(true);
    for (const index of [55, 54, 53]) {
      window.setPlayhead(index);
      await source.drain();
    }
    expect(window.heading()).toBe(-1);

    const starts = source.starts.length;

    // 0.75 s behind 53 reaches 46, whose key frame is 40: 40 to 52 are in.
    expect(stored(window, 40, 52)).toEqual(range(40, 52));
    for (let index = 52; index >= 41; index -= 1) {
      window.setPlayhead(index);
      await source.drain();
      expect(window.getEntry(index)).not.toBeNull();
    }
    // Going back past 40 needs the key frame before it, once.
    expect(source.starts.length).toBe(starts + 1);
    expect(source.starts.at(-1)).toBeLessThan(40);
  });

  it("treats a drag forward in small steps as a drag, not as a playback cadence", async () => {
    const { source, window } = setup({ prefetchSeconds: 1 });

    window.setScrubbing(true);
    for (const index of [0, 2, 4, 6, 8, 10]) {
      window.setPlayhead(index);
      await source.drain();
    }

    // Every frame the hand may land on is kept, odd ones included.
    expect(stored(window, 10, 15)).toEqual(range(10, 15));
    expect(source.starts).toEqual([0]);
  });

  it("copies only the frames presents land on once playback moves a steady stride", async () => {
    const { source, window } = setup({ prefetchSeconds: 0.5 });

    for (let index = 0; index <= 16; index += 2) {
      window.setPlayhead(index);
      await source.drain();
    }

    // As many frames as 0.5 s holds, spread over a second: 16 to 24.
    expect(stored(window, 17, 40)).toEqual([18, 20, 22, 24]);
    expect(window.leadSeconds(16)).toBeCloseTo(1);
    expect(window.getDiagnostics()).toMatchObject({ prefetchCount: 5 });
  });

  it("copies every frame while presents move an uneven stride, and leads by how far they move", async () => {
    const { source, window } = setup({ prefetchSeconds: 0.5 });
    let index = 0;

    // 3.2 frames a present: 3, 3, 3, 3, 4, as 8x of 24 fps on 60 Hz moves.
    for (const step of [3, 3, 3, 3, 4, 3, 3, 3, 3, 4]) {
      index += step;
      window.setPlayhead(index);
      await source.drain();
    }

    // The last eight moved 3.25 frames on average, so 0.5 s of lead
    // stretches past 1.6 s: seventeen frames, every one kept.
    expect(stored(window, index, index + 16)).toEqual(range(index, index + 16));
    expect(window.getDiagnostics()).toMatchObject({ prefetchCount: 17 });
  });

  it("decodes past the last frame into the first when the clip loops", async () => {
    const { source, window } = setup({
      frameCount: 20,
      loop: true,
      prefetchSeconds: 0.5,
    });

    window.setPlayhead(17);
    await source.drain();

    expect(stored(window, 0, 19)).toEqual([0, 1, 17, 18, 19]);
    expect(window.leadSeconds(17)).toBeCloseTo(0.5);

    window.setLoop(false);
    expect(window.leadSeconds(17)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps a small margin at rest, and asks a step for its own frame only", async () => {
    const { source, window } = setup({ active: false, prefetchSeconds: 2 });

    window.setPlayhead(10);
    await source.drain();

    expect(stored(window, 0, 40)).toEqual([10, 11, 12]);
    // Nothing plays at rest, so no lead is owed.
    expect(window.needsPlaybackGateWait(10, thresholds(0.5))).toBe(false);
    expect(window.needsPlaybackGateWait(13, thresholds(0.5))).toBe(true);

    window.setPlaybackActive(true);
    await source.drain();
    expect(stored(window, 10, 40)).toEqual(range(10, 29));
  });

  it("fills behind a playhead stepped backwards at rest", async () => {
    const { source, window } = setup({
      active: false,
      keyEvery: 5,
      prefetchSeconds: 1,
      retainSeconds: 0.3,
    });

    for (const index of [12, 11, 10]) {
      window.setPlayhead(index);
      await source.drain();
    }

    expect(window.heading()).toBe(-1);
    expect(stored(window, 7, 9)).toEqual([7, 8, 9]);
  });

  it("decodes nothing while the page is hidden, and picks up where the playhead is when it shows", async () => {
    const { source, window } = setup({ gated: true, prefetchSeconds: 0.5 });

    window.setPlayhead(0);
    await source.release(2);
    window.setHidden(true);
    expect(source.cancelled).toBe(1);

    window.setPlayhead(30);
    await source.release(10);
    expect(stored(window, 0, 40)).toEqual([0, 1]);

    window.setHidden(false);
    await source.release(10);
    expect(stored(window, 30, 40)).toEqual([30, 31, 32, 33, 34]);
  });

  it("decodes a frame the gate waits on before anything else", async () => {
    const { source, window } = setup({ keyEvery: 10, prefetchSeconds: 0.5 });

    window.setScrubbing(true);
    window.setPlayhead(50);
    await source.drain();

    const wait = window.waitForReady(47, thresholds(0.3), undefined);

    await source.drain();
    await wait;
    expect(window.getEntry(47)).not.toBeNull();
  });

  it("keeps the frame the gate let through until the next one, however far the playhead jumps meanwhile", async () => {
    const { source, window } = setup({ active: false, keyEvery: 10 });

    await window.waitForReady(40, thresholds(0.3), undefined);
    // The next seek lands before frame 40 is presented.
    window.setPlayhead(80);
    await source.drain();
    expect(window.getEntry(40)).not.toBeNull();

    await window.waitForReady(80, thresholds(0.3), undefined);
    window.setPlayhead(81);
    await source.drain();
    expect(window.getEntry(40)).toBeNull();
    expect(window.getEntry(80)).not.toBeNull();
  });

  it("gives up on a frame its decoder never produces instead of restarting forever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { source, window } = setup({ missing: [0], prefetchSeconds: 0.3 });

    window.setPlayhead(0);
    await source.drain();

    expect(source.starts.length).toBeLessThanOrEqual(3);
    expect(window.failure).toBeInstanceOf(Error);
    warn.mockRestore();
  });
});

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

function stored(
  window: ReturnType<typeof createDepthFrameWindow>,
  from: number,
  to: number,
) {
  const indices: number[] = [];

  for (let index = from; index <= to; index += 1) {
    if (window.getEntry(index)) indices.push(index);
  }

  return indices;
}

interface SetupOptions {
  readonly frameCount?: number;
  readonly keyEvery?: number;
  readonly maxBytes?: number;
  readonly prefetchSeconds?: number;
  readonly retainSeconds?: number;
  /** Frames come out only as the test releases them. */
  readonly gated?: boolean;
  /** The run throws when it reaches this frame. */
  readonly failAt?: number;
  /** Frames the decoder never outputs. */
  readonly missing?: readonly number[];
  /** Whether playback runs; it does unless a test rests it. */
  readonly active?: boolean;
  readonly loop?: boolean;
  readonly pausedFrameCount?: number;
}

function setup(options: SetupOptions = {}) {
  const source = new FakeFrames(options);
  const window = createDepthFrameWindow({
    createMap: (frame) =>
      ({
        height: frame.height,
        kind: "disparity_px",
        samples: {
          encoding: "preview8",
          range: { max: 100, min: 0 },
          reservedMax: 15,
          values: frame.luma,
        },
        width: frame.width,
      }) satisfies DepthMap,
    endAt: (index) => (index + 1) / FPS,
    frameBytes: FRAME_BYTES,
    frames: source,
    loop: options.loop,
    maxBytes: options.maxBytes ?? FRAME_BYTES * 1000,
    pausedFrameCount: options.pausedFrameCount ?? 3,
    prefetchSeconds: options.prefetchSeconds ?? 1,
    retainSeconds: options.retainSeconds ?? 0,
    timeAt: (index) => index / FPS,
  });

  if (options.active !== false) window.setPlaybackActive(true);

  return { source, window };
}

class FakeFrames implements DepthFrameSource {
  readonly frameCount: number;
  readonly starts: number[] = [];
  cancelled = 0;
  private allowance = 0;
  private wakeRelease: (() => void) | null = null;

  constructor(private readonly options: SetupOptions) {
    this.frameCount = options.frameCount ?? 100;
  }

  keyIndexAtOrBefore(index: number) {
    const every = this.options.keyEvery ?? 1;

    return index - (index % every);
  }

  decode(
    fromIndex: number,
    { keep }: DepthPreviewDecodeOptions,
  ): DepthPreviewDecodeRun {
    this.starts.push(fromIndex);

    let next = this.keyIndexAtOrBefore(fromIndex);
    let cancelled = false;
    const run: DepthPreviewDecodeRun = {
      cancel: () => {
        if (!cancelled) this.cancelled += 1;
        cancelled = true;
        this.wakeRelease?.();
      },
      next: async (): Promise<DepthPreviewLumaFrame | null> => {
        while (!cancelled && next < this.frameCount) {
          const index = next;

          next += 1;
          if (this.options.failAt === index) throw new Error("decoder lost");
          if (this.options.missing?.includes(index)) continue;
          if (keep && !keep(index)) continue;
          if (this.options.gated) {
            while (this.allowance === 0 && !cancelled) {
              await new Promise<void>((resolve) => {
                this.wakeRelease = resolve;
              });
            }
            if (cancelled) return null;
            this.allowance -= 1;
          }
          await Promise.resolve();
          return {
            height: 1,
            index,
            luma: new Uint8Array(FRAME_BYTES).fill(16 + (index % 200)),
            width: FRAME_BYTES,
          };
        }

        return null;
      },
    };

    return run;
  }

  /** Lets `count` more frames out, then lets the window take them. */
  async release(count: number) {
    this.allowance += count;
    this.wakeRelease?.();
    await this.drain();
  }

  /** Lets every pending step of the window and the fake run settle. */
  async drain() {
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
