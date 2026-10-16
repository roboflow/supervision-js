import { describe, expect, it } from "vitest";
import { encodeBinaryMask, type DetectionFrame } from "supervision-js-core";
import { createPackedMaskCoverage } from "#render-preparation/packed-mask-coverage";
import { pickPackedMaskAtPoint } from "./packed-mask-picker";

describe("packed mask picking", () => {
  it("picks original identities through holes and eligibility filters across mask resolutions", () => {
    const lower = encodeBinaryMask(new Uint8Array(16).fill(1), 4, 4);
    const upper = encodeBinaryMask(Uint8Array.from([1, 0, 1, 1]), 2, 2);
    const frame: DetectionFrame = {
      mediaTime: 3,
      detections: [
        ...Array.from({ length: 300 }, (_, index) => ({ id: `box-${index}` })),
        { id: "lower", mask: lower, zIndex: 5 },
        { id: "upper", mask: upper, zIndex: 10, locked: true },
      ],
    };
    const entries = [
      createPackedMaskCoverage(lower, 300)!,
      createPackedMaskCoverage(upper, 301)!,
    ];
    const dimensions = { width: 100, height: 100 };
    const pick = (x: number, y: number, options = {}) =>
      pickPackedMaskAtPoint(frame, entries, { x, y }, dimensions, options);
    expect(pick(25, 25)).toMatchObject({
      detection: { id: "upper" },
      detectionIndex: 301,
      mediaTime: 3,
    });
    expect(pick(75, 25)?.detection.id).toBe("lower");
    expect(pick(25, 25, { includeLocked: false })?.detection.id).toBe("lower");
    expect(
      pick(25, 25, {
        filter: (_detection: unknown, index: number) => index !== 301,
      })?.detection.id,
    ).toBe("lower");
    expect(pick(-1, 25)).toBeNull();
    expect(pick(100, 100)).toBeNull();
    const tied = {
      ...frame,
      detections: frame.detections.map((detection) => ({
        ...detection,
        zIndex: 5,
      })),
    };
    expect(
      pickPackedMaskAtPoint(
        tied,
        [...entries].reverse(),
        { x: 25, y: 25 },
        dimensions,
      )?.detection.id,
    ).toBe("upper");
  });
});
