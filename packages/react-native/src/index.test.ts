import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  DetectionPickTarget,
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";
import {
  resolveReactNativeFrameLayout,
  pickReactNativeDetectionAtPoint,
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

describe("resolveReactNativeFrameLayout", () => {
  it("maps media-space rectangles into a contained React Native canvas", () => {
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 640,
      canvasWidth: 400,
      mediaHeight: 1080,
      mediaWidth: 1920,
    });

    expect(layout.mediaRect).toEqual({
      height: 225,
      width: 400,
      x: 0,
      y: 207.5,
    });
    expect(layout.mapRect({ height: 270, width: 480, x: 960, y: 540 })).toEqual(
      {
        height: 56.25,
        width: 100,
        x: 200,
        y: 320,
      },
    );
    expect(layout.mapPoint({ x: 1920, y: 1080 })).toEqual({
      x: 400,
      y: 432.5,
    });
  });

  it("maps React Native canvas points back into media space", () => {
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 640,
      canvasWidth: 400,
      mediaHeight: 1080,
      mediaWidth: 1920,
    });

    expect(layout.mapCanvasPoint({ x: 200, y: 320 })).toEqual({
      x: 960,
      y: 540,
    });
    expect(layout.mapCanvasPoint({ x: 0, y: 0 })).toBeNull();
  });
});

describe("pickReactNativeDetectionAtPoint", () => {
  it("picks detections by translating canvas-space touch points into media space", () => {
    const frame: DetectionFrame = {
      detections: [
        {
          className: "large",
          id: "large",
          rect: { height: 300, width: 300, x: 100, y: 100 },
        },
        {
          className: "small",
          id: "small",
          rect: { height: 60, width: 60, x: 180, y: 180 },
        },
      ],
      frameIndex: 1,
      mediaTime: 1 / 30,
    };
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 640,
      canvasWidth: 400,
      mediaHeight: 1080,
      mediaWidth: 1920,
    });
    const canvasPoint = layout.mapPoint({ x: 200, y: 200 });

    const pick = pickReactNativeDetectionAtPoint(frame, layout, canvasPoint);

    expect(pick).toMatchObject({
      detection: { id: "small" },
      detectionIndex: 1,
      target: DetectionPickTarget.Box,
    });
    expect(pick?.point.x).toBeCloseTo(200);
    expect(pick?.point.y).toBeCloseTo(200);
  });

  it("returns null for touches in the letterboxed area", () => {
    const frame: DetectionFrame = {
      detections: [
        {
          id: "visible",
          rect: { height: 100, width: 100, x: 0, y: 0 },
        },
      ],
      mediaTime: 0,
    };
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 640,
      canvasWidth: 400,
      mediaHeight: 1080,
      mediaWidth: 1920,
    });

    expect(
      pickReactNativeDetectionAtPoint(frame, layout, { x: 20, y: 20 }),
    ).toBeNull();
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
