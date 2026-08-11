import {
  DetectionPickTarget,
  encodeCompressedRleCounts,
  MaskRenderMode,
  resolveDetectionClassColorStyle,
  type DetectionFrame,
} from "supervision-js-core";
import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  annotationRenderers,
  createEmptyReactNativeLiveIdMaskUniforms,
  createReactNativePreparedFramePacket,
  createReactNativeLiveIdMaskArtifact,
  createReactNativeLiveIdMaskArtifactAuto,
  createReactNativeIdMaskFrame,
  DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING,
  DetectionMaskEncoding,
  LabelPlacement,
  MAX_ID_MASK_PALETTE_ENTRIES,
  pickReactNativeDetectionAtPoint,
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
  REACT_NATIVE_LIVE_ID_MASK_DEFAULTS,
  resolveDetectionClassColorStyle as reactNativeResolveDetectionClassColorStyle,
  resolveReactNativeLiveIdMaskArtifactSize,
  resolveReactNativeLiveIdMaskUniforms,
  resolveReactNativeIdMaskUniforms,
  resolveReactNativeFrameLayout,
  resolveReactNativeLabelLayout,
  resolveReactNativeFramePresentation,
  type ReactNativeFramePresentation,
  type ReactNativeLiveIdMaskArtifactOptions,
  type ReactNativeLiveIdMaskNativeBuilderHandle,
} from "./index";
import { createReactNativeVideoFrameSource } from "./index";
import type {
  IdMaskBuildArtifact,
  IdMaskBuildOptions,
} from "./specs/IdMaskBuilder.nitro";
import { describe, expect, it } from "vitest";

describe("resolveReactNativeFramePresentation", () => {
  it("uses renderer descriptors to select native frame layers", () => {
    const presentation = resolveReactNativeFramePresentation({
      detectionFrame: {
        detections: [
          { id: "player", rect: { height: 30, width: 20, x: 10, y: 20 } },
        ],
        mediaTime: 0,
      },
      labelStyle: new BaseLabelStyle(),
      mediaFrame: {
        metadata: {
          duration: 1 / 30,
          frameIndex: 0,
          height: 1080,
          mediaTime: 0,
          width: 1920,
        },
        payload: { nativeTextureId: "texture-renderers" },
      },
      renderers: [
        annotationRenderers.box({
          style: new BaseBoxStyle({ stroke: { color: 0x8b5cf6, width: 2 } }),
        }),
      ],
    });

    expect(presentation.boxes).toHaveLength(1);
    expect(presentation.labels).toHaveLength(0);
  });

  it("reports asset regions as unsupported instead of omitting them", () => {
    expect(() =>
      resolveReactNativeFramePresentation({
        detectionFrame: { detections: [], mediaTime: 0 },
        mediaFrame: {
          metadata: {
            duration: 1 / 30,
            frameIndex: 0,
            height: 1080,
            mediaTime: 0,
            width: 1920,
          },
          payload: { nativeTextureId: "texture-regions" },
        },
        renderers: [
          annotationRenderers.region({
            id: "badge",
            region: { kind: "bounds" },
            source: { asset: { src: "/badge.png" }, kind: "asset" },
            target: {},
          }),
        ],
      }),
    ).toThrowError(
      'React Native frame presentation does not support annotation renderer kind "region".',
    );
  });

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

describe("createReactNativePreparedFramePacket", () => {
  it("resolves draw instructions and the prepared ID-mask artifact together", () => {
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
    const maskStyle = new BaseMaskStyle({ alpha: 0.7, color: 0x38bdf8 });

    const packet = createReactNativePreparedFramePacket({
      boxStyle: new BaseBoxStyle({
        shape: BoxShape.RoundedRect,
        stroke: { color: 0x22c55e, width: 3 },
      }),
      detectionFrame,
      labelStyle: new BaseLabelStyle({ includeConfidence: true }),
      maskStyle,
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

    expect(packet.presentation.boxes).toHaveLength(1);
    expect(packet.presentation.labels[0]?.text).toBe("horse 92%");
    expect(packet.maskArtifact?.maskCount).toBe(1);
    expect(packet.maskArtifact?.opacity).toBe(0.7);
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
        x: 150,
        y: 291.875,
      },
    );
    expect(layout.mapPoint({ x: 1920, y: 1080 })).toEqual({
      x: 400,
      y: 432.5,
    });
  });

  it("covers the canvas by cropping media edges when requested", () => {
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 640,
      canvasWidth: 400,
      fit: "cover",
      mediaHeight: 1080,
      mediaWidth: 1920,
    });

    expect(layout.mediaRect).toEqual({
      height: 640,
      width: 1137.7777777777778,
      x: -368.8888888888889,
      y: 0,
    });
    const mapped = layout.mapCanvasPoint({ x: 0, y: 320 });
    expect(mapped?.x).toBeCloseTo(622.5);
    expect(mapped?.y).toBe(540);
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
        rect: { height: 100, width: 80, x: 140, y: 100 },
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
        rect: { height: 100, width: 80, x: 140, y: 100 },
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

  it("re-exports core's class color resolver as the same function", () => {
    // One central color logic for web and React Native: the package barrel
    // must hand out core's function itself, not a copy.
    expect(reactNativeResolveDetectionClassColorStyle).toBe(
      resolveDetectionClassColorStyle,
    );
    expect(resolveDetectionClassColorStyle("yellow_team_player").fill).toBe(
      0xfacc15,
    );
  });

  it("covers every declared shader uniform with the empty uniforms", () => {
    // A missing key throws "Missing uniform value" at render time; this
    // pins the empty-state factory to the shader's declaration list.
    const uniforms = createEmptyReactNativeLiveIdMaskUniforms();
    const declared = [
      ...REACT_NATIVE_ID_MASK_SHADER_SOURCE.matchAll(
        /uniform\s+(?!shader)\S+\s+(\w+)/g,
      ),
    ].map((match) => match[1]!);

    expect(declared.length).toBeGreaterThan(5);

    for (const name of declared) {
      expect(uniforms[name], name).toBeDefined();
    }
  });

  it("applies the live artifact size defaults when bounds are omitted", () => {
    const bounded = resolveReactNativeLiveIdMaskArtifactSize({
      frameHeight: 4000,
      frameWidth: 3000,
    });
    const explicit = resolveReactNativeLiveIdMaskArtifactSize({
      frameHeight: 4000,
      frameWidth: 3000,
      maxPixels: REACT_NATIVE_LIVE_ID_MASK_DEFAULTS.maxPixels,
      maxSide: REACT_NATIVE_LIVE_ID_MASK_DEFAULTS.maxSide,
    });

    expect(bounded).toEqual(explicit);
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(
      REACT_NATIVE_LIVE_ID_MASK_DEFAULTS.maxPixels,
    );
  });

  it("renders later detections on top of earlier overlapping detections", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        createFullCoverageLiveDetection({ color: 0x38bdf8 }),
        createFullCoverageLiveDetection({ color: 0x22c55e }),
      ],
      frameHeight: 4,
      frameWidth: 4,
      maxPixels: 16,
      maxSide: 4,
    });

    expect(artifact).toBeDefined();
    expect(artifact!.maskCount).toBe(2);
    expect(new Set(artifact!.data)).toEqual(new Set([2]));
  });

  it("skips masks whose byte length does not match their dimensions", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        {
          ...createFullCoverageLiveDetection({ color: 0x38bdf8 }),
          mask: new Uint8Array([1, 1, 1]),
        },
        createFullCoverageLiveDetection({ color: 0x22c55e }),
      ],
      frameHeight: 4,
      frameWidth: 4,
      maxPixels: 16,
      maxSide: 4,
    });

    expect(artifact).toBeDefined();
    expect(artifact!.maskCount).toBe(1);
    expect(new Set(artifact!.data)).toEqual(new Set([2]));
    expect([...artifact!.fillPalette.slice(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(artifact!.fillPalette[11]).toBe(1);
  });

  it("returns undefined when every mask is invalid or absent", () => {
    expect(
      createReactNativeLiveIdMaskArtifact({
        detections: [
          {
            ...createFullCoverageLiveDetection({ color: 0x38bdf8 }),
            mask: new Uint8Array([1, 1, 1]),
          },
        ],
        frameHeight: 4,
        frameWidth: 4,
        maxPixels: 16,
        maxSide: 4,
      }),
    ).toBeUndefined();
    expect(
      createReactNativeLiveIdMaskArtifact({
        detections: [],
        frameHeight: 4,
        frameWidth: 4,
        maxPixels: 16,
        maxSide: 4,
      }),
    ).toBeUndefined();
  });

  it("clamps detections to the palette limit", () => {
    const detections = Array.from({ length: 70 }, () =>
      createFullCoverageLiveDetection({ color: 0x38bdf8 }),
    );

    const artifact = createReactNativeLiveIdMaskArtifact({
      detections,
      frameHeight: 4,
      frameWidth: 4,
      maxPixels: 16,
      maxSide: 4,
    });

    expect(artifact).toBeDefined();
    expect(artifact!.maskCount).toBe(MAX_ID_MASK_PALETTE_ENTRIES - 1);
  });

  it("samples clockwise-rotated masks identically to their upright originals", () => {
    // Logical 3x2 mask (width 3, height 2): row0 = [1, 0, 1], row1 = [0, 1, 0].
    const upright = new Uint8Array([1, 0, 1, 0, 1, 0]);
    // The same mask rotated 90° clockwise is 2x3 (width 2, height 3):
    // rotated(x, y) = upright(y', x') with x = H-1-y', y = x'.
    const rotated = new Uint8Array([0, 1, 1, 0, 0, 1]);
    const sizing = {
      frameHeight: 4,
      frameWidth: 6,
      maxPixels: 24,
      maxSide: 6,
    };
    const bbox = { x1: 0, x2: 6, y1: 0, y2: 4 };

    const uprightArtifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        {
          bbox,
          color: 0x38bdf8,
          label: "object",
          mask: upright,
          maskHeight: 2,
          maskWidth: 3,
          score: 0.9,
        },
      ],
      ...sizing,
    });
    const rotatedArtifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        {
          bbox,
          color: 0x38bdf8,
          label: "object",
          mask: rotated,
          maskHeight: 3,
          maskRotatedCw: true,
          maskWidth: 2,
          score: 0.9,
        },
      ],
      ...sizing,
    });

    expect(rotatedArtifact!.data).toEqual(uprightArtifact!.data);
    expect(rotatedArtifact!.edgeFeatherTexels).toBe(
      uprightArtifact!.edgeFeatherTexels,
    );
  });

  it("draws the raw model mask footprint without reshaping it", () => {
    // 2x2 mask with an empty bottom-right quadrant, upscaled to 8x8: the
    // empty quadrant must stay an exact 4x4 block.
    const artifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        {
          bbox: { x1: 0, x2: 8, y1: 0, y2: 8 },
          color: 0x38bdf8,
          label: "sink",
          mask: new Uint8Array([1, 1, 1, 0]),
          maskHeight: 2,
          maskWidth: 2,
          score: 0.9,
        },
      ],
      frameHeight: 8,
      frameWidth: 8,
      maxPixels: 64,
      maxSide: 8,
    });

    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const expected = x >= 4 && y >= 4 ? 0 : 1;

        expect(artifact!.data[y * 8 + x]).toBe(expected);
      }
    }
  });

  it("resolves live shader uniforms from a live artifact and media rect", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      borderWidth: 2,
      detections: [createFullCoverageLiveDetection({ color: 0x60a5fa })],
      fillOpacity: 0.5,
      frameHeight: 4,
      frameWidth: 4,
      maxPixels: 16,
      maxSide: 4,
    });

    const uniforms = resolveReactNativeLiveIdMaskUniforms({
      artifact: artifact!,
      mediaRect: { height: 100, width: 50, x: 5, y: 10 },
    });

    expect(uniforms.uBorderEnabled).toBe(1);
    expect(uniforms.uEdgeSmoothing).toBe(
      DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING,
    );
    expect(uniforms.uMaxStrokeWidth).toBe(2);
    expect([...uniforms.uMediaRect]).toEqual([5, 10, 50, 100]);
    expect(uniforms.uOpacity).toBe(0.5);
    expect([...uniforms.uTextureSize]).toEqual([
      artifact!.width,
      artifact!.height,
    ]);
    expect(uniforms.uFillPalette).toHaveLength(MAX_ID_MASK_PALETTE_ENTRIES * 4);
    expect(uniforms.uFillPalette.slice(4, 8)).toEqual(
      [0x60 / 255, 0xa5 / 255, 0xfa / 255, 1].map(Math.fround),
    );
    expect(uniforms.uStrokeWidths[1]).toBe(2);
    // 2x2 mask over a 4x4 artifact: cells span 2 texels, feather is half.
    expect(uniforms.uFeatherTexels).toBe(1);
    expect(new Set(uniforms.uMosaicFlags)).toEqual(new Set([0]));
  });

  it("flags mosaic mask ids in the shader uniforms", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      borderWidth: 2,
      detections: [
        createFullCoverageLiveDetection({ color: 0x38bdf8 }),
        createFullCoverageLiveDetection({ color: 0x22c55e }),
      ],
      frameHeight: 4,
      frameWidth: 4,
      maxPixels: 16,
      maxSide: 4,
    });

    const uniforms = resolveReactNativeLiveIdMaskUniforms({
      artifact: artifact!,
      mediaRect: { height: 4, width: 4, x: 0, y: 0 },
      mosaicCellPx: 14,
      mosaicMaskIds: [2, 999],
    });

    expect(uniforms.uMosaicCellPx).toBe(14);
    expect(uniforms.uMosaicFlags).toHaveLength(MAX_ID_MASK_PALETTE_ENTRIES);
    expect(uniforms.uMosaicFlags[1]).toBe(0);
    expect(uniforms.uMosaicFlags[2]).toBe(1);
    expect(uniforms.uBorderEnabled).toBe(1);
    expect(uniforms.uStrokeWidths[2]).toBe(2);
  });

  it("enables the spotlight veil for spotlit mask ids", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        createFullCoverageLiveDetection({ color: 0x38bdf8 }),
        createFullCoverageLiveDetection({ color: 0x22c55e }),
      ],
      frameHeight: 4,
      frameWidth: 4,
      maxPixels: 16,
      maxSide: 4,
    });

    const plain = resolveReactNativeLiveIdMaskUniforms({
      artifact: artifact!,
      mediaRect: { height: 4, width: 4, x: 0, y: 0 },
    });

    expect(plain.uSpotlightEnabled).toBe(0);
    expect(new Set(plain.uSpotlightFlags)).toEqual(new Set([0]));

    const spotlit = resolveReactNativeLiveIdMaskUniforms({
      artifact: artifact!,
      mediaRect: { height: 4, width: 4, x: 0, y: 0 },
      spotlightMaskIds: [1],
    });

    expect(spotlit.uSpotlightEnabled).toBe(1);
    expect(spotlit.uSpotlightFlags[1]).toBe(1);
    expect(spotlit.uSpotlightFlags[2]).toBe(0);
  });

  it("scales and clamps the edge feather to the mask cell size", () => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      detections: [
        {
          bbox: { x1: 0, x2: 48, y1: 0, y2: 48 },
          color: 0x38bdf8,
          label: "sink",
          mask: new Uint8Array([1, 1, 1, 1]),
          maskHeight: 2,
          maskWidth: 2,
          score: 0.9,
        },
      ],
      frameHeight: 48,
      frameWidth: 48,
      maxPixels: 48 * 48,
      maxSide: 48,
    });

    // Cells span 24 texels; half is 12, which is also the clamp ceiling.
    expect(artifact!.edgeFeatherTexels).toBe(12);
    expect(
      resolveReactNativeLiveIdMaskUniforms({
        artifact: artifact!,
        mediaRect: { height: 48, width: 48, x: 0, y: 0 },
      }).uFeatherTexels,
    ).toBe(12);
  });
});

describe("React Native live ID-mask auto builder", () => {
  const buildOptions: ReactNativeLiveIdMaskArtifactOptions = {
    borderWidth: 1,
    detections: [
      createFullCoverageLiveDetection({ color: 0x60a5fa }),
      {
        bbox: { x1: 1, x2: 3, y1: 1, y2: 3 },
        color: 0x22c55e,
        label: "person",
        mask: new Uint8Array([1, 0, 0, 1]),
        maskHeight: 2,
        maskWidth: 2,
        score: 0.9,
      },
    ],
    fillOpacity: 0.5,
    frameHeight: 4,
    frameWidth: 4,
    maxPixels: 16,
    maxSide: 4,
  };

  it("uses the JS builder with a reason when no native builder is loaded", () => {
    const result = createReactNativeLiveIdMaskArtifactAuto(buildOptions);

    expect(result).toBeDefined();
    expect(result!.diagnostics.builder).toBe("js");
    expect(result!.diagnostics.fallbackReason).toBe(
      "native-id-mask-builder-not-loaded",
    );
    expect(result!.artifact).toEqual(
      createReactNativeLiveIdMaskArtifact(buildOptions),
    );
  });

  it("surfaces the load fallback reason when the native module is unavailable", () => {
    const result = createReactNativeLiveIdMaskArtifactAuto({
      ...buildOptions,
      nativeBuilder: {
        boxed: null,
        fallbackReason: "pod-not-installed",
      },
    });

    expect(result!.diagnostics.builder).toBe("js");
    expect(result!.diagnostics.fallbackReason).toBe("pod-not-installed");
  });

  it("produces the same artifact through the native builder seam", () => {
    const result = createReactNativeLiveIdMaskArtifactAuto({
      ...buildOptions,
      nativeBuilder: createNativeLikeIdMaskBuilderHandle(),
    });
    const reference = createReactNativeLiveIdMaskArtifact(buildOptions);

    expect(result).toBeDefined();
    expect(result!.diagnostics.builder).toBe("native");
    expect(result!.diagnostics.fallbackReason).toBeUndefined();
    expect(result!.artifact).toEqual({ ...reference, nativeFillMs: 0 });
  });

  it("returns undefined when the native builder produces no visible mask", () => {
    const result = createReactNativeLiveIdMaskArtifactAuto({
      ...buildOptions,
      detections: [
        {
          ...createFullCoverageLiveDetection({ color: 0x38bdf8 }),
          mask: new Uint8Array([1, 1, 1]),
        },
      ],
      nativeBuilder: createNativeLikeIdMaskBuilderHandle(),
    });

    expect(result).toBeUndefined();
  });

  it("falls back to the JS builder when the native builder throws", () => {
    const result = createReactNativeLiveIdMaskArtifactAuto({
      ...buildOptions,
      nativeBuilder: {
        boxed: {
          unbox: () => ({
            createArtifact() {
              throw new Error("native fill exploded");
            },
          }),
        },
      },
    });

    expect(result).toBeDefined();
    expect(result!.diagnostics.builder).toBe("js");
    expect(result!.diagnostics.fallbackReason).toBe("native fill exploded");
    expect(result!.artifact).toEqual(
      createReactNativeLiveIdMaskArtifact(buildOptions),
    );
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
    const mosaicBranchStart = REACT_NATIVE_ID_MASK_SHADER_SOURCE.indexOf(
      "if (resolveMosaicFlag(maskId) > 0.5)",
    );
    const mosaicBranch = REACT_NATIVE_ID_MASK_SHADER_SOURCE.slice(
      mosaicBranchStart,
      REACT_NATIVE_ID_MASK_SHADER_SOURCE.indexOf(
        "if (uSpotlightEnabled > 0.5)",
        mosaicBranchStart,
      ),
    );

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
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain("uFeatherTexels");
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain("uMosaicCellPx");
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain(
      "resolveMosaicFlag(maskId)",
    );
    expect(mosaicBranch).toContain("if (onBorder)");
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain(
      "resolveSpotlightFlag(maskId)",
    );
    expect(REACT_NATIVE_ID_MASK_SHADER_SOURCE).toContain("uSpotlightEnabled");
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

describe("React Native video frame source", () => {
  it("degrades to a null handle with a reason outside React Native", () => {
    const handle = createReactNativeVideoFrameSource();

    expect(handle.boxed).toBeNull();
    expect(typeof handle.fallbackReason).toBe("string");
  });
});

function createFullCoverageLiveDetection(options: { readonly color: number }) {
  return {
    bbox: { x1: 0, x2: 4, y1: 0, y2: 4 },
    color: options.color,
    label: "object",
    mask: new Uint8Array([1, 1, 1, 1]),
    maskHeight: 2,
    maskWidth: 2,
    score: 0.9,
  };
}

/**
 * Emulates the Swift Nitro builder: consumes the nitro option structs and
 * returns the raw-ArrayBuffer artifact shape, computed with the JS reference
 * fill so the wrapper's option/result mapping round-trips byte-for-byte.
 */
function createNativeLikeIdMaskBuilderHandle(): ReactNativeLiveIdMaskNativeBuilderHandle {
  const createArtifact = (options: IdMaskBuildOptions): IdMaskBuildArtifact => {
    const artifact = createReactNativeLiveIdMaskArtifact({
      borderWidth: options.borderWidth,
      detections: options.detections.map((detection) => ({
        bbox: detection.bbox,
        color: detection.color,
        label: detection.className,
        mask: new Uint8Array(detection.mask),
        maskHeight: detection.maskHeight,
        maskRotatedCw: detection.maskRotatedCw,
        maskWidth: detection.maskWidth,
        score: detection.confidence,
      })),
      fillOpacity: options.fillOpacity,
      frameHeight: options.frameHeight,
      frameWidth: options.frameWidth,
      maxPixels: options.maxPixels,
      maxSide: options.maxSide,
    });

    if (!artifact) {
      return {
        data: new ArrayBuffer(0),
        edgeFeatherTexels: 1,
        fillMs: 0,
        fillPalette: new ArrayBuffer(options.maxPaletteEntries * 4 * 4),
        hasStroke: false,
        height: 1,
        maskCount: 0,
        maxStrokeWidth: 0,
        opacity: options.fillOpacity,
        scale: 1,
        strokePalette: new ArrayBuffer(options.maxPaletteEntries * 4 * 4),
        strokeWidths: new ArrayBuffer(options.maxPaletteEntries * 4),
        width: 1,
      };
    }

    return {
      data: artifact.data.buffer,
      edgeFeatherTexels: artifact.edgeFeatherTexels,
      fillMs: 0,
      fillPalette: artifact.fillPalette.buffer,
      hasStroke: artifact.hasStroke,
      height: artifact.height,
      maskCount: artifact.maskCount,
      maxStrokeWidth: artifact.maxStrokeWidth,
      opacity: artifact.opacity,
      scale: artifact.scale,
      strokePalette: artifact.strokePalette.buffer,
      strokeWidths: artifact.strokeWidths.buffer,
      width: artifact.width,
    };
  };

  return {
    boxed: {
      unbox: () => ({ createArtifact }),
    },
  };
}
