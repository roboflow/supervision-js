import { describe, expect, it, vi } from "vitest";

import { createCompositeDetectionFrameSource } from "#detections/composite-detection-frame-source";
import { DetectionFrameSelectionMode } from "#types/detection-timeline";
import { DetectionMaskEncoding } from "#types/detections";
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

  it("waits only for sources required for coverage", async () => {
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
          requiredForCoverage: false,
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

  it("projects each child from its own coordinate space before composing", async () => {
    const mask = {
      counts: "abc",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 90,
      width: 160,
    } as const;
    const source = createCompositeDetectionFrameSource({
      sources: [
        {
          frames: [
            {
              coordinateSpace: { height: 360, width: 640 },
              detections: [
                {
                  id: "half",
                  mask,
                  polyline: {
                    points: [
                      { x: 32, y: 18 },
                      { x: 64, y: 36 },
                    ],
                  },
                  rect: { height: 36, width: 64, x: 320, y: 180 },
                },
              ],
              endTime: 1,
              mediaTime: 0,
            },
          ],
          id: "half-space",
        },
        {
          frames: [
            {
              coordinateSpace: { height: 180, width: 320 },
              detections: [
                {
                  id: "quarter",
                  keypoints: { edges: [], points: [{ x: 10, y: 20 }] },
                },
              ],
              endTime: 1,
              mediaTime: 0,
            },
          ],
          id: "quarter-space",
        },
        {
          frames: [
            {
              detections: [
                {
                  id: "media",
                  rect: { height: 36, width: 64, x: 320, y: 180 },
                },
              ],
              endTime: 1,
              mediaTime: 0,
            },
          ],
          id: "media-space",
        },
      ],
    });

    const [frame] = await source.loadFrames(0, 1, {
      coordinateSpace: { height: 720, width: 1280 },
    });

    expect(frame).toMatchObject({
      coordinateSpace: { height: 720, width: 1280 },
      detections: [
        {
          id: "half",
          // Masks carry their own dimensions and must not be scaled again.
          mask,
          polyline: {
            points: [
              { x: 64, y: 36 },
              { x: 128, y: 72 },
            ],
          },
          rect: { height: 72, width: 128, x: 640, y: 360 },
        },
        // A different child space scales by its own ratio, not the first one's.
        { id: "quarter", keypoints: { points: [{ x: 40, y: 80 }] } },
        // A child without coordinate metadata is already in media space.
        { id: "media", rect: { height: 36, width: 64, x: 320, y: 180 } },
      ],
    });
  });

  it("leaves composed children unchanged without a projection target", async () => {
    const source = createCompositeDetectionFrameSource({
      sources: [
        {
          frames: [
            {
              coordinateSpace: { height: 360, width: 640 },
              detections: [
                { id: "half", rect: { height: 36, width: 64, x: 320, y: 180 } },
              ],
              endTime: 1,
              mediaTime: 0,
            },
          ],
          id: "half-space",
        },
      ],
    });

    const [frame] = await source.loadFrames(0, 1);

    expect(frame).toMatchObject({
      detections: [{ rect: { height: 36, width: 64, x: 320, y: 180 } }],
    });
    expect(frame?.coordinateSpace).toBeUndefined();
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
