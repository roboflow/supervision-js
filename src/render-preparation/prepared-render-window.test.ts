import { describe, expect, it, vi } from "vitest";

import { BaseMaskStyle } from "#styles/mask-style";
import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
} from "#types/detection-timeline";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";
import type { MaskStyle } from "#types/mask-style";
import {
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";

import { resetMocks } from "../../test/media-renderer-harness";
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

      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();

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
});

function createFakeMaskPreparationWorker() {
  const messages: unknown[] = [];
  const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  let terminated = false;
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
      setTimeout(() => {
        for (const listener of listeners) {
          listener({
            data: {
              imageData: new ImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2),
              key: message.job.key,
              requestId: message.requestId,
              type: MaskPreparationWorkerMessageType.Complete,
            },
          } as MessageEvent<unknown>);
        }
      }, 0);
    },

    terminate() {
      terminated = true;
    },
  } as unknown as Worker;

  return {
    get terminated() {
      return terminated;
    },
    messages,
    worker,
  };
}

function createArtifactStableMaskStyle(
  opacity: number,
): MaskStyle & { readonly artifactKey: string; readonly opacity: number } {
  return {
    artifactKey: "stable-mask-artifact",
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
