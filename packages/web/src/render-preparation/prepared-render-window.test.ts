import { describe, expect, it, vi } from "vitest";

import {
  BaseMaskStyle,
  createBufferedDetectionTimeline,
} from "supervision-js-core";
import {
  DetectionBufferStatus,
  DetectionFrameSelectionMode,
  type BufferedDetectionTimeline,
} from "supervision-js-core";
import {
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import { resolveMediaSessionDefaults } from "#sessions/media-session-defaults";
import { MediaSessionMode } from "#types/media-session";
import {
  RenderPreparationArtifactKind,
  RenderPreparationArtifactFrameStatus,
  RenderPreparationExecutionMode,
  RenderPreparationGateHoldReason,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";

import { resetMocks } from "../../../../test/media-renderer-harness";
import { MaskPreparationWorkerMessageType } from "./mask-preparation-worker-protocol";
import { PreparedMaskFrameKind } from "./mask-frame-artifact";
import {
  createPreparedRenderWindow,
  PreparedRenderFrameMaskStatus,
  type PreparedMaskFrame,
} from "./prepared-render-window";

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
const deepFrames = Array.from({ length: 40 }, (_, frameIndex) => ({
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
const HORSE_TRAIL_DURATION_SECONDS = 70.4233;
const HORSE_TRAIL_FRAME_PITCH_SECONDS = 1 / 30.004;
const HORSE_TRAIL_PLAYHEAD_SECONDS = 107 * HORSE_TRAIL_FRAME_PITCH_SECONDS;
const HORSE_TRAIL_BUFFER_END_SECONDS = 10.54;
const horseTrailFrames = Array.from({ length: 340 }, (_, frameIndex) => ({
  detections: [],
  frameIndex,
  mediaTime: frameIndex * HORSE_TRAIL_FRAME_PITCH_SECONDS,
})) satisfies DetectionFrame[];
const GATE_FRAME_RATE = 25;
/* 90 s at the gate's 25 fps. The count is a ceiling only: memory is bounded
   by `maxCacheBytes` (see media-session-defaults.ts). */
const SESSION_MASK_CACHE_FRAME_COUNT = 2250;
const SESSION_PLAYBACK_GATE_OPTIONS = {
  enabled: true,
  resumeAtSeconds: 0.3,
  stopBelowSeconds: 0.1,
};
const gateFrames = Array.from({ length: 400 }, (_, frameIndex) => ({
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
  mediaTime: frameIndex / GATE_FRAME_RATE,
})) satisfies DetectionFrame[];

/**
 * A clip whose detections arrive one every two frames, and one that turns up
 * later between two of them: the shape a source still appending records leaves
 * in a window that is otherwise cooked.
 */
const SPARSE_FRAME_PITCH = 2 / GATE_FRAME_RATE;
const SPARSE_FRAMES = Array.from({ length: 12 }, (_, index) =>
  createGateFrame(index * 2),
) satisfies DetectionFrame[];
const LATE_FRAME = createGateFrame(5) satisfies DetectionFrame;

describe("prepared render window", () => {
  it("keeps prepared overlap across an immutable rolling buffer refresh", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const source = {
        loadFrames: vi.fn(async (startTime: number, endTime: number) =>
          denseFrames.filter(
            (frame) =>
              frame.mediaTime >= startTime && frame.mediaTime < endTime,
          ),
        ),
      };
      const timeline = createBufferedDetectionTimeline({
        bufferAheadSeconds: 0.12,
        bufferBehindSeconds: 0,
        frameIndexOriginTime: 0,
        frameRate: 25,
        refreshIntervalSeconds: 0.04,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        source,
      });

      await timeline.prepare(0);

      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: timeline,
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 3,
        preparedWindowScanIntervalSeconds: 0,
      });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(6);
      const preparedOverlap = renderWindow.getFrame(0.08)?.maskFrame;

      expect(preparedOverlap).toBeDefined();

      timeline.prefetch(0.04);
      await vi.waitFor(() =>
        expect(source.loadFrames).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() =>
        expect(timeline.getState().bufferEndTime).toBeCloseTo(0.16),
      );

      renderWindow.getFrame(0.04);

      expect(renderWindow.getFrame(0.08)?.maskFrame).toBe(preparedOverlap);

      renderWindow.destroy();
      timeline.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts up as preparation finishes frames", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
      });

      expect(renderWindow.getPreparationProgress()).toBe(0);

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      expect(renderWindow.getFrame(0)?.maskFrame).toBeDefined();
      expect(renderWindow.getPreparationProgress()).toBeGreaterThan(0);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a frame whose cook produced no artifact", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: new BaseMaskStyle(),
        resolveInstructions: () => [
          {
            alpha: 1,
            color: 0x00ff66,
            detectionIndex: 0,
            mask: frames[0]!.detections[0]!.mask!,
            visible: false,
          },
        ],
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      expect(renderWindow.getFrame(0)?.maskStatus).toBe(
        PreparedRenderFrameMaskStatus.Empty,
      );
      expect(renderWindow.getPreparationProgress()).toBeGreaterThan(0);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds the active mask artifact when semantic content changes at the same frame key", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const mutableFrames = [frames[0]!] as DetectionFrame[];
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(mutableFrames),
        maskStyle: new BaseMaskStyle(),
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      const originalArtifact = renderWindow.getFrame(0)?.maskFrame;
      const closeOriginalArtifact = vi.spyOn(originalArtifact!, "close");

      expect(renderWindow.getFrame(0)?.maskFrame).toBe(originalArtifact);

      const replacementFrame: DetectionFrame = {
        ...frames[0]!,
        detections: [
          {
            mask: {
              counts: "13",
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 2,
              width: 2,
            },
          },
        ],
      };
      mutableFrames[0] = replacementFrame;

      const beforePreparation = renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      const afterPreparation = renderWindow.getFrame(0);

      expect(beforePreparation?.detectionFrame).toBe(replacementFrame);
      expect(beforePreparation?.maskFrame).toBeUndefined();
      expect(afterPreparation?.maskFrame).not.toBe(originalArtifact);
      expect(closeOriginalArtifact).toHaveBeenCalledOnce();

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a late mask artifact after the same frame key is replaced", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const staleImageBitmap = {
        close: vi.fn(),
        height: 2,
        width: 2,
      } as unknown as ImageBitmap;
      const replacementImageBitmap = {
        close: vi.fn(),
        height: 2,
        width: 2,
      } as unknown as ImageBitmap;
      const completedArtifacts = [staleImageBitmap, replacementImageBitmap];
      const mutableFrames = [frames[0]!] as DetectionFrame[];
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
        createCompleteData: () => ({
          imageBitmap: completedArtifacts.shift(),
        }),
      });
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(mutableFrames),
        maskStyle: new BaseMaskStyle(),
        prefetchFrameCount: 1,
        renderPreparation: {
          maskFrame: { workerCount: 1 },
          mode: RenderPreparationMode.Worker,
          workerFactory: { createWorker: () => fakeWorker.worker },
        },
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      mutableFrames[0] = {
        ...frames[0]!,
        detections: [
          {
            mask: {
              counts: "13",
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 2,
              width: 2,
            },
          },
        ],
      };
      renderWindow.getFrame(0);

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(4);

      expect(staleImageBitmap.close).toHaveBeenCalledOnce();
      expect(fakeWorker.messages).toHaveLength(2);
      expect(renderWindow.getFrame(0)?.maskFrame).toBeUndefined();

      fakeWorker.completeNext();
      await flushMaskPreparationTimers(4);

      expect(rgbaSource(renderWindow.getFrame(0)?.maskFrame)).toBe(
        replacementImageBitmap,
      );
      expect(replacementImageBitmap.close).not.toHaveBeenCalled();

      renderWindow.destroy();
      expect(replacementImageBitmap.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

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

      expect(onMaskFrameEvicted).toHaveBeenCalledWith("2:0.08");
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
      expect(renderWindow.getFrame(0.04)?.maskFrame).toMatchObject({
        key: "1:0.04",
      });

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooks only where a dragged playhead lands, not ahead of it", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onMaskFramePrepared = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createFloorTimeline(deepFrames),
        maskStyle: new BaseMaskStyle(),
        onMaskFramePrepared,
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 40,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 7,
            scheduleBatchSize: 10,
            scanIntervalSeconds: 0,
          },
        },
      });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(20);

      expect(onMaskFramePrepared.mock.calls.length).toBe(7);

      /* One jump is a seek that lands, and the window leads it again. */
      renderWindow.getFrame(0.4);
      await flushMaskPreparationTimers(20);

      expect(onMaskFramePrepared.mock.calls.length).toBe(14);

      /* The jumps that follow are a drag, and only their landings cook. */
      renderWindow.getFrame(0.8);
      await flushMaskPreparationTimers(20);
      renderWindow.getFrame(1.2);
      await flushMaskPreparationTimers(20);

      /* The landing the drag stops on is cooked once more at full width. */
      expect([
        ...new Set(
          onMaskFramePrepared.mock.calls
            .slice(14)
            .map((call) => (call[0] as { readonly key: string }).key),
        ),
      ]).toEqual(["20:0.8", "30:1.2"]);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the ground just behind the playhead when the cache overflows", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createFloorTimeline(deepFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: 5,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 3,
            scheduleBatchSize: 10,
            scanIntervalSeconds: 0,
          },
        },
      });

      for (let frameIndex = 0; frameIndex <= 10; frameIndex += 1) {
        renderWindow.getFrame(frameIndex * 0.04);
        await flushMaskPreparationTimers(10);
      }

      expect(renderWindow.getFrame(0.36)?.maskStatus).toBe(
        PreparedRenderFrameMaskStatus.Prepared,
      );
      expect(renderWindow.getFrame(0)?.maskStatus).toBe(
        PreparedRenderFrameMaskStatus.Pending,
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
            options: { readonly resumeAtSeconds: number },
          ): Promise<void>;
        }
      )
        .waitForReady(0, { resumeAtSeconds: 0.08 })
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

  it("stops scheduling and rejects readiness after a strict worker failure", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        errorMessage: "worker crashed",
      });
      const onDiagnostics = vi.fn();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(manyFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 1,
            prefetchFrameCount: 1,
            scanIntervalSeconds: 0,
            scheduleBatchSize: 1,
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          onDiagnostics,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });
      const readiness = renderWindow.waitForReady(0, {
        resumeAtSeconds: 0,
        stopBelowSeconds: 0,
      });
      const rejection = expect(readiness).rejects.toThrow("worker crashed");

      await flushMaskPreparationTimers(2);
      await rejection;

      const messageCount = fakeWorker.messages.length;

      expect(messageCount).toBe(1);
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionMode: RenderPreparationExecutionMode.Worker,
          message: "worker crashed",
          workerStatus: RenderPreparationWorkerStatus.Error,
        }),
      );

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(2);

      expect(fakeWorker.messages).toHaveLength(messageCount);
      await expect(
        renderWindow.waitForReady(0, {
          resumeAtSeconds: 0,
          stopBelowSeconds: 0,
        }),
      ).rejects.toThrow("worker crashed");

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers whether a wait would hold, and schedules nothing to answer it", async () => {
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
      const gateOptions = {
        enabled: true,
        resumeAtSeconds: 0.04,
        stopBelowSeconds: 0.04,
      };

      expect(renderWindow.needsPlaybackGateWait(0, gateOptions)).toBe(true);

      await vi.runOnlyPendingTimersAsync();

      expect(fakeWorker.messages).toHaveLength(0);

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();
      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);
      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);

      const ready = vi.fn();

      expect(renderWindow.needsPlaybackGateWait(0, gateOptions)).toBe(false);

      void renderWindow.waitForReady(0, gateOptions).then(ready);
      await Promise.resolve();

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
          resumeAtSeconds: 0.12,
          stopBelowSeconds: 0.04,
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
        .waitForReady(0.04, { resumeAtSeconds: 0.08, stopBelowSeconds: 0.08 })
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

  it("reuses the worker pool and prepares the replacement generation after style invalidation", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const workers = [
        createFakeMaskPreparationWorker({ autoComplete: false }),
        createFakeMaskPreparationWorker({ autoComplete: false }),
      ];
      const createWorker = vi
        .fn()
        .mockImplementationOnce(() => workers[0]!.worker)
        .mockImplementationOnce(() => workers[1]!.worker);
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(frames),
        maskStyle: createArtifactStableMaskStyle(0.2, "first"),
        renderPreparation: {
          maskFrame: {
            prefetchFrameCount: 1,
            workerCount: 2,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker,
          },
        },
      });

      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      renderWindow.setMaskStyle(createArtifactStableMaskStyle(0.8, "second"));
      renderWindow.getFrame(0);
      await vi.runOnlyPendingTimersAsync();

      expect(createWorker).toHaveBeenCalledTimes(2);
      expect(workers.every((worker) => !worker.terminated)).toBe(true);
      expect(workers[0]!.messages).toHaveLength(1);
      expect(workers[1]!.messages).toHaveLength(1);

      workers[0]!.completeNext();
      await Promise.resolve();
      await Promise.resolve();

      expect(renderWindow.getFrame(0)?.maskFrame).toBeUndefined();

      workers[1]!.completeNext();
      await flushMaskPreparationTimers(4);

      expect(renderWindow.getFrame(0)?.maskFrame).toMatchObject({
        height: 2,
        key: "0:0",
        width: 2,
      });
      expect(createWorker).toHaveBeenCalledTimes(2);

      renderWindow.destroy();
      expect(workers.every((worker) => worker.terminated)).toBe(true);
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
      await flushMaskPreparationTimers(2);

      expect(staleImageBitmap.close).toHaveBeenCalledOnce();

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows a paused window to the playhead frame plus one schedule batch", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPausedScopeRenderWindow({
        onDiagnostics,
        scheduleBatchSize: 2,
      });

      renderWindow.getFrame(0);
      renderWindow.setPlaybackActive(false);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              prefetchCount: 3,
              window: expect.objectContaining({ targetFrameCount: 3 }),
            }),
          ],
        }),
      );

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes the paused margin from the configured schedule batch", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const wideBatch = vi.fn();
      const wideRenderWindow = createPausedScopeRenderWindow({
        onDiagnostics: wideBatch,
        scheduleBatchSize: 4,
      });

      wideRenderWindow.getFrame(0);
      wideRenderWindow.setPlaybackActive(false);

      expect(wideBatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [expect.objectContaining({ prefetchCount: 5 })],
        }),
      );

      const cappedBatch = vi.fn();
      const cappedRenderWindow = createPausedScopeRenderWindow({
        onDiagnostics: cappedBatch,
        prefetchFrameCount: 2,
        scheduleBatchSize: 4,
      });

      cappedRenderWindow.getFrame(0);
      cappedRenderWindow.setPlaybackActive(false);

      expect(cappedBatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [expect.objectContaining({ prefetchCount: 2 })],
        }),
      );

      wideRenderWindow.destroy();
      cappedRenderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a deep prefetch backlog on pause and schedules nothing past the margin", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPausedScopeRenderWindow({
        frames: deepFrames,
        onDiagnostics,
        scheduleBatchSize: 2,
      });

      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(4);

      const backlog = onDiagnostics.mock.lastCall?.[0].artifacts[0];

      expect(backlog?.pendingCount).toBeGreaterThan(3);

      renderWindow.setPlaybackActive(false);

      const preparedOnPause =
        onDiagnostics.mock.lastCall?.[0].artifacts[0]?.preparedCount;

      await flushMaskPreparationTimers(30);

      const drained = onDiagnostics.mock.lastCall?.[0].artifacts[0];

      expect(drained?.inFlightCount).toBe(0);
      expect(drained?.pendingCount).toBe(0);
      expect(drained?.preparedAheadFrameCount).toBe(3);
      expect(drained?.preparedCount).toBeLessThanOrEqual(preparedOnPause + 1);

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooks only the margin when a window is already paused", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onMaskFramePrepared = vi.fn();
      const renderWindow = createPausedScopeRenderWindow({
        onMaskFramePrepared,
        scheduleBatchSize: 2,
      });

      renderWindow.setPlaybackActive(false);
      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(30);

      expect(onMaskFramePrepared).toHaveBeenCalledTimes(3);

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the full prefetch window when playback resumes", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const renderWindow = createPausedScopeRenderWindow({ onDiagnostics });

      renderWindow.getFrame(0);
      renderWindow.setPlaybackActive(false);
      await flushMaskPreparationTimers(30);

      renderWindow.setPlaybackActive(true);
      await flushMaskPreparationTimers(30);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              prefetchCount: 10,
              preparedAheadFrameCount: 10,
              preparedCount: 10,
              window: expect.objectContaining({ targetFrameCount: 10 }),
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooks the visible frame of a paused window landing on a cold region", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const renderWindow = createPausedScopeRenderWindow({});

      renderWindow.setPlaybackActive(false);
      renderWindow.getFrame(0.36);
      await flushMaskPreparationTimers(30);

      expect(renderWindow.getFrame(0.36)?.maskStatus).toBe(
        PreparedRenderFrameMaskStatus.Prepared,
      );

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooks the frames a skipping playhead lands on, not the ones between", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const cookedFrameIndexes = createCookedFrameIndexRecorder();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(deepFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: deepFrames.length,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 2,
            scanIntervalSeconds: 0,
            scheduleBatchSize: 2,
          },
        },
        resolveInstructions: cookedFrameIndexes.resolveInstructions,
      });

      for (const frameIndex of [0, 2, 4, 6, 8, 10]) {
        renderWindow.getFrame(frameIndex * 0.04);
        await flushMaskPreparationTimers(4);
      }

      expect(cookedFrameIndexes.recorded).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12,
      ]);

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a paused margin consecutive however the playhead was scrubbed", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const cookedFrameIndexes = createCookedFrameIndexRecorder();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(deepFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: deepFrames.length,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 10,
            scanIntervalSeconds: 0,
            scheduleBatchSize: 2,
          },
        },
        resolveInstructions: cookedFrameIndexes.resolveInstructions,
      });

      renderWindow.setPlaybackActive(false);

      for (const frameIndex of [0, 2, 4, 6, 8]) {
        renderWindow.getFrame(frameIndex * 0.04);
        await flushMaskPreparationTimers(4);
      }

      expect(cookedFrameIndexes.recorded.slice(-3)).toEqual([8, 9, 10]);

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to cooking every frame once the playhead stops skipping", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const cookedFrameIndexes = createCookedFrameIndexRecorder();
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline: createTimeline(deepFrames),
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: deepFrames.length,
            maxPendingFrameCount: 10,
            prefetchFrameCount: 2,
            scanIntervalSeconds: 0,
            scheduleBatchSize: 2,
          },
        },
        resolveInstructions: cookedFrameIndexes.resolveInstructions,
      });

      for (const frameIndex of [0, 2, 4, 6, 8]) {
        renderWindow.getFrame(frameIndex * 0.04);
        await flushMaskPreparationTimers(4);
      }

      cookedFrameIndexes.recorded.length = 0;
      renderWindow.setPlaybackActive(false);
      await flushMaskPreparationTimers(4);

      expect(cookedFrameIndexes.recorded).toEqual([9]);

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a paused step inside the margin", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const onMaskFramePrepared = vi.fn();
      const renderWindow = createPausedScopeRenderWindow({
        onDiagnostics,
        onMaskFramePrepared,
        scheduleBatchSize: 2,
      });

      renderWindow.setPlaybackActive(false);
      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(30);

      renderWindow.getFrame(0.04);
      await flushMaskPreparationTimers(30);

      expect(onMaskFramePrepared).toHaveBeenCalledTimes(4);
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              pendingCount: 0,
              preparedAheadFrameCount: 3,
              window: expect.objectContaining({ targetFrameCount: 3 }),
            }),
          ],
        }),
      );

      renderWindow.setPlaybackActive(true);
      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the reach of the run it cooked, not a lap back to a frame the playhead has passed", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const onDiagnostics = vi.fn();
      const detectionTimeline = createBufferedSpanTimeline(horseTrailFrames);
      const renderWindow = createPreparedRenderWindow({
        detectionTimeline,
        maskStyle: new BaseMaskStyle(),
        renderPreparation: {
          maskFrame: {
            maxPendingFrameCount: 400,
            prefetchFrameCount: 211,
            scheduleBatchSize: 400,
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
      ).setTimelineContext({
        duration: HORSE_TRAIL_DURATION_SECONDS,
        loop: true,
      });

      detectionTimeline.setBufferSpan(0, 0);
      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(20);

      detectionTimeline.setBufferSpan(
        HORSE_TRAIL_PLAYHEAD_SECONDS,
        HORSE_TRAIL_BUFFER_END_SECONDS,
      );
      renderWindow.getFrame(HORSE_TRAIL_PLAYHEAD_SECONDS);
      await flushMaskPreparationTimers(20);

      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              preparedAheadFrameCount: 210,
              preparedAheadSeconds: expect.closeTo(6.9657, 3),
            }),
          ],
        }),
      );

      renderWindow.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a 25fps file session to the settings the gate tests run at", () => {
    const defaults = resolveMediaSessionDefaults({
      detections: { frames: [], sync: { frameRate: GATE_FRAME_RATE } },
      mode: MediaSessionMode.File,
    });

    expect(defaults.renderPreparation.maskFrame).toEqual({
      maxCacheFrameCount: SESSION_MASK_CACHE_FRAME_COUNT,
      maxPendingFrameCount: 24,
      prefetchFrameCount: 175,
      scanIntervalSeconds: 0.1,
      scheduleBatchSize: 16,
    });
    expect(defaults.renderPreparation.playbackGate).toEqual({
      enabled: true,
      maxWaitSeconds: 2,
      requiredAheadSeconds: 1,
      resumeMarginWallSeconds: 0.2,
      stopBelowWallSeconds: 0.1,
    });
  });

  it("keeps preparing for a holding gate after the playhead has jumped", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker();
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createGateRenderWindow({
        onDiagnostics: (next) => diagnostics.push(next),
        worker: fakeWorker.worker,
      });

      renderWindow.setPlaybackActive(true);
      renderWindow.getFrame(gateFrameTime(0));
      renderWindow.getFrame(gateFrameTime(25));

      let resolved = false;

      void renderWindow
        .waitForReady(gateFrameTime(50), SESSION_PLAYBACK_GATE_OPTIONS)
        .then(() => {
          resolved = true;
        });

      for (let pass = 0; pass < 400 && !resolved; pass += 1) {
        await flushMaskPreparationTimers(1);
      }

      const artifact = diagnostics[diagnostics.length - 1]?.artifacts?.[0];
      const gateResolved = resolved;

      renderWindow.destroy();

      expect({
        gateHold: artifact?.gateHold?.reason ?? null,
        resolved: gateResolved,
      }).toEqual({
        gateHold: null,
        resolved: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("banks a lead past a frame the scheduler is already cooking", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const detectionTimeline = createAppendableFloorTimeline(SPARSE_FRAMES);
      const renderWindow = createGateRenderWindow({
        detectionTimeline,
        onDiagnostics: (next) => diagnostics.push(next),
        worker: fakeWorker.worker,
      });

      renderWindow.setPlaybackActive(true);
      renderWindow.getFrame(0);

      for (let index = 0; index < SPARSE_FRAMES.length; index += 1) {
        await flushMaskPreparationTimers(2);
        fakeWorker.completeNext();
      }

      await flushMaskPreparationTimers(2);
      detectionTimeline.append(LATE_FRAME);
      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(2);

      const artifact = diagnostics[diagnostics.length - 1]?.artifacts?.[0];

      renderWindow.destroy();

      expect({
        activeStatus: artifact?.activeFrame?.status,
        preparedAheadFrameCount: artifact?.preparedAheadFrameCount,
        preparedAheadSeconds: artifact?.preparedAheadSeconds,
      }).toEqual({
        activeStatus: RenderPreparationArtifactFrameStatus.Prepared,
        preparedAheadFrameCount: SPARSE_FRAMES.length,
        preparedAheadSeconds: SPARSE_FRAME_PITCH * (SPARSE_FRAMES.length - 1),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the picture for an uncooked frame under the playhead", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const detectionTimeline = createAppendableFloorTimeline(SPARSE_FRAMES);
      const renderWindow = createGateRenderWindow({
        detectionTimeline,
        onDiagnostics: (next) => diagnostics.push(next),
        worker: fakeWorker.worker,
      });

      renderWindow.setPlaybackActive(true);
      renderWindow.getFrame(0);

      for (let index = 0; index < SPARSE_FRAMES.length; index += 1) {
        await flushMaskPreparationTimers(2);
        fakeWorker.completeNext();
      }

      await flushMaskPreparationTimers(2);
      detectionTimeline.append(LATE_FRAME);
      renderWindow.getFrame(0);
      await flushMaskPreparationTimers(2);

      const abandonedWait = new AbortController();
      const held = renderWindow.needsPlaybackGateWait(
        LATE_FRAME.mediaTime,
        SESSION_PLAYBACK_GATE_OPTIONS,
      );

      void renderWindow.waitForReady(
        LATE_FRAME.mediaTime,
        SESSION_PLAYBACK_GATE_OPTIONS,
        abandonedWait.signal,
      );

      const gateHold =
        diagnostics[diagnostics.length - 1]?.artifacts?.[0]?.gateHold;

      abandonedWait.abort();
      renderWindow.destroy();

      expect({ gateHold, held }).toEqual({
        gateHold: {
          reason: RenderPreparationGateHoldReason.ActiveFrameUnprepared,
          requiredAheadSeconds: SESSION_PLAYBACK_GATE_OPTIONS.resumeAtSeconds,
        },
        held: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a cooked frame whose prepared lead is short of the requirement", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker({
        autoComplete: false,
      });
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createGateRenderWindow({
        onDiagnostics: (next) => diagnostics.push(next),
        worker: fakeWorker.worker,
      });
      const abandonedWait = new AbortController();

      renderWindow.setPlaybackActive(true);
      renderWindow.getFrame(gateFrameTime(0));
      await flushMaskPreparationTimers(2);
      fakeWorker.completeNext();
      await flushMaskPreparationTimers(2);

      void renderWindow.waitForReady(
        gateFrameTime(0),
        SESSION_PLAYBACK_GATE_OPTIONS,
        abandonedWait.signal,
      );

      const artifact = diagnostics[diagnostics.length - 1]?.artifacts?.[0];

      abandonedWait.abort();
      renderWindow.destroy();

      expect({
        activeStatus: artifact?.activeFrame?.status,
        gateHold: artifact?.gateHold,
        preparedAheadFrameCount: artifact?.preparedAheadFrameCount,
        preparedAheadSeconds: artifact?.preparedAheadSeconds,
      }).toEqual({
        activeStatus: RenderPreparationArtifactFrameStatus.Prepared,
        gateHold: {
          reason: RenderPreparationGateHoldReason.LeadBelowRequirement,
          requiredAheadSeconds: SESSION_PLAYBACK_GATE_OPTIONS.resumeAtSeconds,
        },
        preparedAheadFrameCount: 1,
        preparedAheadSeconds: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /* The session banks a second, and a stop does not last until it is full: the
   * picture comes back at the stop threshold plus its margin, so banking more
   * buys cooked frames rather than a longer freeze. Only a cache too small to
   * hold even that margin moves the release. */
  it.each([
    { expectedLeadSeconds: 0.2, maxCacheFrameCount: 6 },
    { expectedLeadSeconds: 0.32, maxCacheFrameCount: 24 },
    { expectedLeadSeconds: 0.32, maxCacheFrameCount: 26 },
    {
      expectedLeadSeconds: 0.32,
      maxCacheFrameCount: SESSION_MASK_CACHE_FRAME_COUNT,
    },
  ])(
    "releases a gate banking a second at a lead of $expectedLeadSeconds on a $maxCacheFrameCount frame cache",
    async ({ expectedLeadSeconds, maxCacheFrameCount }) => {
      vi.useFakeTimers();
      resetMocks();

      try {
        const fakeWorker = createFakeMaskPreparationWorker();
        const diagnostics: RenderPreparationDiagnostics[] = [];
        const renderWindow = createGateRenderWindow({
          maxCacheFrameCount,
          onDiagnostics: (next) => diagnostics.push(next),
          worker: fakeWorker.worker,
        });

        renderWindow.setPlaybackActive(true);
        renderWindow.getFrame(gateFrameTime(0));

        let leadSecondsAtRelease: number | null = null;
        let resolved = false;

        void renderWindow
          .waitForReady(gateFrameTime(0), SESSION_PLAYBACK_GATE_OPTIONS)
          .then(() => {
            leadSecondsAtRelease =
              diagnostics[diagnostics.length - 1]?.artifacts?.[0]
                ?.preparedAheadSeconds ?? null;
            resolved = true;
          });

        for (let pass = 0; pass < 400 && !resolved; pass += 1) {
          await flushMaskPreparationTimers(1);
        }

        const releaseLead = leadSecondsAtRelease;
        const gateResolved = resolved;

        renderWindow.destroy();

        expect({
          leadSecondsAtRelease: releaseLead,
          resolved: gateResolved,
        }).toEqual({
          leadSecondsAtRelease: expectedLeadSeconds,
          resolved: true,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("asks for the whole requirement while the playhead sits off the scanned window", () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker();
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createGateRenderWindow({
        detectionTimeline: createRolledBufferTimeline(
          gateFrames,
          gateFrameTime(100),
        ),
        onDiagnostics: (next) => diagnostics.push(next),
        worker: fakeWorker.worker,
      });
      const abandonedWait = new AbortController();

      renderWindow.setPlaybackActive(true);

      void renderWindow.waitForReady(
        gateFrameTime(50),
        SESSION_PLAYBACK_GATE_OPTIONS,
        abandonedWait.signal,
      );

      const gateHold =
        diagnostics[diagnostics.length - 1]?.artifacts?.[0]?.gateHold;

      abandonedWait.abort();
      renderWindow.destroy();

      expect(gateHold).toEqual({
        reason: RenderPreparationGateHoldReason.ActiveFrameUnprepared,
        requiredAheadSeconds: SESSION_PLAYBACK_GATE_OPTIONS.resumeAtSeconds,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the dragged playhead suppress preparation again once an abandoned wait is aborted", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker();
      const diagnostics: RenderPreparationDiagnostics[] = [];
      const renderWindow = createGateRenderWindow({
        onDiagnostics: (next) => diagnostics.push(next),
        worker: fakeWorker.worker,
      });
      const abandonedWait = new AbortController();
      /* The hold is read after the first step: a held window keeps cooking
         through the drag, and enough lands to let the wait through before the
         drag is over. */
      const dragPlayhead = async (fromFrameIndex: number) => {
        let holdReasonAfterFirstStep: string | null = null;
        for (let step = 0; step < 4; step += 1) {
          renderWindow.getFrame(gateFrameTime(fromFrameIndex + step * 40));
          await flushMaskPreparationTimers(40);
          if (step === 0) {
            holdReasonAfterFirstStep =
              diagnostics[diagnostics.length - 1]?.artifacts?.[0]?.gateHold
                ?.reason ?? null;
          }
        }

        return {
          holdReason: holdReasonAfterFirstStep,
          preparedAhead:
            diagnostics[diagnostics.length - 1]?.artifacts?.[0]
              ?.preparedAheadFrameCount ?? 0,
        };
      };

      renderWindow.setPlaybackActive(true);
      renderWindow.getFrame(gateFrameTime(0));
      await flushMaskPreparationTimers(2);

      void renderWindow.waitForReady(
        gateFrameTime(200),
        SESSION_PLAYBACK_GATE_OPTIONS,
        abandonedWait.signal,
      );
      await flushMaskPreparationTimers(2);
      renderWindow.setMaskStyle(createArtifactStableMaskStyle(0.5));

      const held = await dragPlayhead(0);

      abandonedWait.abort();

      const abandoned = await dragPlayhead(240);

      renderWindow.destroy();

      expect({
        abandonedReason: abandoned.holdReason,
        heldReason: held.holdReason,
        preparedAheadAfterAbort: abandoned.preparedAhead,
      }).toEqual({
        abandonedReason: null,
        heldReason: RenderPreparationGateHoldReason.ActiveFrameUnprepared,
        preparedAheadAfterAbort: 1,
      });
      expect(held.preparedAhead).toBeGreaterThanOrEqual(20);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createPausedScopeRenderWindow(options: {
  readonly frames?: readonly DetectionFrame[];
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly onMaskFramePrepared?: (maskFrame: PreparedMaskFrame) => void;
  readonly prefetchFrameCount?: number;
  readonly scheduleBatchSize?: number;
}) {
  const frames = options.frames ?? manyFrames;

  return createPreparedRenderWindow({
    detectionTimeline: createTimeline(frames),
    maskStyle: new BaseMaskStyle(),
    onMaskFramePrepared: options.onMaskFramePrepared,
    renderPreparation: {
      maskFrame: {
        maxCacheFrameCount: frames.length,
        maxPendingFrameCount: 10,
        prefetchFrameCount: options.prefetchFrameCount ?? frames.length,
        scanIntervalSeconds: 0,
        scheduleBatchSize: options.scheduleBatchSize ?? 2,
      },
      onDiagnostics: options.onDiagnostics,
    },
  });
}

/** Records which frames the window actually started a cook for, in order. */
function createCookedFrameIndexRecorder() {
  const recorded: number[] = [];

  return {
    recorded,
    resolveInstructions({ frame }: { readonly frame: DetectionFrame }) {
      recorded.push(frame.frameIndex ?? -1);

      return [
        {
          alpha: 1,
          color: 0x00ff66,
          detectionIndex: 0,
          mask: frame.detections[0]?.mask,
        },
      ] as never;
    },
  };
}

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
    readonly errorMessage?: string;
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
      if (options.errorMessage) {
        listener({
          data: {
            error: options.errorMessage,
            key: message.job.key,
            requestId: message.requestId,
            type: MaskPreparationWorkerMessageType.Error,
          },
        } as MessageEvent<unknown>);
        continue;
      }

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

function createBufferedSpanTimeline(
  detectionFrames: readonly DetectionFrame[],
): BufferedDetectionTimeline & {
  setBufferSpan(startTime: number, endTime: number): void;
} {
  let bufferStartTime = 0;
  let bufferEndTime = 0;
  const readBufferedFrames = () =>
    detectionFrames.filter(
      (frame) =>
        frame.mediaTime >= bufferStartTime && frame.mediaTime <= bufferEndTime,
    );

  return {
    destroy: vi.fn(),
    getBufferedFrames: vi.fn(readBufferedFrames),
    getState: vi.fn(() => ({
      bufferEndTime,
      bufferStartTime,
      detectionCount: 0,
      errorMessage: null,
      frameCount: readBufferedFrames().length,
      requestedEndTime: bufferEndTime,
      requestedStartTime: bufferStartTime,
      status: DetectionBufferStatus.Ready,
    })),
    prepare: vi.fn(),
    prefetch: vi.fn(),
    selectFrame: vi.fn((mediaTime: number) =>
      readBufferedFrames().find((frame) => frame.mediaTime === mediaTime),
    ),
    setBufferSpan(startTime: number, endTime: number) {
      bufferStartTime = startTime;
      bufferEndTime = endTime;
    },
  };
}

/**
 * A timeline whose buffer has rolled forward off the frame the playhead is
 * parked on: the frame still resolves, and no scan of the buffer can reach it.
 */
function createRolledBufferTimeline(
  detectionFrames: readonly DetectionFrame[],
  bufferStartTime: number,
): BufferedDetectionTimeline {
  const bufferedFrames = detectionFrames.filter(
    (frame) => frame.mediaTime >= bufferStartTime,
  );
  const bufferEndTime =
    (bufferedFrames[bufferedFrames.length - 1]?.mediaTime ?? bufferStartTime) +
    1 / GATE_FRAME_RATE;

  return {
    destroy: vi.fn(),
    getBufferedFrames: vi.fn(() => bufferedFrames),
    getState: vi.fn(() => ({
      bufferEndTime,
      bufferStartTime,
      detectionCount: bufferedFrames.length,
      errorMessage: null,
      frameCount: bufferedFrames.length,
      requestedEndTime: bufferEndTime,
      requestedStartTime: bufferStartTime,
      status: DetectionBufferStatus.Ready,
    })),
    prepare: vi.fn(),
    prefetch: vi.fn(),
    selectFrame: vi.fn((mediaTime: number) =>
      detectionFrames.find((frame) => frame.mediaTime === mediaTime),
    ),
  };
}

function createGateFrame(frameIndex: number): DetectionFrame {
  return {
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
    mediaTime: gateFrameTime(frameIndex),
  };
}

function createAppendableFloorTimeline(
  initialFrames: readonly DetectionFrame[],
): BufferedDetectionTimeline & {
  append(frame: DetectionFrame): void;
} {
  let frames = [...initialFrames];

  return {
    append(frame) {
      frames = [...frames, frame].sort(
        (left, right) => left.mediaTime - right.mediaTime,
      );
    },
    destroy: vi.fn(),
    getBufferedFrames: vi.fn(() => frames),
    getState: vi.fn(() => ({
      bufferEndTime: 5,
      bufferStartTime: 0,
      detectionCount: frames.reduce(
        (total, frame) => total + frame.detections.length,
        0,
      ),
      errorMessage: null,
      frameCount: frames.length,
      requestedEndTime: 5,
      requestedStartTime: 0,
      status: DetectionBufferStatus.Ready,
    })),
    prepare: vi.fn(),
    prefetch: vi.fn(),
    selectFrame: vi.fn((mediaTime: number) =>
      [...frames].reverse().find((frame) => frame.mediaTime <= mediaTime),
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

function rgbaSource(maskFrame: PreparedMaskFrame | undefined) {
  return maskFrame?.kind === PreparedMaskFrameKind.RgbaImage
    ? maskFrame.source
    : undefined;
}

function gateFrameTime(frameIndex: number) {
  return frameIndex / GATE_FRAME_RATE;
}

function createGateRenderWindow(options: {
  readonly detectionTimeline?: BufferedDetectionTimeline;
  readonly maxCacheFrameCount?: number;
  readonly onDiagnostics: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly worker: Worker;
}) {
  return createPreparedRenderWindow({
    detectionTimeline:
      options.detectionTimeline ?? createFloorTimeline(gateFrames),
    maskStyle: new BaseMaskStyle(),
    renderPreparation: {
      maskFrame: {
        maxCacheFrameCount:
          options.maxCacheFrameCount ?? SESSION_MASK_CACHE_FRAME_COUNT,
        maxPendingFrameCount: 24,
        prefetchFrameCount: 175,
        scanIntervalSeconds: 0.1,
        scheduleBatchSize: 16,
        workerCount: 1,
      },
      mode: RenderPreparationMode.Worker,
      onDiagnostics: options.onDiagnostics,
      workerFactory: { createWorker: () => options.worker },
    },
  });
}
