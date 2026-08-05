import { describe, expect, it } from "vitest";

import { BaseBoxStyle } from "#styles/box-style";
import { BaseFocusStyle } from "#styles/focus-style";
import { BaseInteractionStyle } from "#styles/interaction-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { BoxShape, BoxStrokeAlignment } from "#types/box-style";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";
import { DetectionPickTarget } from "#types/interaction";
import { FocusTargetMode } from "#types/focus-style";
import { DetectionInteractionState } from "#types/interaction-style";
import { LabelPlacement } from "#types/label-style";
import { MaskRenderMode } from "#types/mask-style";

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
        alignment: BoxStrokeAlignment.Inside,
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
      stroke: {
        alignment: BoxStrokeAlignment.Inside,
        alpha: 1,
        color: 0x22c55e,
        width: 3,
      },
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
      color: 0x00ff66,
      opacity: 0.7,
      stroke: { color: 0xffffff, width: 1 },
    });
    const dynamicStyle = new BaseMaskStyle({
      color: (detection) =>
        detection.className === "person" ? 0x22c55e : 0xa855f7,
      mode: (detection) =>
        detection.className === "person"
          ? MaskRenderMode.StrokeOnly
          : MaskRenderMode.FillOnly,
      opacity: 0.4,
      shouldRender: (detection) => detection.className !== "ignore",
      stroke: (detection) =>
        detection.className === "person" ? { width: 1 } : undefined,
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

    expect(staticStyle.artifactKey).toBe(
      "base:65382:1:fillAndStroke:16777215:1:1",
    );
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
      alpha: 0,
      color: 0x22c55e,
      mask,
      stroke: { alpha: 1, color: 0x22c55e, width: 1 },
    });
    expect(
      dynamicStyle.resolve(
        { className: "ball", mask },
        { detectionIndex: 1, frame, mediaTime: 0.25 },
      ),
    ).toEqual({
      alpha: 1,
      color: 0xa855f7,
      mask,
      stroke: undefined,
    });
    expect(
      dynamicStyle.resolve(
        { className: "ignore", mask },
        { detectionIndex: 1, frame, mediaTime: 0.25 },
      ),
    ).toBeUndefined();
  });

  it("keeps mask alpha as a compatibility alias for opacity", () => {
    const style = new BaseMaskStyle({ alpha: 0.25 });

    expect(style.opacity).toBe(0.25);
  });

  it("keeps mask fill alpha independent from its outline", () => {
    const style = new BaseMaskStyle({
      color: 0x22c55e,
      fillAlpha: 0.45,
      opacity: 1,
      stroke: { alpha: 1, width: 2 },
    });
    const mask = {
      counts: "04",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 2,
      width: 2,
    } as const;

    expect(
      style.resolve({ mask }, { detectionIndex: 0, frame, mediaTime: 0.25 }),
    ).toEqual({
      alpha: 0.45,
      color: 0x22c55e,
      mask,
      stroke: { alpha: 1, color: 0x22c55e, width: 2 },
    });
  });

  it("defaults stroke-only masks to a visible same-color outline", () => {
    const style = new BaseMaskStyle({
      color: 0x38bdf8,
      mode: MaskRenderMode.StrokeOnly,
    });
    const mask = {
      counts: "04",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 2,
      width: 2,
    } as const;

    expect(style.artifactKey).toBe("base:3718648:1:strokeOnly:3718648:1:1");
    expect(
      style.resolve({ mask }, { detectionIndex: 0, frame, mediaTime: 0.25 }),
    ).toEqual({
      alpha: 0,
      color: 0x38bdf8,
      mask,
      stroke: { alpha: 1, color: 0x38bdf8, width: 1 },
    });
  });

  it("supports dynamic label text and presentation", () => {
    const style = new BaseLabelStyle({
      background: (detection) => ({
        color: detection.className === "person" ? 0x111827 : 0x312e81,
      }),
      includeConfidence: true,
      offset: (detection) => ({
        x: detection.className === "person" ? 2 : 0,
        y: 6,
      }),
      placement: LabelPlacement.InsideTop,
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
      offsetX: 2,
      offsetY: 6,
      placement: LabelPlacement.InsideTop,
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

  it("keeps label offsetY as a compatibility shorthand", () => {
    const style = new BaseLabelStyle({ offsetY: 4 });
    const detection = {
      className: "person",
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };

    expect(
      style.resolve(detection, { detectionIndex: 0, frame, mediaTime: 0.25 }),
    ).toMatchObject({
      offsetY: 4,
      text: "person",
    });
  });

  it("preserves top-only label corner configuration", () => {
    const style = new BaseLabelStyle({
      background: { color: 0x312e81, topCornersOnly: true },
    });
    const detection = {
      className: "person",
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };

    expect(
      style.resolve(detection, { detectionIndex: 0, frame, mediaTime: 0.25 })
        ?.background,
    ).toMatchObject({ topCornersOnly: true });
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

  it("resolves hover and selected interaction highlights without touching base layers", () => {
    const style = new BaseInteractionStyle({
      fill: (_detection, context) =>
        context.state === DetectionInteractionState.Selected
          ? { alpha: 0.2, color: 0xfde047 }
          : null,
      stroke: (detection, context) => ({
        alpha: context.state === DetectionInteractionState.Selected ? 1 : 0.85,
        color: detection.className === "person" ? 0x22c55e : 0x38bdf8,
        width: context.state === DetectionInteractionState.Selected ? 5 : 3,
      }),
    });
    const detection = {
      className: "person",
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };

    const hoverPresentation = style.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0.25,
      point: { x: 12, y: 14 },
      state: DetectionInteractionState.Hovered,
      target: DetectionPickTarget.Box,
    });
    const selectedPresentation = style.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0.25,
      point: { x: 12, y: 14 },
      state: DetectionInteractionState.Selected,
      target: DetectionPickTarget.Box,
    });

    expect(
      hoverPresentation?.boxStyle?.resolve(detection, {
        detectionIndex: 0,
        frame,
        mediaTime: 0.25,
      }),
    ).toEqual({
      fill: undefined,
      rect: detection.rect,
      shape: BoxShape.Rect,
      stroke: {
        alpha: 0.85,
        color: 0x22c55e,
        width: 3,
      },
    });
    expect(
      selectedPresentation?.boxStyle?.resolve(detection, {
        detectionIndex: 0,
        frame,
        mediaTime: 0.25,
      }),
    ).toMatchObject({
      fill: { alpha: 0.2, color: 0xfde047 },
      stroke: {
        alpha: 1,
        color: 0x22c55e,
        width: 5,
      },
    });
  });

  it("resolves selected detections into focus targets", () => {
    const detection = {
      className: "person",
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };
    const focusFrame = {
      detections: [detection],
      mediaTime: 0.25,
    };
    const selectedPick = {
      detection,
      detectionIndex: 0,
      frame: focusFrame,
      mediaTime: 0.25,
      point: { x: 12, y: 14 },
      target: DetectionPickTarget.Mask,
    };
    const style = new BaseFocusStyle({
      cornerRadius: 10,
      fill: { alpha: 0.42, color: 0x020617 },
      shape: BoxShape.RoundedRect,
      targetMode: FocusTargetMode.Selected,
    });

    expect(
      style.resolve({
        frame: focusFrame,
        hoveredPick: null,
        mediaTime: 0.25,
        selectedPick,
      }),
    ).toEqual({
      fallback: {
        cornerRadius: 10,
        shape: BoxShape.RoundedRect,
      },
      fill: {
        alpha: 0.42,
        color: 0x020617,
      },
      targetMode: FocusTargetMode.Selected,
      targets: [selectedPick],
    });
    expect(
      style.resolve({
        frame: focusFrame,
        hoveredPick: null,
        mediaTime: 0.25,
        selectedPick: null,
      }),
    ).toBeUndefined();
  });
});
