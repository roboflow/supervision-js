import { describe, expect, it } from "vitest";

import { DetectionFrameSelectionMode } from "#types/detection-timeline";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  decodeCompressedRleMask,
  filterDetectionFramesForRange,
  selectDetectionFrame,
} from "#utils/detection-frames";

describe("detection frame utilities", () => {
  it("selects interval frames until their exclusive end time", () => {
    const frames: DetectionFrame[] = [
      { detections: [], endTime: 2, mediaTime: 0 },
      { detections: [], endTime: 4, mediaTime: 3 },
    ];

    expect(selectDetectionFrame(frames, 1.99)?.mediaTime).toBe(0);
    expect(selectDetectionFrame(frames, 2)).toBeUndefined();
    expect(selectDetectionFrame(frames, 3)?.mediaTime).toBe(3);
  });

  it("selects frame-indexed detections on the nearest inference frame grid", () => {
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

    expect(selectDetectionFrame(frames, 1.73)?.frameIndex).toBe(51);
    expect(
      selectDetectionFrame(frames, 1.73, {
        frameRate: 30,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      })?.frameIndex,
    ).toBe(52);
  });

  it("selects exact 30fps grid frames with deterministic half-frame rounding", () => {
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
    expect(selectDetectionFrame(frames, 0.49 / 30, options)?.frameIndex).toBe(
      0,
    );
    expect(selectDetectionFrame(frames, 0.5 / 30, options)?.frameIndex).toBe(1);
    expect(selectDetectionFrame(frames, 1.49 / 30, options)?.frameIndex).toBe(
      1,
    );
    expect(selectDetectionFrame(frames, 1.5 / 30, options)?.frameIndex).toBe(2);
  });

  it("selects timestamp interval frames with exclusive end boundaries", () => {
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

    expect(selectDetectionFrame(frames, frameDuration - 1e-8)).toBe(frames[0]);
    expect(selectDetectionFrame(frames, frameDuration)).toBe(frames[1]);
    expect(selectDetectionFrame(frames, frameDuration * 2)).toBeUndefined();
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

    const selectedFrame = selectDetectionFrame(frames, 149 / 30, {
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    });

    expect(selectedFrame).toBe(frames[1]);
    expect(frames.map((frame) => frame.frameIndex)).toEqual([148, 150]);
    expect(frames[1]?.detections[0]?.className).toBe("nearest");
  });

  it("uses the nearest available frame index for a one-frame detection gap", () => {
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

    expect(
      selectDetectionFrame(frames, 149 / 30, {
        frameRate: 30,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      })?.frameIndex,
    ).toBe(150);
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

  it("uses an explicit frame-index origin when buffered media times are rounded", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 48 / 30,
        frameIndex: 47,
        mediaTime: 1.567,
      },
      {
        detections: [],
        endTime: 49 / 30,
        frameIndex: 48,
        mediaTime: 1.6,
      },
    ];

    expect(
      selectDetectionFrame(frames, (47.5 + 1e-8) / 30, {
        frameIndexOriginTime: 0,
        frameRate: 30,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      })?.frameIndex,
    ).toBe(48);
  });

  it("does not fall back to a stale interval frame when indexed frames are outside tolerance", () => {
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

function encodeCompressedRleCounts(counts: readonly number[]) {
  return counts
    .map((count, index) => {
      let value = index > 2 ? count - counts[index - 2]! : count;
      let encoded = "";
      let more = true;

      while (more) {
        let charCode = value & 0x1f;

        value >>= 5;
        more = !(
          (value === 0 && (charCode & 0x10) === 0) ||
          (value === -1 && (charCode & 0x10) !== 0)
        );

        if (more) {
          charCode |= 0x20;
        }

        encoded += String.fromCharCode(charCode + 48);
      }

      return encoded;
    })
    .join("");
}

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
