import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";
import {
  resolveReactNativeFramePresentation,
  type ReactNativeFramePresentation,
} from "./index";
import { describe, expect, it } from "vitest";

describe("resolveReactNativeFramePresentation", () => {
  it("resolves core styles for an externally supplied native frame", () => {
    const detectionFrame: DetectionFrame = {
      detections: [
        {
          className: "horse",
          confidence: 0.92,
          mask: {
            counts: "eNpjYBgFo2AUjIJRMApGwSgYBQAAVAAU",
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 10,
            width: 10,
          },
          rect: { height: 80, width: 100, x: 12, y: 24 },
        },
      ],
      frameIndex: 7,
      mediaTime: 0.2333,
    };

    const presentation = resolveReactNativeFramePresentation({
      boxStyle: new BaseBoxStyle({
        shape: BoxShape.RoundedRect,
        stroke: { color: 0x22c55e, width: 3 },
      }),
      detectionFrame,
      labelStyle: new BaseLabelStyle({ includeConfidence: true }),
      maskStyle: new BaseMaskStyle({ alpha: 0.7, color: 0x38bdf8 }),
      mediaFrame: {
        metadata: {
          duration: 1 / 30,
          frameIndex: 7,
          height: 1080,
          mediaTime: 0.2333,
          width: 1920,
        },
        payload: { nativeTextureId: "texture-7" },
      },
    });

    expectPresentation(presentation);
    expect(presentation.boxes).toHaveLength(1);
    expect(presentation.boxes[0]).toMatchObject({
      rect: { height: 80, width: 100, x: 12, y: 24 },
      shape: BoxShape.RoundedRect,
      stroke: { color: 0x22c55e, width: 3 },
    });
    expect(presentation.labels[0]?.text).toBe("horse 92%");
    expect(presentation.masks[0]).toMatchObject({
      alpha: 1,
      color: 0x38bdf8,
    });
    expect(presentation.maskOpacity).toBe(0.7);
    expect(presentation.mediaFrame.payload).toEqual({
      nativeTextureId: "texture-7",
    });
  });
});

function expectPresentation(
  presentation: ReactNativeFramePresentation<{
    readonly nativeTextureId: string;
  }>,
) {
  expect(presentation.mediaMetadata).toMatchObject({
    frameIndex: 7,
    height: 1080,
    mediaTime: 0.2333,
    width: 1920,
  });
}
