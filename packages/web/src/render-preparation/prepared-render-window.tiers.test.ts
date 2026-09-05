import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BaseMaskStyle,
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";

import { resetMocks } from "../../../../test/media-renderer-harness";
import { createPreparedRenderWindow } from "./prepared-render-window";

/* A mask wide enough that a quarter-width raster is a different width from a
   full one: with the raster capped at 1000, fine cooks 1000 wide and coarse
   cooks ceil(1000 / 4 / 4) * 4 = 252. The tiny fixtures elsewhere cook at
   their own width either way and could not tell the tiers apart. */
const MASK_WIDTH = 1000;
const MASK_HEIGHT = 100;
/* Under the settle delay, so a step lands its cook but the playhead has not
   stopped yet as far as the window can tell. */
const STEP_MS = 50;
const FPS = 25;
const FINE = 1000;
const COARSE = 252;

function wideFrames(count: number, height = MASK_HEIGHT): DetectionFrame[] {
  const counts = encodeCompressedRleCounts([0, MASK_WIDTH * height]);
  return Array.from({ length: count }, (_, index) => ({
    detections: [
      {
        className: "a",
        id: `d${index}`,
        mask: {
          counts,
          encoding: DetectionMaskEncoding.CompressedRle,
          height,
          width: MASK_WIDTH,
        },
        rect: { height, width: MASK_WIDTH, x: MASK_WIDTH / 2, y: height / 2 },
      },
    ],
    frameIndex: index,
    mediaTime: index / FPS,
  }));
}

function timelineOf(frames: readonly DetectionFrame[]) {
  return {
    destroy: vi.fn(),
    getBufferedFrames: vi.fn(() => frames),
    getState: vi.fn(() => ({
      bufferEndTime: frames[frames.length - 1]!.mediaTime,
      bufferStartTime: 0,
      detectionCount: frames.length,
      frameCount: frames.length,
      status: "ready",
    })),
    prefetch: vi.fn(),
    prepare: vi.fn(() => Promise.resolve()),
    selectFrame: vi.fn((mediaTime: number) =>
      frames.reduce((best, frame) =>
        Math.abs(frame.mediaTime - mediaTime) <
        Math.abs(best.mediaTime - mediaTime)
          ? frame
          : best,
      ),
    ),
  };
}

async function flush(count: number) {
  for (let index = 0; index < count; index += 1) {
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("prepared raster tiers", () => {
  it("cooks a quarter-width raster while the playhead flings and a full one once it settles", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(60);
    const at = (index: number) => frames[index]!.mediaTime;
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 2,
      preparedWindowScanIntervalSeconds: 0,
      resolveMaxRasterWidth: () => FINE,
    });
    try {
      // settled: one frame forward at a time
      renderWindow.getFrame(at(0));
      await flush(6);
      renderWindow.getFrame(at(1));
      await flush(6);
      expect(renderWindow.getFrame(at(1))?.maskFrame?.width).toBe(FINE);

      // a fling: steps of twenty frames, the second one is what makes it a fling
      renderWindow.getFrame(at(21));
      await vi.advanceTimersByTimeAsync(STEP_MS);
      renderWindow.getFrame(at(41));
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(renderWindow.getFrame(at(41))?.maskFrame?.width).toBe(COARSE);

      // the playhead stops: the settle timer asks for the frame on screen again, at full width
      await vi.advanceTimersByTimeAsync(200);
      await flush(8);
      expect(renderWindow.getFrame(at(41))?.maskFrame?.width).toBe(FINE);
    } finally {
      renderWindow.destroy();
    }
  });

  it("treats fast playback as a fling even though its steps are regular", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(120);
    const at = (index: number) => frames[index]!.mediaTime;
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 2,
      preparedWindowScanIntervalSeconds: 0,
      resolveMaxRasterWidth: () => FINE,
    });
    try {
      renderWindow.getFrame(at(0));
      await flush(6);
      // 8x: eight frames per step, wider than the few strides a scrub settles at
      for (let index = 8; index <= 40; index += 8) {
        renderWindow.getFrame(at(index));
        await vi.advanceTimersByTimeAsync(STEP_MS);
      }
      expect(renderWindow.getFrame(at(40))?.maskFrame?.width).toBe(COARSE);

      // playback pauses: the frame on screen is cooked again at full width
      await vi.advanceTimersByTimeAsync(200);
      await flush(8);
      expect(renderWindow.getFrame(at(40))?.maskFrame?.width).toBe(FINE);
    } finally {
      renderWindow.destroy();
    }
  });
});

describe("prepared-mask cache bounded by bytes", () => {
  it("evicts by bytes before the count ceiling is reached", async () => {
    vi.useFakeTimers();
    resetMocks();
    /* Tall enough that two frames clear the budget's floor. An id-mask frame
       is charged two bytes per raster pixel: two fit, a third does not. */
    const height = 5000;
    const frames = wideFrames(6, height);
    const at = (index: number) => frames[index]!.mediaTime;
    const twoFrames = 2 * FINE * height * 2;
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      maxMaskFrameCacheBytes: twoFrames + 1,
      maxMaskFrameCacheSize: 100,
      prefetchFrameCount: 0,
      preparedWindowScanIntervalSeconds: 0,
      resolveMaxRasterWidth: () => FINE,
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        renderWindow.getFrame(at(index));
        await flush(6);
      }
      const held = [0, 1, 2].filter(
        (index) => renderWindow.getFrame(at(index))?.maskFrame !== undefined,
      );
      expect(held.length).toBeLessThanOrEqual(2);
      expect(held).toContain(2);
    } finally {
      renderWindow.destroy();
    }
  });
});
