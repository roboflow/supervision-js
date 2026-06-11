import { describe, expect, it } from "vitest";

import { BoxShape, BoxStrokeAlignment } from "../../../src/types/box-style";
import {
  DetectionMaskEncoding,
  type Detection,
} from "../../../src/types/detections";
import { LabelPlacement } from "../../../src/types/label-style";
import { MaskRenderMode } from "../../../src/types/mask-style";
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
      boxCornerRadius: 0,
    });
    const roundedPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
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
});
