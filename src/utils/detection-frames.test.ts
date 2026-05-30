import { describe, expect, it } from "vitest";

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

  it("uses media-time intervals instead of frame-index proximity", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 2,
        frameIndex: 100,
        mediaTime: 1,
      },
      {
        detections: [],
        endTime: 3,
        frameIndex: 1,
        mediaTime: 2,
      },
    ];

    expect(selectDetectionFrame(frames, 1.5)?.frameIndex).toBe(100);
    expect(selectDetectionFrame(frames, 2.5)?.frameIndex).toBe(1);
  });

  it("selects drifted interval detections from the media timestamp reference", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 11.9983,
        frameIndex: 359,
        mediaTime: 11.965,
      },
      {
        detections: [],
        endTime: 12.0316,
        frameIndex: 360,
        mediaTime: 11.9983,
      },
    ];

    expect(selectDetectionFrame(frames, 12)?.frameIndex).toBe(360);
  });

  it("does not fall back to a stale frame after its interval ends", () => {
    const frames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      },
    ];

    expect(selectDetectionFrame(frames, 1)).toBeUndefined();
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
