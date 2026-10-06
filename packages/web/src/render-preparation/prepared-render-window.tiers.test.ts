import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BaseMaskStyle,
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";

import { resetMocks } from "../../../../test/media-renderer-harness";
import { PreparedMaskFrameKind } from "./mask-frame-artifact";
import {
  MaskPreparationWorkerMessageType,
  type MaskPreparationWorkerPrepareMessage,
} from "./mask-preparation-worker-protocol";
import { createPreparedRenderWindow } from "./prepared-render-window";
import {
  RenderPreparationGateHoldReason,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";

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
  it.each([16, 31, 32, 63, 64])(
    "keeps motion rasters inside a %ipx fitted cap",
    async (fittedWidth) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(60);
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 0,
        preparedWindowScanIntervalSeconds: 0,
        resolveMaxRasterWidth: () => fittedWidth,
      });

      try {
        for (const index of [0, 20, 40]) {
          renderWindow.getFrame(frames[index]!.mediaTime);
          await vi.advanceTimersByTimeAsync(STEP_MS);
        }
        const mediaTime = frames[40]!.mediaTime;
        const artifact = renderWindow.getFrame(mediaTime)?.maskFrame;
        expect(artifact?.width).toBe(fittedWidth);

        await vi.advanceTimersByTimeAsync(200);
        expect(renderWindow.getFrame(mediaTime)?.maskFrame).toBe(artifact);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([
    { previewScale: undefined, expectedWidth: COARSE },
    { previewScale: 0.5, expectedWidth: 500 },
    { previewScale: 1, expectedWidth: FINE },
    { previewScale: 0.01, expectedWidth: 64 },
    { previewScale: 0, expectedWidth: COARSE },
    { previewScale: -0.5, expectedWidth: COARSE },
    { previewScale: Number.NaN, expectedWidth: COARSE },
    { previewScale: Number.POSITIVE_INFINITY, expectedWidth: COARSE },
    { previewScale: 2, expectedWidth: COARSE },
  ])(
    "uses a $expectedWidth px motion raster with preview scale $previewScale",
    async ({ previewScale, expectedWidth }) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(60);
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 0,
        preparedWindowScanIntervalSeconds: 0,
        renderPreparation: { maskFrame: { previewScale } },
        resolveMaxRasterWidth: () => FINE,
      });

      try {
        for (const index of [0, 20, 40]) {
          renderWindow.getFrame(frames[index]!.mediaTime);
          await vi.advanceTimersByTimeAsync(STEP_MS);
        }
        const mediaTime = frames[40]!.mediaTime;
        const preview = renderWindow.getFrame(mediaTime)?.maskFrame;
        expect(preview?.width).toBe(expectedWidth);

        await vi.advanceTimersByTimeAsync(200);
        expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(FINE);
        if (previewScale === 1) {
          expect(renderWindow.getFrame(mediaTime)?.maskFrame).toBe(preview);
        }
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([undefined, FINE * 4])(
    "retains native-width motion artifacts when the fitted cap is %s",
    async (fittedCap) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(60);
      const worker = createDeferredTierWorker();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 0,
        renderPreparation: {
          maskFrame: { workerCount: 1 },
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => fittedCap,
      });

      try {
        for (const index of [0, 20, 40]) {
          renderWindow.getFrame(frames[index]!.mediaTime);
          await vi.advanceTimersByTimeAsync(0);
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(STEP_MS);
        }
        const mediaTime = frames[40]!.mediaTime;
        const artifact = renderWindow.getFrame(mediaTime)?.maskFrame;
        expect(artifact?.width).toBe(FINE);
        await vi.advanceTimersByTimeAsync(200);
        expect(renderWindow.getFrame(mediaTime)?.maskFrame).toBe(artifact);
        expect(worker.requests).toHaveLength(3);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([
    {
      direction: "forward",
      timestamps: [0, 0.001, 0.034, 0.067, 0.1],
      steps: [0, 1, 2, 3, 4],
    },
    {
      direction: "reverse",
      timestamps: [0, 0.5, 0.6, 0.61, 0.611],
      steps: [4, 3, 2, 1],
    },
  ])(
    "keeps adjacent $direction VFR frames at full width",
    async ({ timestamps, steps }) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(timestamps.length).map((frame, index) => ({
        ...frame,
        mediaTime: timestamps[index]!,
      }));
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 0,
        resolveMaxRasterWidth: () => FINE,
      });

      try {
        for (const index of steps) {
          const mediaTime = frames[index]!.mediaTime;
          renderWindow.getFrame(mediaTime);
          await vi.advanceTimersByTimeAsync(STEP_MS);
          expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(FINE);
        }
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it("keeps single-frame reverse steps at full width", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(10);
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 0,
      preparedWindowScanIntervalSeconds: 0,
      resolveMaxRasterWidth: () => FINE,
    });

    try {
      for (const index of [3, 2, 1]) {
        const mediaTime = frames[index]!.mediaTime;
        renderWindow.getFrame(mediaTime);
        await vi.advanceTimersByTimeAsync(STEP_MS);
        expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(FINE);
      }
    } finally {
      renderWindow.destroy();
    }
  });

  it("refines repeated four-frame steps after the playhead stops", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(20);
    const at = (index: number) => frames[index]!.mediaTime;
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 0,
      preparedWindowScanIntervalSeconds: 0,
      resolveMaxRasterWidth: () => FINE,
    });

    try {
      for (const index of [0, 4, 8]) {
        renderWindow.getFrame(at(index));
        await vi.advanceTimersByTimeAsync(STEP_MS);
      }
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(COARSE);
      const coarseRevision = renderWindow.getArtifactRevision(at(8));
      const otherRevision = renderWindow.getArtifactRevision(at(0));

      await vi.advanceTimersByTimeAsync(200);
      await flush(4);

      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(FINE);
      expect(renderWindow.getArtifactRevision(at(8))).toBeGreaterThan(
        coarseRevision,
      );
      expect(renderWindow.getArtifactRevision(at(0))).toBe(otherRevision);
    } finally {
      renderWindow.destroy();
    }
  });

  it("remembers refinement when the settle timer races an in-flight coarse cook", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(20);
    const at = (index: number) => frames[index]!.mediaTime;
    const worker = createDeferredTierWorker();
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 0,
      preparedWindowScanIntervalSeconds: 0,
      renderPreparation: {
        maskFrame: { workerCount: 1 },
        workerFactory: { createWorker: () => worker.worker },
      },
      resolveMaxRasterWidth: () => FINE,
    });

    try {
      for (const index of [0, 4]) {
        renderWindow.getFrame(at(index));
        await vi.advanceTimersByTimeAsync(0);
        worker.completeNext();
        await vi.advanceTimersByTimeAsync(STEP_MS);
      }
      renderWindow.getFrame(at(8));
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests[2]!.job.maxRasterWidth).toBe(COARSE);

      await vi.advanceTimersByTimeAsync(200);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);

      expect(worker.requests[3]!.job.maxRasterWidth).toBe(FINE);
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(COARSE);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(FINE);
    } finally {
      renderWindow.destroy();
    }
  });

  it("recooks the active frame at a new display size and ignores its old in-flight result", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(2);
    const mediaTime = frames[0]!.mediaTime;
    let width = FINE;
    const worker = createDeferredTierWorker();
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 0,
      preparedWindowScanIntervalSeconds: 0,
      renderPreparation: {
        maskFrame: { workerCount: 1 },
        workerFactory: { createWorker: () => worker.worker },
      },
      resolveMaxRasterWidth: () => width,
    });

    try {
      renderWindow.getFrame(mediaTime);
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests[0]!.job.maxRasterWidth).toBe(FINE);

      width = FINE / 2;
      renderWindow.invalidateRasterSize();
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);

      expect(renderWindow.getArtifactRevision(mediaTime)).toBe(0);
      expect(renderWindow.getFrame(mediaTime)?.maskFrame).toBeUndefined();
      expect(worker.requests[1]!.job.maxRasterWidth).toBe(width);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(width);
      expect(renderWindow.getArtifactRevision(mediaTime)).toBeGreaterThan(0);
    } finally {
      renderWindow.destroy();
    }
  });

  it("preserves a settled frame's fine quality when its display size changes", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(20);
    const at = (index: number) => frames[index]!.mediaTime;
    let width = FINE;
    const worker = createDeferredTierWorker();
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 0,
      preparedWindowScanIntervalSeconds: 0,
      renderPreparation: {
        maskFrame: { workerCount: 1 },
        workerFactory: { createWorker: () => worker.worker },
      },
      resolveMaxRasterWidth: () => width,
    });

    try {
      for (const index of [0, 4, 8]) {
        renderWindow.getFrame(at(index));
        await vi.advanceTimersByTimeAsync(0);
        worker.completeNext();
        await vi.advanceTimersByTimeAsync(STEP_MS);
      }
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(COARSE);
      await vi.advanceTimersByTimeAsync(200);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(FINE);

      width = FINE / 2;
      renderWindow.invalidateRasterSize();
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests[4]!.job.maxRasterWidth).toBe(width);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(500);

      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(width);
      expect(worker.requests).toHaveLength(5);
    } finally {
      renderWindow.destroy();
    }
  });

  it("retains saturated native mask rasters when only the display cap grows", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(2);
    const mediaTime = frames[0]!.mediaTime;
    let width = FINE * 2;
    const worker = createDeferredTierWorker();
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 0,
      renderPreparation: {
        maskFrame: { workerCount: 1 },
        workerFactory: { createWorker: () => worker.worker },
      },
      resolveMaxRasterWidth: () => width,
    });

    try {
      renderWindow.getFrame(mediaTime);
      await vi.advanceTimersByTimeAsync(0);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      const artifact = renderWindow.getFrame(mediaTime)?.maskFrame;
      const revision = renderWindow.getArtifactRevision(mediaTime);
      expect(artifact?.width).toBe(FINE);

      width = FINE * 3;
      renderWindow.invalidateRasterSize();
      await vi.advanceTimersByTimeAsync(500);

      expect(renderWindow.getFrame(mediaTime)?.maskFrame).toBe(artifact);
      expect(renderWindow.getArtifactRevision(mediaTime)).toBe(revision);
      expect(worker.requests).toHaveLength(1);
    } finally {
      renderWindow.destroy();
    }
  });

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

describe("prepared raster quality gate", () => {
  it.each([
    {
      label: "enabled Fine",
      playbackGate: { enabled: true, quality: "fine" },
      expectedWidth: 500,
    },
    {
      label: "enabled Adaptive",
      playbackGate: { enabled: true, quality: "adaptive" },
      expectedWidth: 128,
    },
    {
      label: "disabled Fine",
      playbackGate: { enabled: false, quality: "fine" },
      expectedWidth: 128,
    },
    {
      label: "Fine with no enabled gate",
      playbackGate: { quality: "fine" },
      expectedWidth: 128,
    },
  ] as const)(
    "warms active and ahead masks once at $expectedWidth px with $label quality",
    async ({ playbackGate, expectedWidth }) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(20);
      const at = (index: number) => frames[index]!.mediaTime;
      const worker = createDeferredTierWorker();
      const timeline = timelineOf(frames);
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timeline as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 3,
        preparedWindowScanIntervalSeconds: 0.1,
        renderPreparation: {
          maskFrame: { scheduleBatchSize: 3, workerCount: 1 },
          onDiagnostics: (value) => diagnostics.push(value),
          playbackGate,
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => 500,
      });

      try {
        for (const index of [0, 4, 8]) {
          renderWindow.getFrame(at(index));
          await vi.advanceTimersByTimeAsync(0);
          for (
            let count = 0;
            count < 12 && worker.pendingRequestCount > 0;
            count += 1
          ) {
            worker.completeNext();
            await vi.advanceTimersByTimeAsync(0);
          }
          expect(worker.pendingRequestCount).toBe(0);
        }
        for (const index of [8, 9, 10]) {
          expect(
            worker.requests.filter(
              (request) => request.job.key === `${index}:${at(index)}`,
            ),
          ).toEqual([
            expect.objectContaining({
              job: expect.objectContaining({ maxRasterWidth: expectedWidth }),
            }),
          ]);
        }

        const scanCount = timeline.getBufferedFrames.mock.calls.length;
        for (let count = 0; count < 5; count += 1) {
          renderWindow.getFrame(at(8));
        }
        expect(timeline.getBufferedFrames).toHaveBeenCalledTimes(scanCount);
        expect(diagnostics.at(-1)!.artifacts[0]!.preparedAheadFrameCount).toBe(
          3,
        );
        expect(
          diagnostics.at(-1)!.artifacts[0]!.preparedAheadSeconds,
        ).toBeCloseTo(2 / FPS);

        const requestCount = worker.requests.length;
        await renderWindow.waitForReady(at(8), {
          enabled: "enabled" in playbackGate && playbackGate.enabled,
          resumeAtSeconds: 2 / FPS,
          stopBelowSeconds: 2 / FPS,
        });
        expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(
          expectedWidth,
        );
        expect(worker.requests).toHaveLength(requestCount);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it("requires a fine lead before registering an explicit wait on a direct renderer", async () => {
    vi.useFakeTimers();
    resetMocks();
    const frames = wideFrames(20);
    const at = (index: number) => frames[index]!.mediaTime;
    const worker = createDeferredTierWorker();
    const diagnostics: RenderPreparationDiagnostics[] = [];
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      prefetchFrameCount: 3,
      preparedWindowScanIntervalSeconds: 0.1,
      renderPreparation: {
        maskFrame: { scheduleBatchSize: 3, workerCount: 1 },
        onDiagnostics: (value) => diagnostics.push(value),
        playbackGate: { quality: "fine" },
        workerFactory: { createWorker: () => worker.worker },
      },
      resolveMaxRasterWidth: () => 500,
    });

    try {
      for (const index of [0, 4, 8]) {
        renderWindow.getFrame(at(index));
        await vi.advanceTimersByTimeAsync(0);
        for (let count = 0; count < 12 && worker.pendingRequestCount; count++) {
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(worker.pendingRequestCount).toBe(0);
      }
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(128);

      await vi.advanceTimersByTimeAsync(200);
      expect(worker.pendingRequestCount).toBe(1);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      expect(renderWindow.getFrame(at(8))?.maskFrame?.width).toBe(500);
      expect(diagnostics.at(-1)!.artifacts[0]!.coarseCount).toBe(2);
      expect(worker.pendingRequestCount).toBe(0);

      const gate = {
        enabled: true,
        resumeAtSeconds: 2 / FPS,
        stopBelowSeconds: 2 / FPS,
      };
      expect(renderWindow.needsPlaybackGateWait(at(8), gate)).toBe(true);
      let resolved = false;
      const wait = renderWindow.waitForReady(at(8), gate).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);
      expect(diagnostics.at(-1)!.artifacts[0]!.preparedAheadFrameCount).toBe(1);

      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);
      worker.completeNext();
      await vi.advanceTimersByTimeAsync(0);
      await wait;
      expect(resolved).toBe(true);
      expect(worker.pendingRequestCount).toBe(0);
    } finally {
      renderWindow.destroy();
    }
  });

  it.each([undefined, "adaptive", "fine"] as const)(
    "handles an in-flight preview with gate quality %s",
    async (quality) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(60);
      const worker = createDeferredTierWorker();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 0,
        renderPreparation: {
          maskFrame: { workerCount: 1 },
          playbackGate: { enabled: true, quality },
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => FINE,
      });

      try {
        renderWindow.setPlaybackActive(false);
        for (const index of [0, 20]) {
          renderWindow.getFrame(frames[index]!.mediaTime);
          await vi.advanceTimersByTimeAsync(0);
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(STEP_MS);
        }
        const mediaTime = frames[40]!.mediaTime;
        const gate = { enabled: true, resumeAtSeconds: 0, stopBelowSeconds: 0 };
        renderWindow.getFrame(mediaTime);
        await vi.advanceTimersByTimeAsync(0);
        expect(worker.requests[2]!.job.maxRasterWidth).toBe(COARSE);
        let resolved = false;
        const wait = renderWindow.waitForReady(mediaTime, gate).then(() => {
          resolved = true;
        });

        worker.completeNext();
        await vi.advanceTimersByTimeAsync(0);
        expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(COARSE);
        expect(renderWindow.isArtifactPrepared(mediaTime)).toBe(true);
        expect(resolved).toBe(quality !== "fine");
        expect(renderWindow.needsPlaybackGateWait(mediaTime, gate)).toBe(
          quality === "fine",
        );

        if (quality === "fine") {
          expect(worker.requests[3]!.job.maxRasterWidth).toBe(FINE);
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(0);
          expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(FINE);
        }
        await wait;
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([
    { maxCacheBytes: undefined, expectedFineFrames: 3 },
    { maxCacheBytes: 20_000_001, expectedFineFrames: 2 },
  ])(
    "banks a fine lead capped to $expectedFineFrames retainable frames",
    async ({ maxCacheBytes, expectedFineFrames }) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(60, 5000);
      const worker = createDeferredTierWorker();
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 3,
        renderPreparation: {
          maskFrame: { maxCacheBytes, scheduleBatchSize: 3, workerCount: 1 },
          onDiagnostics: (value) => diagnostics.push(value),
          playbackGate: { enabled: true, quality: "fine" },
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => FINE,
      });
      const drain = async () => {
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 12 && worker.pendingRequestCount; index++) {
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(worker.pendingRequestCount).toBe(0);
      };

      try {
        renderWindow.setPlaybackActive(false);
        for (const index of [0, 20]) {
          renderWindow.getFrame(frames[index]!.mediaTime);
          await drain();
          await vi.advanceTimersByTimeAsync(STEP_MS);
        }
        const mediaTime = frames[40]!.mediaTime;
        renderWindow.getFrame(mediaTime);
        await drain();
        expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(COARSE);
        expect(diagnostics.at(-1)!.artifacts[0]!.preparedAheadFrameCount).toBe(
          0,
        );

        let resolved = false;
        const wait = renderWindow
          .waitForReady(mediaTime, {
            enabled: true,
            resumeAtSeconds: 1,
            stopBelowSeconds: 1,
          })
          .then(() => {
            resolved = true;
          });
        await vi.advanceTimersByTimeAsync(0);
        const requestCount = worker.requests.length;
        worker.completeNext();
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(false);
        expect(diagnostics.at(-1)!.artifacts[0]!.gateHold?.reason).toBe(
          RenderPreparationGateHoldReason.LeadBelowRequirement,
        );

        for (let index = 1; index < expectedFineFrames; index++) {
          expect(worker.requests.at(-1)!.job.maxRasterWidth).toBe(FINE);
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(0);
        }
        await wait;
        const artifact = diagnostics.at(-1)!.artifacts[0]!;
        expect(artifact.preparedAheadFrameCount).toBe(expectedFineFrames);
        expect(artifact.preparedAheadSeconds).toBeCloseTo(
          (expectedFineFrames - 1) / FPS,
        );
        expect(artifact.preparedBytes).toBeLessThanOrEqual(
          artifact.maxPreparedBytes!,
        );
        expect(worker.pendingRequestCount).toBe(0);
        const completedCount = worker.requests.length;
        expect(completedCount - requestCount + 1).toBe(expectedFineFrames);
        await vi.advanceTimersByTimeAsync(500);
        expect(worker.requests).toHaveLength(completedCount);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([false, true])(
    "drops an aborted fine hold before navigation, preview completed: %s",
    async (previewCompleted) => {
      vi.useFakeTimers();
      resetMocks();
      const frames = wideFrames(100);
      const worker = createDeferredTierWorker();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 0,
        renderPreparation: {
          maskFrame: { workerCount: 1 },
          playbackGate: { enabled: true, quality: "fine" },
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => FINE,
      });

      try {
        renderWindow.setPlaybackActive(false);
        for (const index of [0, 20]) {
          renderWindow.getFrame(frames[index]!.mediaTime);
          await vi.advanceTimersByTimeAsync(0);
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(STEP_MS);
        }
        const mediaTime = frames[40]!.mediaTime;
        renderWindow.getFrame(mediaTime);
        await vi.advanceTimersByTimeAsync(0);
        const controller = new AbortController();
        const wait = renderWindow.waitForReady(
          mediaTime,
          { enabled: true, resumeAtSeconds: 0, stopBelowSeconds: 0 },
          controller.signal,
        );
        if (previewCompleted) {
          worker.completeNext();
          await vi.advanceTimersByTimeAsync(0);
          expect(worker.requests.at(-1)!.job.maxRasterWidth).toBe(FINE);
        }
        controller.abort();
        await wait;

        const nextTime = frames[80]!.mediaTime;
        renderWindow.getFrame(nextTime);
        worker.completeNext();
        await vi.advanceTimersByTimeAsync(0);
        expect(worker.requests.at(-1)!.job.key).toBe(`80:${nextTime}`);
        expect(worker.requests.at(-1)!.job.maxRasterWidth).toBe(COARSE);
        worker.completeNext();
        await vi.advanceTimersByTimeAsync(0);
        expect(renderWindow.getFrame(nextTime)?.maskFrame?.width).toBe(COARSE);
      } finally {
        renderWindow.destroy();
      }
    },
  );
});

function createDeferredTierWorker() {
  const requests: MaskPreparationWorkerPrepareMessage[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  let completed = 0;
  const worker = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") listeners.add(listener);
    },
    postMessage(request: MaskPreparationWorkerPrepareMessage) {
      requests.push(request);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") listeners.delete(listener);
    },
    terminate: vi.fn(),
  } as unknown as Worker;

  return {
    completeNext(raster?: Uint8Array) {
      const request = requests[completed++]!;
      const mask = request.job.instructions[0]!.mask!;
      const width = Math.min(
        mask.width,
        request.job.maxRasterWidth ?? mask.width,
      );
      const height = Math.round((width * mask.height) / mask.width);
      const data = {
        artifactKind: PreparedMaskFrameKind.IdMask,
        fillPalette: new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]),
        height,
        key: request.job.key,
        raster: raster ?? new Uint8Array(width * height).fill(1),
        requestId: request.requestId,
        sourceWidth: mask.width,
        strokePalette: new Float32Array(8),
        strokeWidths: new Float32Array(2),
        type: MaskPreparationWorkerMessageType.Complete,
        width,
      };
      for (const listener of listeners) listener({ data } as MessageEvent);
    },
    get pendingRequestCount() {
      return requests.length - completed;
    },
    requests,
    worker,
  };
}

describe("prepared-mask cache bounded by bytes", () => {
  it.each([
    { budget: "bytes", residentFrames: 8, expectsStride: false },
    { budget: "count", residentFrames: 8, expectsStride: false },
    { budget: "bytes", residentFrames: 15, expectsStride: true },
  ])(
    "retains nearby masks across a cadence phase change with $residentFrames resident frames bounded by $budget",
    async ({ budget, residentFrames, expectsStride }) => {
      vi.useFakeTimers();
      resetMocks();
      const height = 5000;
      const frames = wideFrames(64, height);
      const at = (index: number) => frames[index]!.mediaTime;
      const worker = createDeferredTierWorker();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        maxMaskFrameCacheBytes:
          budget === "bytes"
            ? residentFrames * FINE * height * 2 + 1
            : Number.POSITIVE_INFINITY,
        maxMaskFrameCacheSize: budget === "count" ? residentFrames : 100,
        prefetchFrameCount: 8,
        preparedWindowScanIntervalSeconds: 0,
        renderPreparation: {
          maskFrame: { scheduleBatchSize: 8, workerCount: 1 },
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => FINE,
      });
      const drain = async () => {
        await vi.advanceTimersByTimeAsync(0);
        for (
          let count = 0;
          count < 40 && worker.pendingRequestCount > 0;
          count += 1
        ) {
          worker.completeNext(new Uint8Array(1));
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(worker.pendingRequestCount).toBe(0);
      };

      try {
        for (const index of [0, 2, 4, 6]) {
          renderWindow.getFrame(at(index));
          await drain();
        }
        const nearbyRevision = renderWindow.getArtifactRevision(at(9));
        expect(nearbyRevision).toBeGreaterThan(0);

        // Eight stride-2 targets span fifteen source frames once cadence holds.
        renderWindow.getFrame(at(8));
        await drain();
        expect(renderWindow.getArtifactRevision(at(9))).toBe(nearbyRevision);
        expect(renderWindow.isArtifactPrepared(at(22))).toBe(expectsStride);

        renderWindow.getFrame(at(9));
        await drain();
        expect(renderWindow.getArtifactRevision(at(9))).toBe(nearbyRevision);
        expect(
          worker.requests.filter((request) => request.job.key === "9:0.36"),
        ).toHaveLength(1);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it("keeps a constrained horizon contiguous when later cooks use smaller previews", async () => {
    vi.useFakeTimers();
    resetMocks();
    const height = 5000;
    const frames = wideFrames(64, height);
    const at = (index: number) => frames[index]!.mediaTime;
    const worker = createDeferredTierWorker();
    const renderWindow = createPreparedRenderWindow({
      detectionTimeline: timelineOf(frames) as never,
      maskStyle: new BaseMaskStyle(),
      maxMaskFrameCacheBytes: 15 * FINE * height * 2 + 1,
      maxMaskFrameCacheSize: 100,
      prefetchFrameCount: 8,
      preparedWindowScanIntervalSeconds: 0,
      renderPreparation: {
        maskFrame: { scheduleBatchSize: 8, workerCount: 1 },
        workerFactory: { createWorker: () => worker.worker },
      },
      resolveMaxRasterWidth: () => FINE,
    });

    try {
      for (const index of [0, 4, 8, 12, 16]) {
        renderWindow.getFrame(at(index));
        await vi.advanceTimersByTimeAsync(0);
        for (
          let count = 0;
          count < 40 && worker.pendingRequestCount > 0;
          count += 1
        ) {
          worker.completeNext(new Uint8Array(1));
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(worker.pendingRequestCount).toBe(0);
      }

      expect(
        worker.requests.filter((request) => request.job.key === "17:0.68"),
      ).toEqual([
        expect.objectContaining({
          job: expect.objectContaining({ maxRasterWidth: COARSE }),
        }),
      ]);
      expect(renderWindow.isArtifactPrepared(at(44))).toBe(false);
    } finally {
      renderWindow.destroy();
    }
  });

  it.each([
    { workerCount: 1, budget: "bytes", loop: false, quality: "adaptive" },
    { workerCount: 4, budget: "bytes", loop: false, quality: "adaptive" },
    { workerCount: 1, budget: "count", loop: true, quality: "fine" },
  ] as const)(
    "stops cooking when the active frame leaves a full $budget target prefix between scans with $workerCount workers ($quality, loop=$loop)",
    async ({ workerCount, budget, loop, quality }) => {
      vi.useFakeTimers();
      resetMocks();
      const height = 5000;
      const frames = wideFrames(6, height);
      const workers = Array.from(
        { length: workerCount },
        createDeferredTierWorker,
      );
      let createdWorkerCount = 0;
      const requests = () => workers.flatMap((worker) => worker.requests);
      const pendingRequestCount = () =>
        workers.reduce(
          (count, worker) => count + worker.pendingRequestCount,
          0,
        );
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        maxMaskFrameCacheBytes:
          budget === "bytes"
            ? 2 * FINE * height * 2 + 1
            : Number.POSITIVE_INFINITY,
        maxMaskFrameCacheSize: budget === "count" ? 2 : 100,
        prefetchFrameCount: 4,
        preparedWindowScanIntervalSeconds: 0.1,
        renderPreparation: {
          maskFrame: { scheduleBatchSize: 4, workerCount },
          playbackGate: { quality },
          onDiagnostics: (value) => diagnostics.push(value),
          workerFactory: {
            createWorker: () => workers[createdWorkerCount++]!.worker,
          },
        },
        resolveMaxRasterWidth: () => FINE,
      });
      const drain = async () => {
        await vi.advanceTimersByTimeAsync(0);
        for (
          let count = 0;
          count < 16 && pendingRequestCount() > 0;
          count += 1
        ) {
          for (const worker of workers) {
            if (worker.pendingRequestCount > 0) {
              worker.completeNext(new Uint8Array(1));
            }
          }
          await vi.advanceTimersByTimeAsync(0);
        }
      };

      try {
        renderWindow.setTimelineContext({
          duration: frames.length / FPS,
          loop,
        });
        renderWindow.getFrame(0);
        await drain();
        expect(pendingRequestCount()).toBe(0);
        expect(diagnostics.at(-1)!.artifacts[0]!.preparedCount).toBe(2);

        // Frame 2 is outside the retained 0/1 prefix, before the 0.1s rescan.
        const mediaTime = frames[2]!.mediaTime;
        renderWindow.getFrame(mediaTime);
        await drain();

        expect(
          pendingRequestCount(),
          JSON.stringify(requests().map((request) => request.job.key)),
        ).toBe(0);
        expect(renderWindow.getFrame(mediaTime)?.maskFrame?.width).toBe(FINE);
        expect(diagnostics.at(-1)!.artifacts[0]!.preparedCount).toBe(2);
        const gate = {
          enabled: true,
          resumeAtSeconds: 1,
          stopBelowSeconds: 1,
        };
        // Earlier targets must not become almost a full lap of forward lead.
        expect(renderWindow.needsPlaybackGateWait(mediaTime, gate)).toBe(false);
        const requestCount = requests().length;
        await vi.advanceTimersByTimeAsync(500);
        expect(requests()).toHaveLength(requestCount);

        const ready = renderWindow.waitForReady(mediaTime, gate);
        await drain();
        await ready;
        expect(pendingRequestCount()).toBe(0);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([
    { label: "default", maxCacheBytes: undefined },
    { label: "public NaN", maxCacheBytes: Number.NaN },
    { label: "internal NaN", maxMaskFrameCacheBytes: Number.NaN },
    { label: "unlimited", maxCacheBytes: Number.POSITIVE_INFINITY },
  ])(
    "retains a reachable cache prefix with the $label byte budget",
    async ({ maxCacheBytes, maxMaskFrameCacheBytes }) => {
      vi.useFakeTimers();
      resetMocks();
      const height = 104_858;
      const frames = wideFrames(7, height);
      const frameBytes = FINE * height * 2;
      const worker = createDeferredTierWorker();
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        maxMaskFrameCacheBytes,
        maxMaskFrameCacheSize: 100,
        prefetchFrameCount: frames.length,
        preparedWindowScanIntervalSeconds: 0,
        renderPreparation: {
          maskFrame: { maxCacheBytes, scheduleBatchSize: 7, workerCount: 1 },
          onDiagnostics: (value) => diagnostics.push(value),
          workerFactory: { createWorker: () => worker.worker },
        },
        resolveMaxRasterWidth: () => FINE,
      });

      try {
        renderWindow.getFrame(0);
        await vi.advanceTimersByTimeAsync(0);
        const budget = diagnostics.at(-1)!.artifacts[0]!.maxPreparedBytes!;
        expect(Number.isNaN(budget)).toBe(false);
        if (maxCacheBytes === Number.POSITIVE_INFINITY) {
          expect(budget).toBe(Number.POSITIVE_INFINITY);
        } else {
          expect(budget).toBeGreaterThanOrEqual(256 * 1024 * 1024);
          expect(budget).toBeLessThanOrEqual(1024 * 1024 * 1024);
        }
        const expectedFrames = Math.min(
          frames.length,
          Math.floor(budget / frameBytes),
        );
        for (let index = 0; index < frames.length; index++) {
          if (!worker.pendingRequestCount) break;
          // Cache charging uses geometry; no test pixels need to be drawn.
          worker.completeNext(new Uint8Array(1));
          await vi.advanceTimersByTimeAsync(0);
        }
        const artifact = diagnostics.at(-1)!.artifacts[0]!;
        expect(artifact.preparedCount).toBe(expectedFrames);
        expect(artifact.preparedBytes).toBe(expectedFrames * frameBytes);
        expect(artifact.preparedBytes).toBeLessThanOrEqual(budget);
        expect(worker.requests).toHaveLength(expectedFrames);
        expect(worker.pendingRequestCount).toBe(0);
        expect(
          renderWindow.needsPlaybackGateWait(0, {
            enabled: true,
            resumeAtSeconds: 1,
            stopBelowSeconds: 1,
          }),
        ).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(worker.requests).toHaveLength(expectedFrames);
      } finally {
        renderWindow.destroy();
      }
    },
  );

  it.each([1, 4])(
    "stops warming beyond the byte budget with %i workers and admits frames when the playhead advances",
    async (workerCount) => {
      vi.useFakeTimers();
      resetMocks();
      const height = 5000;
      const frames = wideFrames(6, height);
      const at = (index: number) => frames[index]!.mediaTime;
      const workers = Array.from(
        { length: workerCount },
        createDeferredTierWorker,
      );
      let createdWorkerCount = 0;
      const requests = () => workers.flatMap((worker) => worker.requests);
      const pendingRequestCount = () =>
        workers.reduce(
          (count, worker) => count + worker.pendingRequestCount,
          0,
        );
      const evicted = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timelineOf(frames) as never,
        maskStyle: new BaseMaskStyle(),
        maxMaskFrameCacheBytes: 2 * FINE * height * 2 + 1,
        maxMaskFrameCacheSize: 100,
        onMaskFrameEvicted: evicted,
        prefetchFrameCount: 4,
        preparedWindowScanIntervalSeconds: 0,
        renderPreparation: {
          maskFrame: { scheduleBatchSize: 4, workerCount },
          workerFactory: {
            createWorker: () => workers[createdWorkerCount++]!.worker,
          },
        },
        resolveMaxRasterWidth: () => FINE,
      });
      const drain = async () => {
        await vi.advanceTimersByTimeAsync(0);
        for (
          let count = 0;
          count < 12 && pendingRequestCount() > 0;
          count += 1
        ) {
          for (const worker of workers) {
            if (worker.pendingRequestCount > 0) worker.completeNext();
          }
          await vi.advanceTimersByTimeAsync(0);
        }
      };

      try {
        renderWindow.getFrame(at(0));
        await drain();
        expect(
          pendingRequestCount(),
          JSON.stringify({
            requests: requests().map((request) => request.job.key),
            progress: renderWindow.getPreparationProgress(),
            evictions: evicted.mock.calls.length,
          }),
        ).toBe(0);
        expect(requests().map((request) => request.job.key)).toEqual(
          frames
            .slice(0, Math.max(2, workerCount))
            .map((frame) => `${frame.frameIndex}:${frame.mediaTime}`),
        );
        const progress = renderWindow.getPreparationProgress();
        const evictionCount = evicted.mock.calls.length;
        await vi.advanceTimersByTimeAsync(500);
        expect(renderWindow.getPreparationProgress()).toBe(progress);
        expect(evicted).toHaveBeenCalledTimes(evictionCount);
        expect(
          renderWindow.needsPlaybackGateWait(at(0), {
            enabled: true,
            resumeAtSeconds: 1,
            stopBelowSeconds: 1,
          }),
        ).toBe(false);

        renderWindow.getFrame(at(1));
        await drain();
        expect(pendingRequestCount()).toBe(0);
        expect(renderWindow.getFrame(at(1))?.maskFrame?.width).toBe(FINE);
        expect(
          requests().filter((request) => request.job.key === "2:0.08"),
        ).toHaveLength(workerCount === 1 ? 1 : 2);
        expect(
          renderWindow.needsPlaybackGateWait(at(1), {
            enabled: true,
            resumeAtSeconds: 1,
            stopBelowSeconds: 1,
          }),
        ).toBe(false);
      } finally {
        renderWindow.destroy();
      }
    },
  );

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
