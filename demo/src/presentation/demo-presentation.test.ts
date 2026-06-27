import { describe, expect, it } from "vitest";

import {
  BoxShape,
  BoxStrokeAlignment,
  DetectionMaskEncoding,
  type Detection,
  DetectionPickTarget,
  DetectionInteractionState,
  FocusTargetMode,
  LabelPlacement,
  MaskRenderMode,
} from "supervision-js";
import {
  createDemoPresentation,
  defaultDemoPresentationSettings,
} from "./demo-presentation";

const detection: Detection = {
  className: "horse",
  confidence: 0.9,
  mask: {
    counts: "04",
    encoding: DetectionMaskEncoding.CompressedRle,
    height: 2,
    width: 2,
  },
  rect: { height: 40, width: 20, x: 10, y: 12 },
};

describe("demo presentation", () => {
  it("uses the border radius slider as the only box shape control", () => {
    const rectPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
      boxCornerRadius: 0,
    });
    const roundedPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
      boxCornerRadius: 8,
    });

    expect(
      rectPresentation.boxStyle?.resolve(detection, {
        detectionIndex: 0,
        frame: { detections: [detection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      shape: BoxShape.Rect,
    });
    expect(
      roundedPresentation.boxStyle?.resolve(detection, {
        detectionIndex: 0,
        frame: { detections: [detection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      cornerRadius: 8,
      shape: BoxShape.RoundedRect,
    });
  });

  it("treats mask opacity as a cheap presentation knob", () => {
    const lowOpacityPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      maskOpacity: 0.2,
    });
    const highOpacityPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      maskOpacity: 0.8,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(lowOpacityPresentation.maskStyle?.artifactKey).toBe(
      highOpacityPresentation.maskStyle?.artifactKey,
    );
    expect(lowOpacityPresentation.maskStyle?.opacity).toBe(0.2);
    expect(highOpacityPresentation.maskStyle?.opacity).toBe(0.8);
    expect(
      lowOpacityPresentation.maskStyle?.resolve(detection, context),
    ).toMatchObject({
      alpha: 1,
    });
  });

  it("maps demo style controls to renderer-neutral draw instructions", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
      boxStrokeAlignment: BoxStrokeAlignment.Inside,
      labelCornerRadius: 9,
      labelOffsetX: 3,
      labelOffsetY: 5,
      labelPaddingX: 11,
      labelPaddingY: 6,
      labelPlacement: LabelPlacement.Bottom,
      maskMode: MaskRenderMode.StrokeOnly,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(presentation.boxStyle?.resolve(detection, context)).toMatchObject({
      stroke: {
        alignment: BoxStrokeAlignment.Inside,
      },
    });
    expect(presentation.labelStyle?.resolve(detection, context)).toMatchObject({
      background: {
        cornerRadius: 9,
        paddingX: 11,
        paddingY: 6,
      },
      offsetX: 3,
      offsetY: 5,
      placement: LabelPlacement.Bottom,
    });
    expect(presentation.maskStyle?.resolve(detection, context)).toMatchObject({
      alpha: 0,
      stroke: {
        width: defaultDemoPresentationSettings.maskStrokeWidth,
      },
    });
  });

  it("keeps default mask-only interaction picking free of box highlights", () => {
    const presentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const frame = { detections: [detection], mediaTime: 0 };
    const hoverPresentation = presentation.interactionStyle?.resolve(
      detection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Mask,
      },
    );

    expect(hoverPresentation?.boxStyle).toBeNull();
    expect(
      hoverPresentation?.maskStyle?.resolve(detection, {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      }),
    ).toMatchObject({
      alpha: defaultDemoPresentationSettings.interactionHoverFillAlpha,
      stroke: {
        width: defaultDemoPresentationSettings.interactionHoverStrokeWidth,
      },
    });
  });

  it("creates class-aware hover and selected interaction presentations", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
    });
    const frame = { detections: [detection], mediaTime: 0 };
    const hoverPresentation = presentation.interactionStyle?.resolve(
      detection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Mask,
      },
    );
    const selectedPresentation = presentation.interactionStyle?.resolve(
      detection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Selected,
        target: DetectionPickTarget.Mask,
      },
    );

    const hoverBox = hoverPresentation?.boxStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });
    const selectedBox = selectedPresentation?.boxStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });
    const hoverMask = hoverPresentation?.maskStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });
    const selectedMask = selectedPresentation?.maskStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });

    expect(hoverBox).toMatchObject({
      fill: {
        alpha: 0.12,
        color: 0x38bdf8,
      },
      stroke: {
        alignment: BoxStrokeAlignment.Outside,
        alpha: 0.88,
        color: 0x7dd3fc,
      },
    });
    expect(selectedBox).toMatchObject({
      fill: {
        alpha: 0.22,
        color: 0x38bdf8,
      },
      stroke: {
        alignment: BoxStrokeAlignment.Outside,
        alpha: 1,
        color: 0x7dd3fc,
      },
    });
    expect(hoverMask).toMatchObject({
      alpha: 0.12,
      color: 0x38bdf8,
      stroke: {
        color: 0x7dd3fc,
      },
    });
    expect(selectedMask).toMatchObject({
      alpha: 0.22,
      color: 0x38bdf8,
      stroke: {
        alpha: 1,
        color: 0x7dd3fc,
      },
    });
    expect(selectedBox?.stroke?.width).toBeGreaterThan(
      hoverBox?.stroke?.width ?? 0,
    );
    expect(selectedMask?.stroke?.width).toBeGreaterThan(
      hoverMask?.stroke?.width ?? 0,
    );
  });

  it("creates a selected-or-hovered focus style for dimming the surrounding frame", () => {
    const presentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const frame = { detections: [detection], mediaTime: 0 };
    const selectedPick = {
      detection,
      detectionIndex: 0,
      frame,
      mediaTime: 0,
      point: { x: 12, y: 14 },
      target: DetectionPickTarget.Mask,
    };

    expect(
      presentation.focusStyle?.resolve({
        frame,
        hoveredPick: null,
        mediaTime: 0,
        selectedPick,
      }),
    ).toMatchObject({
      fill: {
        alpha: defaultDemoPresentationSettings.focusDimAlpha,
        color: defaultDemoPresentationSettings.focusDimColor,
      },
      targetMode: FocusTargetMode.HoveredAndSelected,
      targets: [selectedPick],
    });
  });

  it("maps demo focus controls to target mode, tone, and fallback geometry", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      focusCornerRadius: 0,
      focusDimAlpha: 0.62,
      focusDimColor: 0x111827,
      focusTargetMode: FocusTargetMode.HoveredAndSelected,
    });
    const frame = { detections: [detection], mediaTime: 0 };
    const selectedPick = {
      detection,
      detectionIndex: 0,
      frame,
      mediaTime: 0,
      point: { x: 12, y: 14 },
      target: DetectionPickTarget.Box,
    };
    const hoveredPick = {
      detection,
      detectionIndex: 0,
      frame,
      mediaTime: 0,
      point: { x: 16, y: 18 },
      target: DetectionPickTarget.Mask,
    };

    expect(
      presentation.focusStyle?.resolve({
        frame,
        hoveredPick,
        mediaTime: 0,
        selectedPick,
      }),
    ).toMatchObject({
      fallback: {
        shape: BoxShape.Rect,
      },
      fill: {
        alpha: 0.62,
        color: 0x111827,
      },
      targetMode: FocusTargetMode.HoveredAndSelected,
      targets: [selectedPick, hoveredPick],
    });
  });
});
