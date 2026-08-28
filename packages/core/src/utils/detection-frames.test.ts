import { describe, expect, it } from "vitest";

import { DetectionFrameSelectionMode } from "#types/detection-timeline";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  decodeCompressedRleMask,
  encodeCompressedRleCounts,
  filterDetectionFramesForRange,
  selectDetectionFrame,
} from "#utils/detection-frames";

describe("detection frame utilities", () => {
  it("carries metadata a plain copy would flatten", () => {
    const recordedAt = new Date("2026-08-26T12:00:00.000Z");
    const source = [
      {
        detections: [
          {
            className: "player",
            confidence: 1,
            id: "a",
            metadata: { nested: { recordedAt }, tags: ["one", "two"] },
            rect: { height: 2, width: 2, x: 1, y: 1 },
          },
        ],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      },
    ];

    const copied = copySortedDetectionFrames(source);
    const carried = copied[0]?.detections[0]?.metadata as {
      nested: { recordedAt: Date };
      tags: readonly string[];
    };

    expect(carried.tags).toEqual(["one", "two"]);
    expect(carried.nested.recordedAt).toBeInstanceOf(Date);
    expect(carried.nested.recordedAt.toISOString()).toBe(
      "2026-08-26T12:00:00.000Z",
    );
    expect(carried.nested).not.toBe(source[0]?.detections[0]?.metadata);
  });

  it("selects interval frames until their exclusive end time", () => {
    const frames: DetectionFrame[] = [
      { detections: [], endTime: 2, mediaTime: 0 },
      { detections: [], endTime: 4, mediaTime: 3 },
    ];

    expect(selectDetectionFrame(frames, 1.99)?.mediaTime).toBe(0);
    expect(selectDetectionFrame(frames, 2)).toBeUndefined();
    expect(selectDetectionFrame(frames, 3)?.mediaTime).toBe(3);
  });

  it("does not select a grid frame the playhead has not reached", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 52 / 30,
        frameIndex: 51,
        mediaTime: 51 / 30,
      },
      {
        detections: [],
        endTime: 53 / 30,
        frameIndex: 52,
        mediaTime: 52 / 30,
      },
    ];
    const options = {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    };

    expect(selectDetectionFrame(frames, 1.73)?.frameIndex).toBe(51);
    expect(selectDetectionFrame(frames, 1.73, options)?.frameIndex).toBe(51);
    expect(selectDetectionFrame(frames, 52 / 30, options)?.frameIndex).toBe(52);
  });

  it("selects the 30fps grid frame whose own step contains the playhead", () => {
    const frames: DetectionFrame[] = Array.from({ length: 4 }, (_, index) => ({
      detections: [],
      endTime: (index + 1) / 30,
      frameIndex: index,
      mediaTime: index / 30,
    }));
    const options = {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    };

    expect(selectDetectionFrame(frames, 0, options)?.frameIndex).toBe(0);
    expect(selectDetectionFrame(frames, 0.5 / 30, options)?.frameIndex).toBe(0);
    expect(selectDetectionFrame(frames, 0.9 / 30, options)?.frameIndex).toBe(0);
    expect(selectDetectionFrame(frames, 1 / 30, options)?.frameIndex).toBe(1);
    expect(selectDetectionFrame(frames, 1.5 / 30, options)?.frameIndex).toBe(1);
    expect(selectDetectionFrame(frames, 3.5 / 30, options)?.frameIndex).toBe(3);
    expect(selectDetectionFrame(frames, 4 / 30, options)).toBeUndefined();
  });

  it("selects on the grid the frames describe when the stated rate disagrees", () => {
    const realFrameStep = 1 / 29.97;
    const frames: DetectionFrame[] = Array.from(
      { length: 1500 },
      (_, index) => ({
        detections: [],
        frameIndex: index,
        mediaTime: index * realFrameStep,
      }),
    );
    const options = {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    };

    for (const frameIndex of [0, 1, 800, 1499]) {
      expect(
        selectDetectionFrame(frames, frameIndex * realFrameStep, options)
          ?.frameIndex,
      ).toBe(frameIndex);
    }
  });

  it("ends a timestamp interval frame half a millisecond before its end time", () => {
    const frameDuration = 1 / 30;
    const frames: DetectionFrame[] = [
      {
        detections: [{ className: "zero" }],
        endTime: frameDuration,
        mediaTime: 0,
      },
      {
        detections: [{ className: "one" }],
        endTime: frameDuration * 2,
        mediaTime: frameDuration,
      },
    ];

    expect(selectDetectionFrame(frames, frameDuration - 0.001)).toBe(frames[0]);
    expect(selectDetectionFrame(frames, frameDuration)).toBe(frames[1]);
    expect(selectDetectionFrame(frames, frameDuration * 2)).toBeUndefined();
    // The boundary a playhead on the producer's millisecond plane needs: a
    // frame within its rounding error is already the one on screen. Widening
    // the tolerance beyond that would hand the next frame out early.
    expect(selectDetectionFrame(frames, frameDuration - 0.0004)).toBe(
      frames[1],
    );
    expect(selectDetectionFrame(frames, frameDuration - 0.0006)).toBe(
      frames[0],
    );
  });

  it("selects the frame a whole-millisecond playhead rounds down into", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 151 / 30,
        frameIndex: 150,
        mediaTime: 5,
      },
      {
        detections: [],
        endTime: 152 / 30,
        frameIndex: 151,
        mediaTime: 151 / 30,
      },
    ];

    // 5.033 is where a whole-millisecond playhead lands on frame 151 of a
    // 30fps source, whose exact start is 151/30.
    expect(selectDetectionFrame(frames, 5.033)?.frameIndex).toBe(151);
  });

  it("waits for a frame further than the playhead's rounding error away", () => {
    const atTheLimit: DetectionFrame[] = [
      { detections: [], endTime: 5.0335, frameIndex: 150, mediaTime: 5 },
      { detections: [], endTime: 5.07, frameIndex: 151, mediaTime: 5.0335 },
    ];
    const pastTheLimit: DetectionFrame[] = [
      { detections: [], endTime: 5.034, frameIndex: 150, mediaTime: 5 },
      { detections: [], endTime: 5.07, frameIndex: 151, mediaTime: 5.034 },
    ];

    expect(selectDetectionFrame(atTheLimit, 5.033)?.frameIndex).toBe(151);
    expect(selectDetectionFrame(pastTheLimit, 5.033)?.frameIndex).toBe(150);
  });

  it("selects interval frames without mutating caller-owned frame data", () => {
    const frames = deepFreezeDetectionFrames([
      {
        detections: [
          {
            className: "player",
            metadata: { source: "fixture" },
            rect: { height: 20, width: 10, x: 5, y: 6 },
          },
        ],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      },
      {
        detections: [],
        endTime: 2,
        frameIndex: 1,
        mediaTime: 1,
      },
    ]);

    const selectedFrame = selectDetectionFrame(frames, 0.5);

    expect(selectedFrame).toBe(frames[0]);
    expect(frames).toEqual([
      {
        detections: [
          {
            className: "player",
            metadata: { source: "fixture" },
            rect: { height: 20, width: 10, x: 5, y: 6 },
          },
        ],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      },
      {
        detections: [],
        endTime: 2,
        frameIndex: 1,
        mediaTime: 1,
      },
    ]);
  });

  it("selects nearest frame-index detections without mutating caller-owned frame data", () => {
    const frames = deepFreezeDetectionFrames([
      {
        detections: [{ className: "previous" }],
        endTime: 149 / 30,
        frameIndex: 148,
        mediaTime: 148 / 30,
      },
      {
        detections: [{ className: "nearest" }],
        endTime: 151 / 30,
        frameIndex: 150,
        mediaTime: 150 / 30,
      },
    ]);

    const selectedFrame = selectDetectionFrame(frames, 150 / 30, {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    });

    expect(selectedFrame).toBe(frames[1]);
    expect(frames.map((frame) => frame.frameIndex)).toEqual([148, 150]);
    expect(frames[1]?.detections[0]?.className).toBe("nearest");
  });

  it("leaves a frame index the source never produced without detections", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 149 / 30,
        frameIndex: 148,
        mediaTime: 148 / 30,
      },
      {
        detections: [],
        endTime: 151 / 30,
        frameIndex: 150,
        mediaTime: 150 / 30,
      },
    ];
    const options = {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    };

    expect(selectDetectionFrame(frames, 148 / 30, options)?.frameIndex).toBe(
      148,
    );
    expect(selectDetectionFrame(frames, 149 / 30, options)).toBeUndefined();
    expect(selectDetectionFrame(frames, 150 / 30, options)?.frameIndex).toBe(
      150,
    );
  });

  it("does not bridge gaps larger than one missing frame index", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 11 / 30,
        frameIndex: 10,
        mediaTime: 10 / 30,
      },
      {
        detections: [],
        endTime: 15 / 30,
        frameIndex: 14,
        mediaTime: 14 / 30,
      },
    ];

    expect(
      selectDetectionFrame(frames, 12 / 30, {
        frameRate: 30,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      }),
    ).toBeUndefined();
  });

  it("selects across buffered media times the producer rounded to milliseconds", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        frameIndex: 47,
        mediaTime: 1.567,
      },
      {
        detections: [],
        frameIndex: 48,
        mediaTime: 1.6,
      },
    ];
    const options = {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    };

    expect(selectDetectionFrame(frames, 47.5 / 30, options)?.frameIndex).toBe(
      47,
    );
    expect(selectDetectionFrame(frames, 1.6, options)?.frameIndex).toBe(48);
  });

  it("does not fall back to a stale interval frame past the indexed frame's grid step", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 30,
        frameIndex: 0,
        mediaTime: 0,
      },
    ];

    expect(
      selectDetectionFrame(frames, 10 / 30, {
        frameRate: 30,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      }),
    ).toBeUndefined();
  });

  it("filters frames that overlap a load range", () => {
    const frames: DetectionFrame[] = [
      { detections: [], endTime: 1.5, mediaTime: 0 },
      { detections: [], endTime: 3, mediaTime: 1.5 },
      { detections: [], mediaTime: 4 },
    ];

    expect(filterDetectionFramesForRange(frames, 1.25, 1.75)).toEqual([
      frames[0],
      frames[1],
    ]);
    expect(filterDetectionFramesForRange(frames, 3, 3.5)).toEqual([]);
  });

  it("copies frame intervals and mask payloads without leaking mutable objects", () => {
    const source: DetectionFrame[] = [
      {
        detections: [
          {
            mask: {
              counts: "021",
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 2,
              width: 2,
            },
            metadata: { label: "player" },
            rect: { height: 2, width: 2, x: 1, y: 1 },
          },
        ],
        endTime: 1,
        frameIndex: 7,
        mediaTime: 0,
      },
    ];

    const copied = copySortedDetectionFrames(source);

    expect(copied).toEqual(source);
    expect(copied[0]).not.toBe(source[0]);
    expect(copied[0]?.detections[0]?.mask).not.toBe(
      source[0]?.detections[0]?.mask,
    );
    expect(copied[0]?.detections[0]?.metadata).not.toBe(
      source[0]?.detections[0]?.metadata,
    );
    expect(copied[0]?.detections[0]?.rect).not.toBe(
      source[0]?.detections[0]?.rect,
    );
  });

  it("copies keypoint box-relative flags without leaking mutable arrays", () => {
    const source: DetectionFrame[] = [
      {
        detections: [
          {
            keypoints: {
              boxRelative: [true, false],
              edges: [[0, 1]],
              points: [
                { x: 1, y: 1 },
                { x: 3, y: 3 },
              ],
            },
            rect: { height: 4, width: 4, x: 2, y: 2 },
          },
        ],
        mediaTime: 0,
      },
    ];

    const copied = copySortedDetectionFrames(source);

    expect(copied[0]?.detections[0]?.keypoints?.boxRelative).toEqual([
      true,
      false,
    ]);
    expect(copied[0]?.detections[0]?.keypoints?.boxRelative).not.toBe(
      source[0]?.detections[0]?.keypoints?.boxRelative,
    );
  });

  it("rejects invalid detection frame timing", () => {
    expect(() =>
      copySortedDetectionFrames([
        {
          detections: [],
          endTime: 1,
          mediaTime: 1,
        },
      ]),
    ).toThrow("frames[0].endTime must be greater than 1.");

    expect(() =>
      copySortedDetectionFrames([
        {
          detections: [],
          frameIndex: 1.25,
          mediaTime: 0,
        },
      ]),
    ).toThrow("frames[0].frameIndex must be an integer.");
  });

  it("rejects invalid detection confidence, rectangles, and masks", () => {
    expect(() =>
      copySortedDetectionFrames([
        {
          detections: [{ confidence: 1.2 }],
          mediaTime: 0,
        },
      ]),
    ).toThrow("frames[0].detections[0].confidence must be less than or equal");

    expect(() =>
      copySortedDetectionFrames([
        {
          detections: [
            {
              rect: { height: 5, width: 0, x: 0, y: 0 },
            },
          ],
          mediaTime: 0,
        },
      ]),
    ).toThrow("frames[0].detections[0].rect.width must be greater than 0.");

    expect(() =>
      copySortedDetectionFrames([
        {
          detections: [
            {
              mask: {
                counts: "",
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 10,
                width: 10,
              },
            },
          ],
          mediaTime: 0,
        },
      ]),
    ).toThrow("frames[0].detections[0].mask.counts must not be empty.");
  });

  it("decodes compressed RLE masks to row-major binary data", () => {
    const decoded = decodeCompressedRleMask({
      counts: encodeCompressedRleCounts([1, 2, 3]),
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 2,
      width: 3,
    });

    expect(decoded).toEqual({
      data: new Uint8Array([0, 1, 0, 1, 0, 0]),
      height: 2,
      width: 3,
    });
  });
});

function deepFreezeDetectionFrames(frames: readonly DetectionFrame[]) {
  for (const frame of frames) {
    for (const detection of frame.detections) {
      if (detection.rect) {
        Object.freeze(detection.rect);
      }

      if (detection.mask) {
        Object.freeze(detection.mask);
      }

      if (detection.metadata) {
        Object.freeze(detection.metadata);
      }

      Object.freeze(detection);
    }

    Object.freeze(frame.detections);
    Object.freeze(frame);
  }

  return Object.freeze(frames);
}
