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
import {
  createDepthPreviewWindow,
  type DepthPreviewFrameSource,
} from "./depth-preview-window";

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

  it("counts lead to the end of the clip as unlimited", async () => {
    const { source, window } = setup({ frameCount: 5, prefetchSeconds: 2 });

    window.setPlayhead(3);
    await source.drain();

    expect(window.leadSeconds(3)).toBe(Number.POSITIVE_INFINITY);
    expect(window.needsPlaybackGateWait(3, thresholds(1, 1))).toBe(false);
  });

  it("counts prepared frames up, whatever is evicted", async () => {
    const { source, window } = setup({
      maxBytes: FRAME_BYTES * 2,
      prefetchSeconds: 2,
      retainSeconds: 0,
    });

    window.setPlayhead(0);
    await source.drain();
    window.setPlayhead(1);
    await source.drain();
    window.setPlayhead(2);
    await source.drain();

    expect(window.getPreparationProgress()).toBe(4);
  });

  it("hands the next decoded frames over for uploading ahead", async () => {
    const { source, window } = setup({ prefetchSeconds: 0.5 });

    window.setPlayhead(0);
    await source.drain();

    expect(window.upcoming(1, 2).map(({ index }) => index)).toEqual([2, 3]);
    expect(window.upcoming(0, 2, 2).map(({ index }) => index)).toEqual([2, 4]);
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

function stored(
  window: ReturnType<typeof createDepthPreviewWindow>,
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
}

function setup(options: SetupOptions = {}) {
  const source = new FakeFrames(options);
  const window = createDepthPreviewWindow({
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
    maxBytes: options.maxBytes ?? FRAME_BYTES * 1000,
    prefetchSeconds: options.prefetchSeconds ?? 1,
    retainSeconds: options.retainSeconds ?? 0,
    timeAt: (index) => index / FPS,
  });

  return { source, window };
}

class FakeFrames implements DepthPreviewFrameSource {
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
