import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  DetectionMaskEncoding,
  DetectionPickTarget,
  LabelPlacement,
  MaskRenderMode,
  type DetectionFrame,
} from "supervision-js-core";
import {
  createReactNativeLiveIdMaskArtifact,
  createReactNativeIdMaskFrame,
  DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING,
  pickReactNativeDetectionAtPoint,
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
  resolveReactNativeLiveColorForClass,
  resolveReactNativeLiveIdMaskArtifactSize,
  resolveReactNativeIdMaskUniforms,
  resolveReactNativeFrameLayout,
  resolveReactNativeLabelLayout,
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

describe("resolveReactNativeLabelLayout", () => {
  it("positions a top label in canvas space while anchoring to media geometry", () => {
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 500,
      canvasWidth: 1000,
      mediaHeight: 500,
      mediaWidth: 1000,
    });

    const label = resolveReactNativeLabelLayout({
      instruction: {
        background: {
          alpha: 0.8,
          color: 0x111827,
          paddingX: 6,
          paddingY: 3,
        },
        offsetY: 4,
        placement: LabelPlacement.Top,
        rect: { height: 100, width: 80, x: 100, y: 50 },
        text: "horse 92%",
      },
      layout,
      textSize: { height: 10, width: 40 },
    });

    expect(label.backgroundRect).toEqual({
      height: 16,
      width: 52,
      x: 100,
      y: 30,
    });
    expect(label.textPoint).toEqual({ x: 106, y: 33 });
  });

  it("maps media offsets through scale before placing a bottom label", () => {
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 250,
      canvasWidth: 500,
      mediaHeight: 500,
      mediaWidth: 1000,
    });

    const label = resolveReactNativeLabelLayout({
      instruction: {
        background: {
          alpha: 0.8,
          color: 0x111827,
          paddingX: 4,
          paddingY: 2,
        },
        offsetX: 10,
        offsetY: 8,
        placement: LabelPlacement.Bottom,
        rect: { height: 100, width: 80, x: 100, y: 50 },
        text: "horse 92%",
      },
      layout,
      textSize: { height: 10, width: 40 },
    });

    expect(label.backgroundRect).toEqual({
      height: 14,
      width: 48,
      x: 55,
      y: 79,
    });
    expect(label.textPoint).toEqual({ x: 59, y: 81 });
  });
});

describe("React Native live ID-mask artifacts", () => {
  it("bounds portrait camera frames by area and side caps", () => {
    const size = resolveReactNativeLiveIdMaskArtifactSize({
      frameHeight: 3840,
      frameWidth: 2160,
      maxPixels: 720 * 1280,
      maxSide: 1280,
    });

    expect(size.width * size.height).toBeLessThanOrEqual(720 * 1280 + 1280);
    expect(size.height).toBeLessThanOrEqual(1280);
    expect(size.width).toBeLessThanOrEqual(1280);
    expect(size.scale).toBeLessThan(1);
  });

  it("creates a bounded live artifact from raw model masks", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      borderWidth: 2,
      detections: [
        {
          bbox: { x1: 0, x2: 4, y1: 0, y2: 4 },
          color: 0x60a5fa,
          label: "laptop",
          mask: new Uint8Array([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ]),
          maskHeight: 4,
          maskWidth: 4,
          score: 0.92,
        },
        {
          bbox: { x1: 2, x2: 6, y1: 0, y2: 4 },
          color: 0x22c55e,
          label: "person",
          mask: new Uint8Array([
            1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ]),
          maskHeight: 4,
          maskWidth: 4,
          score: 0.84,
        },
      ],
      fillOpacity: 0.5,
      frameHeight: 4,
      frameWidth: 6,
      maxPixels: 24,
      maxSide: 6,
    });

    expect(artifact).toBeDefined();
    expect(artifact!.height).toBe(4);
    expect(artifact!.width).toBe(6);
    expect(artifact!.maskCount).toBe(2);
    expect(artifact!.opacity).toBe(0.5);
    expect(artifact!.hasStroke).toBe(true);
    expect(artifact!.maxStrokeWidth).toBe(2);
    expect(artifact!.strokeWidths[1]).toBe(2);
    expect(artifact!.strokeWidths[2]).toBe(2);
    expect(artifact!.data[0]).toBe(1);
    expect(artifact!.data[2]).toBe(2);
    expect(artifact!.fillPalette.slice(4, 8)).toEqual(
      new Float32Array([0x60 / 255, 0xa5 / 255, 0xfa / 255, 1]),
    );
  });

  it("resolves stable live colors from class names with palette fallback", () => {
    expect(resolveReactNativeLiveColorForClass("keyboard")).toBe(0x22c55e);
    expect(resolveReactNativeLiveColorForClass("potted plant")).toBe(0x34d399);
    expect(resolveReactNativeLiveColorForClass("new class", 3)).toBe(0xfacc15);
  });
});

describe("React Native ID-mask artifacts", () => {
  it("creates one prepared ID-mask artifact from core mask styles", () => {
    const frame: DetectionFrame = {
      detections: [
        {
          className: "horse",
          mask: {
            counts: encodeCompressedRleCounts([0, 2]),
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 1,
            width: 3,
          },
        },
        {
          className: "person",
          mask: {
            counts: encodeCompressedRleCounts([1, 1, 1]),
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 1,
            width: 3,
          },
        },
      ],
      frameIndex: 1,
      mediaTime: 1 / 30,
    };

    const artifact = createReactNativeIdMaskFrame({
      detectionFrame: frame,
      maskStyle: new BaseMaskStyle({
        color: (detection) =>
          detection.className === "person" ? 0x22c55e : 0x38bdf8,
        opacity: 0.7,
        stroke: { alpha: 1, color: 0xffffff, width: 3 },
      }),
    });

    expect(artifact).toBeDefined();
    expect([...artifact!.data]).toEqual([1, 2, 0]);
    expect(artifact!.maskCount).toBe(2);
    expect(artifact!.opacity).toBe(0.7);
    expect(artifact!.hasStroke).toBe(true);
    expect(artifact!.strokeWidths[1]).toBe(3);
  });

  it("returns undefined when no masks should render", () => {
    const frame: DetectionFrame = {
      detections: [
        {
          mask: {
            counts: encodeCompressedRleCounts([0, 1]),
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 1,
            width: 1,
          },
        },
      ],
      mediaTime: 0,
    };

    expect(
      createReactNativeIdMaskFrame({
        detectionFrame: frame,
        maskStyle: new BaseMaskStyle({
          mode: MaskRenderMode.FillOnly,
          shouldRender: () => false,
        }),
      }),
    ).toBeUndefined();
  });

  it("resolves shader uniforms from a prepared ID-mask artifact", () => {
    const artifact = createReactNativeIdMaskFrame({
      detectionFrame: {
        detections: [
          {
            mask: {
              counts: encodeCompressedRleCounts([0, 1]),
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 8,
              width: 4,
            },
          },
        ],
        mediaTime: 0,
      },
      maskStyle: new BaseMaskStyle({
        color: 0xff0000,
        opacity: 0.4,
      }),
    });

    const uniforms = resolveReactNativeIdMaskUniforms({
      artifact: artifact!,
      layout: resolveReactNativeFrameLayout({
        canvasHeight: 50,
        canvasWidth: 100,
        mediaHeight: 8,
        mediaWidth: 4,
      }),
    });

    expect(uniforms.uOpacity).toBe(0.4);
    expect(uniforms.uEdgeSmoothing).toBe(
      DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING,
    );
    expect([...uniforms.uTextureSize]).toEqual([4, 8]);
    expect([...uniforms.uMediaRect]).toEqual([37.5, 0, 25, 50]);
    expect(uniforms.uBorderEnabled).toBe(0);
    expect(Array.isArray(uniforms.uFillPalette)).toBe(true);
    expect(uniforms.uFillPalette).toHaveLength(256);
    expect(uniforms.uFillPalette.slice(4, 8)).toEqual([1, 0, 0, 1]);
  });

  it("clamps configured edge smoothing for shader uniforms", () => {
    const artifact = createReactNativeIdMaskFrame({
      detectionFrame: {
        detections: [
          {
            mask: {
              counts: encodeCompressedRleCounts([0, 1]),
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 1,
              width: 1,
            },
          },
        ],
        mediaTime: 0,
      },
      maskStyle: new BaseMaskStyle({ color: 0xff0000 }),
    });

    const uniforms = resolveReactNativeIdMaskUniforms({
      artifact: artifact!,
      edgeSmoothing: 2,
      layout: resolveReactNativeFrameLayout({
        canvasHeight: 1,
        canvasWidth: 1,
        mediaHeight: 1,
        mediaWidth: 1,
      }),
    });

    expect(uniforms.uEdgeSmoothing).toBe(1);
  });

  it("uses constant palette lookups for SkSL shader compatibility", () => {
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).not.toContain(
      "uFillPalette[maskId]",
    );
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).not.toContain(
      "uStrokePalette[maskId]",
    );
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).not.toContain(
      "uStrokeWidths[maskId]",
    );
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain(
      "return uFillPalette[1];",
    );
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain("uEdgeSmoothing");
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
