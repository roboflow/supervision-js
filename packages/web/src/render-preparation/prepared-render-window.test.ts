import { describe, expect, it, vi } from "vitest";

import { BaseMaskStyle } from "supervision-js-core";
import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
} from "supervision-js-core";
import {
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import {
  RenderPreparationArtifactKind,
  RenderPreparationArtifactFrameStatus,
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";

import { resetMocks } from "../../../../test/media-renderer-harness";
import { MaskPreparationWorkerMessageType } from "./mask-preparation-worker-protocol";
import { createPreparedRenderWindow } from "./prepared-render-window";

const frames: DetectionFrame[] = [
  {
    detections: [
      {
        mask: {
          counts: "021",
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 2,
        },
      },
    ],
    frameIndex: 0,
    mediaTime: 0,
  },
  {
    detections: [
      {
        mask: {
          counts: "021",
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 2,
        },
      },
    ],
    frameIndex: 1,
    mediaTime: 0.04,
  },
];
const denseFrames = Array.from({ length: 4 }, (_, frameIndex) => ({
  detections: [
    {
      mask: {
        counts: "021",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 2,
        width: 2,
      },
    },
  ],
  frameIndex,
  mediaTime: frameIndex * 0.04,
})) satisfies DetectionFrame[];
const manyFrames = Array.from({ length: 10 }, (_, frameIndex) => ({
  detections: [
    {
      mask: {
        counts: "021",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 2,
        width: 2,
      },
    },
  ],
  frameIndex,
  mediaTime: frameIndex * 0.04,
})) satisfies DetectionFrame[];

describe("prepared render window", () => {
  it("prepares and returns a cached mask artifact for the active frame", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
      });

      expect(renderWindow.getFrame(0)?.maskFrame).toBeUndefined();

      await vi.runOnlyPendingTimersAsync();

      expect(renderWindow.getFrame(0)?.maskFrame).toMatchObject({
        height: 2,
        key: "0:0",
        width: 2,
      });

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prepares polygon raster instructions through the shared worker window", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        artifactKind: RenderPreparationArtifactKind.PolygonFrame,
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: { onDiagnostics },
        resolveInstructions: () => [
          {
            alpha: 0.2,
            color: 0xff0000,
            detectionIndex: 0,
            polygon: {
              height: 4,
              points: [
                { x: 0, y: 0 },
                { x: 3, y: 0 },
                { x: 3, y: 3 },
              ],
              width: 4,
            },
          },
        ],
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      expect(renderWindow.getFrame(0)?.maskFrame).toMatchObject({
        height: 4,
        key: "0:0",
        width: 4,
      });
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              kind: RenderPreparationArtifactKind.PolygonFrame,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports active mask frame status separately from background pending work", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: {
                key: "0:0",
                mediaTime: 0,
                status: RenderPreparationArtifactFrameStatus.Pending,
              },
              kind: RenderPreparationArtifactKind.MaskFrame,
            }),
          ],
        }),
      );

      await vi.runOnlyPendingTimersAsync();
      renderWindow.getFrame(0);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: {
                key: "0:0",
                mediaTime: 0,
                status: RenderPreparationArtifactFrameStatus.Prepared,
              },
              kind: RenderPreparationArtifactKind.MaskFrame,
              preparedAheadFrameCount: 1,
              preparedAheadSeconds: 0,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for browser idle time to start active mask preparation", async () => {
    vi.useFakeTimers();
    resetMocks();

    const browserWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void) => number;
    };
    const originalRequestIdleCallback = browserWindow.requestIdleCallback;

    try {
      browserWindow.requestIdleCallback = vi.fn(() => 1);

      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
      });

      expect(renderWindow.getFrame(0)?.maskFrame).toBeUndefined();

      await vi.runOnlyPendingTimersAsync();

      expect(browserWindow.requestIdleCallback).not.toHaveBeenCalled();
      expect(renderWindow.getFrame(0)?.maskFrame).toMatchObject({
        height: 2,
        key: "0:0",
        width: 2,
      });

      renderWindow.destroy();
    } finally {
      browserWindow.requestIdleCallback = originalRequestIdleCallback;
      vi.useRealTimers();
    }
  });

  it("reuses prepared mask artifacts when only presentation opacity changes", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onMaskFramesCleared = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: createArtifactStableMaskStyle(0.2),
        onMaskFramesCleared,
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      const preparedFrame = renderWindow.getFrame(0)?.maskFrame;

      renderWindow.setMaskStyle(createArtifactStableMaskStyle(0.8));

      expect(onMaskFramesCleared).not.toHaveBeenCalled();
      expect(renderWindow.getFrame(0)?.maskFrame).toBe(preparedFrame);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts prepared mask artifacts through the eviction callback", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onMaskFrameEvicted = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
        maxMaskFrameCacheSize: 1,
        onMaskFrameEvicted,
        prefetchFrameCount: 1,
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      renderWindow.getFrame(0.04);
      await vi.runOnlyPendingTimersAsync();

      expect(onMaskFrameEvicted).toHaveBeenCalledWith("0:0");

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the selected active frame when prefetch starts after the media timestamp", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createFloorTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 3,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 3,
            scheduleBatchSize: 10,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0.05);
      await flushMaskPreparationTimers(10);

      expect(renderWindow.getFrame(0.05)?.maskFrame).toMatchObject({
        key: "1:0.04",
      });
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: expect.objectContaining({
                key: "1:0.04",
                status: RenderPreparationArtifactFrameStatus.Prepared,
              }),
              preparedAheadFrameCount: 3,
              preparedCount: 3,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors mask-frame render-preparation prefetch and cache options", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const onMaskFrameEvicted = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(denseFrames),
        maskStyle: new BaseMaskStyle(),
        onMaskFrameEvicted,
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 2,
            prefetchFrameCount: 3,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(4);

      expect(onMaskFrameEvicted).toHaveBeenCalledWith("1:0.04");
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              kind: RenderPreparationArtifactKind.MaskFrame,
              maxPreparedCount: 2,
              prefetchCount: 3,
              preparedCount: 2,
              window: {
                availableFrameCount: 4,
                refillThresholdFrameCount: 2,
                targetFrameCount: 3,
              },
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes prepared mask artifacts when the prepared cache evicts them", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const closeByKey = new Map<string, ReturnType<typeof vi.fn>>();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
        maxMaskFrameCacheSize: 1,
        onMaskFramePrepared(maskFrame) {
          const originalClose = maskFrame.close;
          const close = vi.fn(() => {
            originalClose();
          });

          Object.defineProperty(maskFrame, "close", {
            configurable: true,
            value: close,
          });
          closeByKey.set(maskFrame.key, close);
        },
        prefetchFrameCount: 1,
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      renderWindow.getFrame(0.04);
      await vi.runOnlyPendingTimersAsync();

      expect(closeByKey.get("0:0")).toHaveBeenCalledOnce();
      expect(closeByKey.get("1:0.04")).not.toHaveBeenCalled();

      renderWindow.destroy();
      expect(closeByKey.get("1:0.04")).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports only the contiguous prepared run ahead of the active frame", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(denseFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 4,
            prefetchFrameCount: 1,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0.12);
      await flushMaskPreparationTimers(2);
      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(2);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: {
                key: "0:0",
                mediaTime: 0,
                status: RenderPreparationArtifactFrameStatus.Prepared,
              },
              preparedAheadFrameCount: 1,
              preparedAheadSeconds: 0,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps warming the last prepared target without waiting for playback ticks", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 10,
            prefetchFrameCount: 10,
            scheduleBatchSize: 2,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(30);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              preparedAheadFrameCount: 10,
              preparedAheadSeconds: 0.36,
              preparedCount: 10,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits one diagnostic update for a background scheduling batch", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 10,
            prefetchFrameCount: 10,
            scheduleBatchSize: 10,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0);

      expect(onDiagnostics).toHaveBeenCalledTimes(3);
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              pendingCount: 10,
              window: expect.objectContaining({
                targetFrameCount: 10,
              }),
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tops the prepared target back up when ready-ahead reaches the low watermark", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const onMaskFramePrepared = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        onMaskFramePrepared,
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 10,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 7,
            scheduleBatchSize: 10,
            scanIntervalSeconds: 999,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(20);

      expect(onMaskFramePrepared).toHaveBeenCalledTimes(7);

      renderWindow.getFrame(0.04);
      await flushMaskPreparationTimers(2);
      expect(onMaskFramePrepared).toHaveBeenCalledTimes(7);

      renderWindow.getFrame(0.08);
      await flushMaskPreparationTimers(20);

      expect(
        onMaskFramePrepared.mock.calls.map(
          (call) => (call[0] as { readonly key: string }).key,
        ),
      ).toEqual([
        "0:0",
        "1:0.04",
        "2:0.08",
        "3:0.12",
        "4:0.16",
        "5:0.2",
        "6:0.24",
        "7:0.28",
        "8:0.32",
      ]);
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: expect.objectContaining({
                key: "2:0.08",
              }),
              preparedAheadFrameCount: 7,
              refillThresholdCount: 5,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps prepared lookahead across a looping media boundary", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const onMaskFramePrepared = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        onMaskFramePrepared,
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 10,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 7,
            scheduleBatchSize: 10,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      (
        renderWindow as unknown as {
          setTimelineContext(context: {
            readonly duration: number;
            readonly loop: boolean;
          }): void;
        }
      ).setTimelineContext({ duration: 0.4, loop: true });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(20);
      renderWindow.getFrame(0.28);
      await flushMaskPreparationTimers(20);

      expect(
        onMaskFramePrepared.mock.calls.map(
          (call) => (call[0] as { readonly key: string }).key,
        ),
      ).toEqual([
        "0:0",
        "1:0.04",
        "2:0.08",
        "3:0.12",
        "4:0.16",
        "5:0.2",
        "6:0.24",
        "7:0.28",
        "8:0.32",
        "9:0.36",
      ]);
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: expect.objectContaining({
                key: "7:0.28",
              }),
              preparedAheadFrameCount: 7,
              preparedAheadSeconds: expect.closeTo(0.24),
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts concurrent mask preparations up to the configured worker count", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorkers: ReturnType<typeof createFakeMaskPreparationWorker>[] =
        [];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 6,
            prefetchFrameCount: 6,
            scheduleBatchSize: 6,
            scanIntervalSeconds: 0,
            workerCount: 3,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => {
              const fakeWorker = createFakeMaskPreparationWorker({
                autoComplete: false,
              });

              fakeWorkers.push(fakeWorker);
              return fakeWorker.worker;
            },
          },
        },
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      expect(fakeWorkers).toHaveLength(3);
      expect(
        fakeWorkers.flatMap((worker) =>
          worker.messages.map(
            (message) =>
              (message as { readonly job: { readonly key: string } }).job.key,
          ),
        ),
      ).toEqual(["0:0", "1:0.04", "2:0.08"]);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits until the active mask and requested lookahead are prepared", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 3,
            prefetchFrameCount: 3,
            scheduleBatchSize: 3,
            scanIntervalSeconds: 0,
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });
      const ready = vi.fn();

      void (
        renderWindow as unknown as {
          waitForReady(
            mediaTime: number,
            options: { readonly requiredAheadSeconds: number },
          ): Promise<void>;
        }
      )
        .waitForReady(0, { requiredAheadSeconds: 0.08 })
        .then(ready);

      await vi.runOnlyPendingTimersAsync();

      expect(ready).not.toHaveBeenCalled();

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      expect(ready).not.toHaveBeenCalled();

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      expect(ready).not.toHaveBeenCalled();

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      expect(ready).toHaveBeenCalledOnce();

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait when prepared lookahead remains above the low watermark", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 4,
            prefetchFrameCount: 4,
            scheduleBatchSize: 4,
            scanIntervalSeconds: 0,
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);

      const ready = vi.fn();

      void renderWindow
        .waitForReady(0, {
          minimumAheadSeconds: 0.04,
          requiredAheadSeconds: 0.12,
        })
        .then(ready);
      await Promise.resolve();

      expect(ready).toHaveBeenCalledOnce();

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the prepared target window around playback-gated frames", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 4,
            prefetchFrameCount: 3,
            scheduleBatchSize: 3,
            scanIntervalSeconds: 10,
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);

      const ready = vi.fn();

      void renderWindow
        .waitForReady(0.04, { requiredAheadSeconds: 0.08 })
        .then(ready);

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      expect(ready).not.toHaveBeenCalled();

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      expect(ready).not.toHaveBeenCalled();

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      expect(ready).toHaveBeenCalledOnce();

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits background mask scheduling while always admitting the active frame", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 2,
            prefetchFrameCount: 10,
            scheduleBatchSize: 2,
            scanIntervalSeconds: 0,
          },
          onDiagnostics,
        },
      });

      renderWindow.getFrame(0);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              maxPendingCount: 2,
              pendingCount: 2,
              scheduleBatchSize: 2,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the mask queue bounded when active frames advance faster than preparation", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 3,
            prefetchFrameCount: 10,
            scheduleBatchSize: 2,
            scanIntervalSeconds: 0,
          },
          mode: RenderPreparationMode.Worker,
          onDiagnostics,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });

      for (const frame of manyFrames) {
        renderWindow.getFrame(frame.mediaTime);
      }

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              activeFrame: {
                key: "9:0.36",
                mediaTime: 0.36,
                status: RenderPreparationArtifactFrameStatus.Pending,
              },
              maxPendingCount: 3,
              pendingCount: 1,
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets pending worker work when mask style invalidates artifacts", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const workers = [createFakeMaskPreparationWorker()];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: createArtifactStableMaskStyle(0.2, "first"),
        renderPreparation: {
          maskFrame: {
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => {
              const worker =
                workers[workers.length - 1] ??
                createFakeMaskPreparationWorker();

              if (worker.terminated) {
                const nextWorker = createFakeMaskPreparationWorker();
                workers.push(nextWorker);
                return nextWorker.worker;
              }

              return worker.worker;
            },
          },
        },
      });

      renderWindow.getFrame(0);
      renderWindow.setMaskStyle(createArtifactStableMaskStyle(0.8, "second"));
      renderWindow.getFrame(0);

      expect(workers[0]?.terminated).toBe(true);
      expect(workers).toHaveLength(2);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can prepare mask artifacts with an injected worker factory", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker();
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          mode: RenderPreparationMode.Worker,
          onDiagnostics,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });

      expect(renderWindow.getFrame(0)?.maskFrame).toBeUndefined();

      await flushMaskPreparationTimers(4);

      expect(fakeWorker.messages).toHaveLength(2);
      expect(renderWindow.getFrame(0)?.maskFrame).toMatchObject({
        height: 2,
        key: "0:0",
        width: 2,
      });
      expect(onDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              kind: RenderPreparationArtifactKind.MaskFrame,
            }),
          ],
          executionMode: RenderPreparationExecutionMode.Worker,
          workerStatus: RenderPreparationWorkerStatus.Ready,
        }),
      );

      renderWindow.destroy();
      expect(fakeWorker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes orphaned worker artifacts after active style invalidates pending work", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const staleImageBitmap = {
        close: vi.fn(),
        height: 2,
        width: 2,
      } as unknown as ImageBitmap;
      const workers = [
        createFakeMaskPreparationWorker({
          autoComplete: false,
          createCompleteData: () => ({ imageBitmap: staleImageBitmap }),
        }),
      ];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: createArtifactStableMaskStyle(0.2, "first"),
        renderPreparation: {
          maskFrame: {
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => {
              const worker =
                workers[workers.length - 1] ??
                createFakeMaskPreparationWorker();

              if (worker.terminated) {
                const nextWorker = createFakeMaskPreparationWorker({
                  autoComplete: false,
                });

                workers.push(nextWorker);
                return nextWorker.worker;
              }

              return worker.worker;
            },
          },
        },
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      renderWindow.setMaskStyle(createArtifactStableMaskStyle(0.8, "second"));
      workers[0]?.completeNext();
      await Promise.resolve();

      expect(staleImageBitmap.close).toHaveBeenCalledOnce();

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createFakeMaskPreparationWorker(
  options: {
    readonly autoComplete?: boolean;
    readonly createCompleteData?: (message: {
      readonly job: { readonly key: string };
      readonly requestId: number;
    }) => Partial<{
      readonly imageBitmap: ImageBitmap;
      readonly imageData: ImageData;
    }>;
  } = {},
) {
  const autoComplete = options.autoComplete ?? true;
  const messages: unknown[] = [];
  const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  let completedMessageCount = 0;
  let terminated = false;
  const completeMessage = (message: {
    readonly job: { readonly key: string };
    readonly requestId: number;
  }) => {
    for (const listener of listeners) {
      const completeData = options.createCompleteData?.(message) ?? {
        imageData: new ImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2),
      };

      listener({
        data: {
          ...completeData,
          key: message.job.key,
          requestId: message.requestId,
          type: MaskPreparationWorkerMessageType.Complete,
        },
      } as MessageEvent<unknown>);
    }
  };
  const worker = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") {
        listeners.push(listener as (event: MessageEvent<unknown>) => void);
      }
    },

    postMessage(message: {
      readonly job: { readonly key: string };
      readonly requestId: number;
    }) {
      messages.push(message);
      if (!autoComplete) {
        return;
      }

      setTimeout(() => {
        completeMessage(message);
        completedMessageCount += 1;
      }, 0);
    },

    terminate() {
      terminated = true;
    },
  } as unknown as Worker;

  return {
    completeNext() {
      const message = messages[completedMessageCount] as
        | {
            readonly job: { readonly key: string };
            readonly requestId: number;
          }
        | undefined;

      if (!message) {
        throw new Error("No pending fake worker message to complete.");
      }

      completeMessage(message);
      completedMessageCount += 1;
    },
    get terminated() {
      return terminated;
    },
    messages,
    worker,
  };
}

async function flushMaskPreparationTimers(count: number) {
  for (let index = 0; index < count; index += 1) {
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
  }
}

function createArtifactStableMaskStyle(
  opacity: number,
  artifactKey = "stable-mask-artifact",
): MaskStyle & { readonly artifactKey: string; readonly opacity: number } {
  return {
    artifactKey,
    opacity,
    resolve(detection) {
      if (!detection.mask) {
        return undefined;
      }

      return {
        alpha: 1,
        color: 0x00ff66,
        mask: detection.mask,
      };
    },
  };
}

function createTimeline(
  detectionFrames: readonly DetectionFrame[],
): BufferedDetectionTimeline {
  return {
    destroy: vi.fn(),
    getBufferedFrames: vi.fn(() => detectionFrames),
    getState: vi.fn(() => ({
      bufferEndTime: 5,
      bufferStartTime: 0,
      detectionCount: detectionFrames.reduce(
        (total, frame) => total + frame.detections.length,
        0,
      ),
      errorMessage: null,
      frameCount: detectionFrames.length,
      requestedEndTime: 5,
      requestedStartTime: 0,
      status: DetectionBufferStatus.Ready,
    })),
    prepare: vi.fn(),
    prefetch: vi.fn(),
    selectFrame: vi.fn((mediaTime: number) =>
      detectionFrames.find((frame) => frame.mediaTime === mediaTime),
    ),
  };
}

function createFloorTimeline(
  detectionFrames: readonly DetectionFrame[],
): BufferedDetectionTimeline {
  const sortedFrames = [...detectionFrames].sort(
    (left, right) => left.mediaTime - right.mediaTime,
  );

  return {
    ...createTimeline(sortedFrames),
    selectFrame: vi.fn((mediaTime: number) =>
      [...sortedFrames].reverse().find((frame) => frame.mediaTime <= mediaTime),
    ),
  };
}
