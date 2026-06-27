import { describe, expect, it, vi } from "vitest";

import { createCompositeDetectionFrameSource } from "#detections/composite-detection-frame-source";
import { DetectionFrameSelectionMode } from "#types/detection-timeline";
import type { DetectionFrame, Rect } from "#types/detections";

const rect: Rect = { height: 10, width: 20, x: 1, y: 2 };

describe("createCompositeDetectionFrameSource", () => {
  it("merges aligned frame-indexed sources and tags copied detections", async () => {
    const source = createCompositeDetectionFrameSource({
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      sources: [
        {
          frames: [
            createFrame({
              detections: [{ className: "prediction", id: "p0", rect }],
              frameIndex: 0,
              mediaTime: 0,
            }),
          ],
          id: "predictions",
        },
        {
          frames: [
            createFrame({
              detections: [{ className: "draft", id: "d0", rect }],
              frameIndex: 0,
              mediaTime: 0,
            }),
          ],
          id: "draft",
          order: 10,
        },
      ],
    });

    const frames = await source.loadFrames(0, 1 / 30);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      frameIndex: 0,
      mediaTime: 0,
    });
    expect(frames[0]?.detections).toEqual([
      expect.objectContaining({
        className: "prediction",
        sourceDetectionIndex: 0,
        sourceId: "predictions",
      }),
      expect.objectContaining({
        className: "draft",
        sourceDetectionIndex: 0,
        sourceId: "draft",
      }),
    ]);
  });

  it("splits interval output where child source intervals overlap", async () => {
    const source = createCompositeDetectionFrameSource({
      sources: [
        {
          frames: [
            createFrame({
              className: "base",
              endTime: 3,
              mediaTime: 1,
            }),
          ],
          id: "base",
        },
        {
          frames: [
            createFrame({
              className: "review",
              endTime: 2.5,
              mediaTime: 2,
            }),
          ],
          id: "review",
        },
      ],
    });

    const frames = await source.loadFrames(1, 3);

    expect(frames).toEqual([
      expect.objectContaining({
        detections: [
          expect.objectContaining({ className: "base", sourceId: "base" }),
        ],
        endTime: 2,
        mediaTime: 1,
      }),
      expect.objectContaining({
        detections: [
          expect.objectContaining({ className: "base", sourceId: "base" }),
          expect.objectContaining({ className: "review", sourceId: "review" }),
        ],
        endTime: 2.5,
        mediaTime: 2,
      }),
      expect.objectContaining({
        detections: [
          expect.objectContaining({ className: "base", sourceId: "base" }),
        ],
        endTime: 3,
        mediaTime: 2.5,
      }),
    ]);
  });

  it("orders detections by source order and declaration order", async () => {
    const source = createCompositeDetectionFrameSource({
      sources: [
        {
          frames: [createFrame({ className: "top", mediaTime: 0 })],
          id: "top",
          order: 10,
        },
        {
          frames: [createFrame({ className: "bottom", mediaTime: 0 })],
          id: "bottom",
          order: -1,
        },
        {
          frames: [createFrame({ className: "middle", mediaTime: 0 })],
          id: "middle",
        },
      ],
    });

    const [frame] = await source.loadFrames(0, 0.5);

    expect(frame?.detections.map((detection) => detection.className)).toEqual([
      "bottom",
      "middle",
      "top",
    ]);
  });

  it("waits only for sources required for playback", async () => {
    const requiredWaitForRange = vi.fn(async () => undefined);
    const optionalWaitForRange = vi.fn(async () => undefined);
    const source = createCompositeDetectionFrameSource({
      sources: [
        {
          id: "required",
          source: {
            loadFrames: vi.fn(async () => []),
            waitForRange: requiredWaitForRange,
          },
        },
        {
          id: "optional",
          requiredForPlayback: false,
          source: {
            loadFrames: vi.fn(async () => []),
            waitForRange: optionalWaitForRange,
          },
        },
      ],
    });

    await source.waitForRange?.({ endTime: 2, startTime: 1 });

    expect(requiredWaitForRange).toHaveBeenCalledWith({
      endTime: 2,
      startTime: 1,
    });
    expect(optionalWaitForRange).not.toHaveBeenCalled();
  });

  it("rejects invalid source declarations", () => {
    expect(() =>
      createCompositeDetectionFrameSource({
        sources: [
          { frames: [], id: "duplicate" },
          { frames: [], id: "duplicate" },
        ],
      }),
    ).toThrow("Duplicate detection source id: duplicate.");

    expect(() =>
      createCompositeDetectionFrameSource({
        sources: [{ id: "missing" }],
      }),
    ).toThrow(
      "Detection source missing must provide exactly one input: frames or source.",
    );

    expect(() =>
      createCompositeDetectionFrameSource({
        sources: [{ frames: [], id: "ambiguous", source: createEmptySource() }],
      }),
    ).toThrow(
      "Detection source ambiguous must provide exactly one input: frames or source.",
    );
  });
});

function createEmptySource() {
  return {
    async loadFrames() {
      return [];
    },
  };
}

function createFrame(
  options:
    | {
        readonly className: string;
        readonly endTime?: number;
        readonly frameIndex?: number;
        readonly mediaTime: number;
      }
    | DetectionFrame,
): DetectionFrame {
  if ("detections" in options) {
    return options;
  }

  return {
    detections: [{ className: options.className, rect }],
    endTime: options.endTime,
    frameIndex: options.frameIndex,
    mediaTime: options.mediaTime,
  };
}
