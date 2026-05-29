import { describe, expect, it, vi } from "vitest";

import { BaseMaskStyle } from "#styles/mask-style";
import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
} from "#types/detection-timeline";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";

import { resetMocks } from "../../test/media-renderer-harness";
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
});

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
