import { describe, expect, it } from "vitest";

import { BaseBoxStyle } from "#styles/box-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { BoxShape } from "#types/box-style";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";

const frame: DetectionFrame = {
  detections: [],
  frameIndex: 7,
  mediaTime: 0.25,
};

describe("base presentation styles", () => {
  it("supports confidence filtering and per-class box presentation", () => {
    const style = new BaseBoxStyle({
      cornerRadius: (detection) => (detection.className === "person" ? 12 : 4),
      fill: (detection) =>
        detection.className === "person"
          ? { alpha: 0.2, color: 0x22c55e }
          : null,
      shape: BoxShape.RoundedRect,
      shouldRender: (detection) => (detection.confidence ?? 0) >= 0.5,
      stroke: (detection) => ({
        color: detection.className === "person" ? 0x22c55e : 0xa855f7,
        width: 3,
      }),
    });
    const person = {
      className: "person",
      confidence: 0.82,
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };
    const lowConfidence = {
      className: "person",
      confidence: 0.2,
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };

    expect(
      style.resolve(person, { detectionIndex: 0, frame, mediaTime: 0.25 }),
    ).toEqual({
      cornerRadius: 12,
      fill: { alpha: 0.2, color: 0x22c55e },
      rect: person.rect,
      shape: BoxShape.RoundedRect,
      stroke: { alpha: 1, color: 0x22c55e, width: 3 },
    });
    expect(
      style.resolve(lowConfidence, {
        detectionIndex: 1,
        frame,
        mediaTime: 0.25,
      }),
    ).toBeUndefined();
  });

  it("supports dynamic mask colors while preserving global opacity as a cheap knob", () => {
    const staticStyle = new BaseMaskStyle({
      alpha: 0.7,
      color: 0x00ff66,
      stroke: { alpha: 1, color: 0xffffff, width: 1 },
    });
    const dynamicStyle = new BaseMaskStyle({
      alpha: 0.4,
      color: (detection) =>
        detection.className === "person" ? 0x22c55e : 0xa855f7,
      shouldRender: (detection) => detection.className !== "ignore",
      stroke: (detection) =>
        detection.className === "person"
          ? { alpha: 1, color: 0xffffff, width: 1 }
          : undefined,
    });
    const mask = {
      counts: "04",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 2,
      width: 2,
    } as const;
    const person = {
      className: "person",
      mask,
    };

    expect(staticStyle.artifactKey).toBe("base:65382:16777215:1:1");
    expect(staticStyle.opacity).toBe(0.7);
    expect(dynamicStyle.artifactKey).toBeUndefined();
    expect(dynamicStyle.opacity).toBe(0.4);
    expect(
      dynamicStyle.resolve(person, {
        detectionIndex: 0,
        frame,
        mediaTime: 0.25,
      }),
    ).toEqual({
      alpha: 1,
      color: 0x22c55e,
      mask,
      stroke: { alpha: 1, color: 0xffffff, width: 1 },
    });
    expect(
      dynamicStyle.resolve(
        { className: "ignore", mask },
        { detectionIndex: 1, frame, mediaTime: 0.25 },
      ),
    ).toBeUndefined();
  });

  it("supports dynamic label text and presentation", () => {
    const style = new BaseLabelStyle({
      background: (detection) => ({
        color: detection.className === "person" ? 0x111827 : 0x312e81,
      }),
      includeConfidence: true,
      shouldRender: (detection) => Boolean(detection.rect),
      text: (detection, context) =>
        `${context.detectionIndex + 1}:${detection.className}`,
      textStyle: (detection) => ({
        color: detection.className === "person" ? 0xffffff : 0xfde68a,
        fontSize: 16,
      }),
    });
    const detection = {
      className: "person",
      confidence: 0.91,
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };

    expect(
      style.resolve(detection, { detectionIndex: 2, frame, mediaTime: 0.25 }),
    ).toEqual({
      background: {
        alpha: 0.72,
        color: 0x111827,
        cornerRadius: 4,
        paddingX: 6,
        paddingY: 3,
      },
      offsetY: 0,
      rect: detection.rect,
      text: "3:person",
      textStyle: {
        alpha: 1,
        color: 0xffffff,
        fontFamily: "Inter, sans-serif",
        fontSize: 16,
        fontWeight: "600",
      },
    });
  });

  it("keeps simple static box styles terse", () => {
    const style = new BaseBoxStyle({
      fill: { alpha: 0.1, color: 0x000000 },
      stroke: null,
    });
    const detection = {
      rect: { height: 10, width: 10, x: 1, y: 2 },
    };

    expect(
      style.resolve(detection, { detectionIndex: 0, frame, mediaTime: 0.25 }),
    ).toMatchObject({
      fill: { alpha: 0.1, color: 0x000000 },
      shape: BoxShape.Rect,
      stroke: undefined,
    });
  });
});
