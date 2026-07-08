import type {
  BoxDrawInstruction,
  DetectionFrame,
  DetectionPickOptions,
  DetectionPickResult,
  IdMaskFrame,
  IdMaskInstruction,
  LabelDrawInstruction,
  MaskDrawInstruction,
  MaskStyle,
  MediaFrameMetadata,
  MediaRendererPresentation,
  PlatformMediaFrame,
  Rect,
} from "supervision-js-core";
import {
  createIdMaskFrame,
  LabelPlacement,
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
  pickDetectionAtPoint,
} from "supervision-js-core";

export {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
} from "supervision-js-core";

import {
  createReactNativeLiveIdMaskArtifactWithNativeBuilder,
  isReactNativeLiveIdMaskNativeBuilderAvailable,
  type ReactNativeLiveIdMaskNativeBuilderHandle,
} from "./native-id-mask-builder";

export {
  createReactNativeLiveIdMaskArtifactWithNativeBuilder,
  isReactNativeLiveIdMaskNativeBuilderAvailable,
  loadReactNativeLiveIdMaskNativeBuilder,
  REACT_NATIVE_LIVE_ID_MASK_NATIVE_BUILDER_NAME,
} from "./native-id-mask-builder";
export type {
  ReactNativeLiveIdMaskBoxedNativeBuilder,
  ReactNativeLiveIdMaskNativeBuilder,
  ReactNativeLiveIdMaskNativeBuilderHandle,
} from "./native-id-mask-builder";

export const DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING = 0.85;

const fillPaletteLookup = createShaderArrayLookup({
  fallback: "half4(0.0)",
  functionName: "resolveFillColor",
  paletteName: "uFillPalette",
  returnType: "half4",
});
const strokePaletteLookup = createShaderArrayLookup({
  fallback: "half4(0.0)",
  functionName: "resolveStrokeColor",
  paletteName: "uStrokePalette",
  returnType: "half4",
});
const strokeWidthLookup = createShaderArrayLookup({
  fallback: "0.0",
  functionName: "resolveStrokeWidth",
  paletteName: "uStrokeWidths",
  returnType: "float",
});

export const REACT_NATIVE_ID_MASK_SHADER_SOURCE = `
uniform shader uMask;
uniform half4 uFillPalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform half4 uStrokePalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform float uStrokeWidths[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform float2 uTextureSize;
uniform float4 uMediaRect;
uniform float uOpacity;
uniform float uBorderEnabled;
uniform float uEdgeSmoothing;
uniform float uFeatherTexels;
uniform float uMaxStrokeWidth;

float sampleMaskId(float2 point) {
  half4 sampleColor = uMask.eval(point);
  float sampleValue = max(
    max(float(sampleColor.r), float(sampleColor.g)),
    max(float(sampleColor.b), float(sampleColor.a))
  );

  return floor(sampleValue * 255.0 + 0.5);
}

${fillPaletteLookup}

${strokePaletteLookup}

${strokeWidthLookup}

float2 resolveMaskTexel() {
  return float2(
    uMediaRect.z / max(uTextureSize.x, 1.0),
    uMediaRect.w / max(uTextureSize.y, 1.0)
  );
}

float resolveNeighborMaskId(float2 coord, float2 texel) {
  float left = sampleMaskId(coord + texel * float2(-1.0, 0.0));

  if (left > 0.0) {
    return left;
  }

  float right = sampleMaskId(coord + texel * float2(1.0, 0.0));

  if (right > 0.0) {
    return right;
  }

  float up = sampleMaskId(coord + texel * float2(0.0, -1.0));

  if (up > 0.0) {
    return up;
  }

  float down = sampleMaskId(coord + texel * float2(0.0, 1.0));

  if (down > 0.0) {
    return down;
  }

  return 0.0;
}

float resolveSameNeighborRatio(float2 coord, float2 texel, float id) {
  float matching = 0.0;

  matching += sampleMaskId(coord + texel * float2(-1.0, 0.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(1.0, 0.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(0.0, -1.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(0.0, 1.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(-1.0, -1.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(1.0, -1.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(-1.0, 1.0)) == id ? 1.0 : 0.0;
  matching += sampleMaskId(coord + texel * float2(1.0, 1.0)) == id ? 1.0 : 0.0;

  return matching / 8.0;
}

half4 main(float2 coord) {
  float id = sampleMaskId(coord);
  float2 texel = resolveMaskTexel();
  float2 featherTexel = texel * max(uFeatherTexels, 1.0);
  float edgeSmoothing = clamp(uEdgeSmoothing, 0.0, 1.0);

  if (id <= 0.0) {
    if (edgeSmoothing > 0.0) {
      float neighborId = resolveNeighborMaskId(coord, featherTexel);

      if (neighborId > 0.0) {
        float neighborRatio =
          resolveSameNeighborRatio(coord, featherTexel, neighborId);
        int neighborMaskId = int(neighborId);
        half4 neighborColor = resolveFillColor(neighborMaskId);
        half featherAlpha = neighborColor.a * half(uOpacity) *
          half(0.45 * edgeSmoothing * smoothstep(0.0, 1.0, neighborRatio));

        return half4(neighborColor.rgb * featherAlpha, featherAlpha);
      }
    }

    return half4(0.0);
  }

  int maskId = int(id);
  half4 fillColor = resolveFillColor(maskId);
  half outputAlpha = fillColor.a * half(uOpacity);

  if (edgeSmoothing > 0.0) {
    float sameNeighborRatio =
      resolveSameNeighborRatio(coord, featherTexel, id);
    half edgeAlphaMultiplier = half(mix(
      1.0,
      smoothstep(0.0, 1.0, sameNeighborRatio),
      edgeSmoothing
    ));

    outputAlpha *= edgeAlphaMultiplier;
  }

  half4 outputColor = half4(fillColor.rgb * outputAlpha, outputAlpha);
  float strokeWidth = resolveStrokeWidth(maskId);

  if (uBorderEnabled > 0.5 && strokeWidth > 0.0) {
    float radius = min(strokeWidth, uMaxStrokeWidth);
    bool onBorder = false;

    for (int dy = -${MAX_ID_MASK_STROKE_WIDTH}; dy <= ${MAX_ID_MASK_STROKE_WIDTH}; dy++) {
      for (int dx = -${MAX_ID_MASK_STROKE_WIDTH}; dx <= ${MAX_ID_MASK_STROKE_WIDTH}; dx++) {
        float distance = length(float2(float(dx), float(dy)));

        if (distance <= radius && sampleMaskId(coord + texel * float2(float(dx), float(dy))) != id) {
          onBorder = true;
        }
      }
    }

    if (onBorder) {
      half4 strokeColor = resolveStrokeColor(maskId);
      half strokeAlpha = strokeColor.a * half(mix(1.0, 0.88, edgeSmoothing));
      outputColor = half4(strokeColor.rgb * strokeAlpha, strokeAlpha);
    }
  }

  return outputColor;
}
`;

/**
 * Externally supplied React Native media frame.
 *
 * The handle is intentionally opaque. Host apps may pass a native texture id,
 * image URI, Skia image object, camera frame reference, or test fixture.
 */
export type ReactNativeMediaFrame<THandle = unknown> =
  PlatformMediaFrame<THandle>;

export interface ReactNativeFramePresentationOptions<THandle = unknown> {
  readonly mediaFrame: ReactNativeMediaFrame<THandle>;
  readonly detectionFrame: DetectionFrame;
}

export type ReactNativeFramePresentationStyleOptions =
  MediaRendererPresentation;

/**
 * Core-resolved draw instructions ready for a React Native renderer adapter.
 *
 * This package does not choose Skia, a native GL surface, or a video/camera
 * provider yet. It proves the non-web boundary: core semantic data and styles
 * can be resolved without importing browser or Pixi/Mediabunny code.
 */
export interface ReactNativeFramePresentation<THandle = unknown> {
  readonly mediaFrame: ReactNativeMediaFrame<THandle>;
  readonly mediaMetadata: MediaFrameMetadata;
  readonly boxes: readonly BoxDrawInstruction[];
  readonly labels: readonly LabelDrawInstruction[];
  readonly masks: readonly MaskDrawInstruction[];
  readonly maskOpacity: number | null;
}

export interface ReactNativePreparedFramePacket<THandle = unknown> {
  readonly maskArtifact?: ReactNativeIdMaskFrame;
  readonly presentation: ReactNativeFramePresentation<THandle>;
}

export interface ReactNativeFrameLayoutOptions {
  readonly canvasHeight: number;
  readonly canvasWidth: number;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}

export interface ReactNativePoint {
  readonly x: number;
  readonly y: number;
}

export interface ReactNativeFrameLayout {
  readonly mediaRect: Rect;
  readonly scale: number;
  mapPoint(point: ReactNativePoint): ReactNativePoint;
  mapCanvasPoint(point: ReactNativePoint): ReactNativePoint | null;
  mapRect(rect: Rect): Rect;
}

export interface ReactNativeSize {
  readonly height: number;
  readonly width: number;
}

export interface ReactNativeLabelLayoutOptions {
  readonly instruction: LabelDrawInstruction;
  readonly layout: ReactNativeFrameLayout;
  readonly textSize: ReactNativeSize;
}

export interface ReactNativeLabelLayout {
  readonly backgroundRect: Rect;
  readonly cornerRadius: number;
  readonly textPoint: ReactNativePoint;
}

export interface ReactNativeIdMaskFrameOptions {
  readonly detectionFrame: DetectionFrame;
  readonly maskStyle: MaskStyle;
  readonly mediaTime?: number;
}

export interface ReactNativeIdMaskFrame extends IdMaskFrame {
  readonly maskCount: number;
  readonly opacity: number;
}

export interface ReactNativeIdMaskUniformOptions {
  readonly artifact: ReactNativeIdMaskFrame;
  readonly edgeSmoothing?: number;
  readonly layout: ReactNativeFrameLayout;
}

export interface ReactNativeIdMaskUniforms {
  readonly [name: string]: number | readonly number[];
  readonly uBorderEnabled: number;
  readonly uEdgeSmoothing: number;
  readonly uFeatherTexels: number;
  readonly uFillPalette: readonly number[];
  readonly uMaxStrokeWidth: number;
  readonly uMediaRect: readonly number[];
  readonly uOpacity: number;
  readonly uStrokePalette: readonly number[];
  readonly uStrokeWidths: readonly number[];
  readonly uTextureSize: readonly number[];
}

export interface ReactNativeLiveSerializedDetection {
  readonly bbox: {
    readonly x1: number;
    readonly x2: number;
    readonly y1: number;
    readonly y2: number;
  };
  readonly color: number;
  readonly label?: string;
  readonly mask: Uint8Array;
  readonly maskHeight: number;
  readonly maskWidth: number;
  readonly score?: number;
}

export interface ReactNativeLiveIdMaskArtifactSizeOptions {
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly maxPixels: number;
  readonly maxSide: number;
}

export interface ReactNativeLiveIdMaskArtifactOptions extends ReactNativeLiveIdMaskArtifactSizeOptions {
  readonly borderWidth?: number;
  readonly detections: readonly ReactNativeLiveSerializedDetection[];
  readonly fillOpacity?: number;
}

export interface ReactNativeLiveIdMaskArtifact extends ReactNativeIdMaskFrame {
  readonly scale: number;
  /**
   * Half of the largest model-mask cell size in artifact texels, clamped to
   * [1, 12]. The shader feathers mask edges over this radius so low-resolution
   * masks render with soft edges instead of hard staircases.
   */
  readonly edgeFeatherTexels: number;
  /**
   * Pure native fill-loop time when the native builder produced this
   * artifact, excluding JSI argument/result conversion. Absent on JS builds.
   */
  readonly nativeFillMs?: number;
}

export interface ReactNativeLiveIdMaskBuilder {
  build(
    options: ReactNativeLiveIdMaskArtifactOptions,
  ): ReactNativeLiveIdMaskArtifact | undefined;
}

export interface ReactNativeLiveIdMaskBuildDiagnostics {
  readonly builder: "native" | "js";
  readonly fillMs: number;
  readonly uploadMs?: number;
  readonly fallbackReason?: string;
}

export interface ReactNativeLiveIdMaskBuildResult {
  readonly artifact: ReactNativeLiveIdMaskArtifact;
  readonly diagnostics: ReactNativeLiveIdMaskBuildDiagnostics;
}

export interface ReactNativeLiveIdMaskArtifactAutoOptions extends ReactNativeLiveIdMaskArtifactOptions {
  readonly nativeBuilder?: ReactNativeLiveIdMaskNativeBuilderHandle | null;
}

export interface ReactNativeLiveIdMaskUniformOptions {
  readonly artifact: ReactNativeLiveIdMaskArtifact;
  readonly edgeSmoothing?: number;
  readonly mediaRect: Rect;
}

export const REACT_NATIVE_ROBOFLOW_PALETTE = [
  0x38bdf8, 0x22c55e, 0xa78bfa, 0xfacc15, 0xf97316, 0xf472b6, 0x60a5fa,
  0xfb7185, 0x34d399, 0xe879f9,
] as const;

export function resolveReactNativeFrameLayout(
  options: ReactNativeFrameLayoutOptions,
): ReactNativeFrameLayout {
  const scale = Math.min(
    options.canvasWidth / options.mediaWidth,
    options.canvasHeight / options.mediaHeight,
  );
  const width = options.mediaWidth * scale;
  const height = options.mediaHeight * scale;
  const x = (options.canvasWidth - width) / 2;
  const y = (options.canvasHeight - height) / 2;

  return {
    mapPoint(point) {
      return {
        x: x + point.x * scale,
        y: y + point.y * scale,
      };
    },
    mapCanvasPoint(point) {
      if (
        point.x < x ||
        point.x > x + width ||
        point.y < y ||
        point.y > y + height
      ) {
        return null;
      }

      return {
        x: (point.x - x) / scale,
        y: (point.y - y) / scale,
      };
    },
    mapRect(rect) {
      return {
        height: rect.height * scale,
        width: rect.width * scale,
        x: x + rect.x * scale,
        y: y + rect.y * scale,
      };
    },
    mediaRect: { height, width, x, y },
    scale,
  };
}

export function pickReactNativeDetectionAtPoint(
  frame: DetectionFrame,
  layout: ReactNativeFrameLayout,
  canvasPoint: ReactNativePoint,
  options: DetectionPickOptions = {},
): DetectionPickResult | null {
  const mediaPoint = layout.mapCanvasPoint(canvasPoint);

  if (!mediaPoint) {
    return null;
  }

  return pickDetectionAtPoint(frame, mediaPoint, options);
}

export function resolveReactNativeLabelLayout(
  options: ReactNativeLabelLayoutOptions,
): ReactNativeLabelLayout {
  const { instruction, layout, textSize } = options;
  const anchor = layout.mapRect(instruction.rect);
  const background = instruction.background;
  const paddingX = background?.paddingX ?? 0;
  const paddingY = background?.paddingY ?? 0;
  const width = textSize.width + paddingX * 2;
  const height = textSize.height + paddingY * 2;
  const offsetX = (instruction.offsetX ?? 0) * layout.scale;
  const offsetY = (instruction.offsetY ?? 0) * layout.scale;
  const position = resolveReactNativeLabelPosition({
    anchor,
    height,
    layout,
    offsetX,
    offsetY,
    placement: instruction.placement,
    width,
  });

  return {
    backgroundRect: {
      height,
      width,
      x: position.x,
      y: position.y,
    },
    cornerRadius: background?.cornerRadius ?? 0,
    textPoint: {
      x: position.x + paddingX,
      y: position.y + paddingY,
    },
  };
}

export function createReactNativeIdMaskFrame(
  options: ReactNativeIdMaskFrameOptions,
): ReactNativeIdMaskFrame | undefined {
  const { detectionFrame, maskStyle } = options;
  const mediaTime = options.mediaTime ?? detectionFrame.mediaTime;
  const instructions: IdMaskInstruction[] = [];

  detectionFrame.detections.forEach((detection, detectionIndex) => {
    const instruction = maskStyle.resolve(detection, {
      detectionIndex,
      frame: detectionFrame,
      mediaTime,
    });

    if (instruction) {
      instructions.push({
        ...instruction,
        detectionIndex,
      });
    }
  });

  const frame = createIdMaskFrame(instructions);

  if (!frame) {
    return undefined;
  }

  return {
    ...frame,
    maskCount: instructions.length,
    opacity: maskStyle.opacity ?? 1,
  };
}

export function createReactNativePreparedFramePacket<THandle = unknown>(
  options: ReactNativeFramePresentationOptions<THandle> &
    ReactNativeFramePresentationStyleOptions,
): ReactNativePreparedFramePacket<THandle> {
  const presentation = resolveReactNativeFramePresentation(options);

  return {
    maskArtifact: options.maskStyle
      ? createReactNativeIdMaskFrame({
          detectionFrame: options.detectionFrame,
          maskStyle: options.maskStyle,
        })
      : undefined,
    presentation,
  };
}

export function resolveReactNativeIdMaskUniforms(
  options: ReactNativeIdMaskUniformOptions,
): ReactNativeIdMaskUniforms {
  const { artifact, layout } = options;
  const edgeSmoothing =
    options.edgeSmoothing ?? DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING;

  return {
    uBorderEnabled: artifact.hasStroke ? 1 : 0,
    uEdgeSmoothing: Math.max(0, Math.min(edgeSmoothing, 1)),
    uFeatherTexels: 1,
    uFillPalette: Array.from(artifact.fillPalette),
    uMaxStrokeWidth: Math.min(
      artifact.maxStrokeWidth,
      MAX_ID_MASK_STROKE_WIDTH,
    ),
    uMediaRect: [
      layout.mediaRect.x,
      layout.mediaRect.y,
      layout.mediaRect.width,
      layout.mediaRect.height,
    ],
    uOpacity: artifact.opacity,
    uStrokePalette: Array.from(artifact.strokePalette),
    uStrokeWidths: Array.from(artifact.strokeWidths),
    uTextureSize: [artifact.width, artifact.height],
  };
}

export function resolveReactNativeLiveColorForClass(
  className: string | undefined,
  fallbackIndex = 0,
) {
  const fallback =
    REACT_NATIVE_ROBOFLOW_PALETTE[
      Math.abs(fallbackIndex) % REACT_NATIVE_ROBOFLOW_PALETTE.length
    ] ?? REACT_NATIVE_ROBOFLOW_PALETTE[0];
  const normalized = (className ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (normalized) {
    case "horse":
      return 0x38bdf8;
    case "person":
    case "keyboard":
      return 0x22c55e;
    case "cow":
    case "tv":
      return 0xa78bfa;
    case "basketball":
    case "bottle":
    case "sports_ball":
      return 0xf97316;
    case "yellow_team_player":
    case "cup":
    case "mouse":
      return 0xfacc15;
    case "white_team_player":
      return 0xf8fafc;
    case "bed":
      return 0xf472b6;
    case "laptop":
      return 0x60a5fa;
    case "knife":
      return 0xfb7185;
    case "cell_phone":
    case "potted_plant":
      return 0x34d399;
    default:
      return fallback;
  }
}

export function resolveReactNativeLiveIdMaskArtifactSize(
  options: ReactNativeLiveIdMaskArtifactSizeOptions,
) {
  "worklet";

  const frameWidth = Math.max(1, Math.round(options.frameWidth));
  const frameHeight = Math.max(1, Math.round(options.frameHeight));
  const framePixels = frameWidth * frameHeight;
  const areaScale =
    framePixels > options.maxPixels
      ? Math.sqrt(options.maxPixels / framePixels)
      : 1;
  const sideScale = Math.min(
    1,
    options.maxSide / frameWidth,
    options.maxSide / frameHeight,
  );
  const scale = Math.min(areaScale, sideScale);

  return {
    height: Math.max(1, Math.round(frameHeight * scale)),
    scale,
    width: Math.max(1, Math.round(frameWidth * scale)),
  };
}

// The worklets Babel plugin turns "worklet"-marked function declarations into
// non-hoisted variable assignments whose closures capture other module-level
// worklets by value at module-init time. Every worklet below must therefore be
// defined before any worklet that captures it, or the captured value is
// undefined on the worklet runtime.
function fillReactNativeLiveMask(options: {
  readonly data: Uint8Array;
  readonly detection: ReactNativeLiveSerializedDetection;
  readonly maskId: number;
  readonly targetHeight: number;
  readonly targetWidth: number;
  readonly targetX0: number;
  readonly targetY0: number;
  readonly width: number;
}) {
  "worklet";

  const {
    data,
    detection,
    maskId,
    targetHeight,
    targetWidth,
    targetX0,
    targetY0,
    width,
  } = options;
  const { mask, maskHeight, maskWidth } = detection;
  const sourceXStep = maskWidth / targetWidth;
  const sourceYStep = maskHeight / targetHeight;

  // Nearest sampling on purpose: the artifact draws exactly the mask shape
  // the model produced. Ask the detection producer for higher-resolution
  // masks when smoother boundaries are needed.
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(maskHeight - 1, Math.floor(y * sourceYStep));
    const sourceRowOffset = sourceY * maskWidth;
    const targetRowOffset = (targetY0 + y) * width + targetX0;

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(maskWidth - 1, Math.floor(x * sourceXStep));

      if (mask[sourceRowOffset + sourceX]) {
        data[targetRowOffset + x] = maskId;
      }
    }
  }
}

function writeReactNativeLivePaletteEntry(
  palette: Float32Array,
  offset: number,
  color: number,
  alpha: number,
) {
  "worklet";

  palette[offset] = ((color >> 16) & 0xff) / 255;
  palette[offset + 1] = ((color >> 8) & 0xff) / 255;
  palette[offset + 2] = (color & 0xff) / 255;
  palette[offset + 3] = Math.max(0, Math.min(alpha, 1));
}

export function createReactNativeLiveIdMaskArtifact(
  options: ReactNativeLiveIdMaskArtifactOptions,
): ReactNativeLiveIdMaskArtifact | undefined {
  "worklet";

  const detectionLimit = MAX_ID_MASK_PALETTE_ENTRIES - 1;
  const detectionCount = Math.min(options.detections.length, detectionLimit);

  if (detectionCount <= 0) {
    return undefined;
  }

  const { height, scale, width } =
    resolveReactNativeLiveIdMaskArtifactSize(options);
  const data = new Uint8Array(new ArrayBuffer(width * height));
  const fillPalette = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4 * 4),
  );
  const strokePalette = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4 * 4),
  );
  const strokeWidths = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4),
  );
  const strokeWidth = Math.min(
    Math.max(0, options.borderWidth ?? 0),
    MAX_ID_MASK_STROKE_WIDTH,
  );
  let maskCount = 0;
  let maxCellTexels = 0;

  for (let index = 0; index < detectionCount; index += 1) {
    const detection = options.detections[index]!;

    if (detection.mask.length !== detection.maskWidth * detection.maskHeight) {
      continue;
    }

    const maskId = index + 1;
    const paletteOffset = maskId * 4;

    writeReactNativeLivePaletteEntry(
      fillPalette,
      paletteOffset,
      detection.color,
      1,
    );
    writeReactNativeLivePaletteEntry(
      strokePalette,
      paletteOffset,
      detection.color,
      strokeWidth > 0 ? 0.95 : 0,
    );
    strokeWidths[maskId] = strokeWidth;

    const targetX0 = Math.max(0, Math.floor(detection.bbox.x1 * scale));
    const targetY0 = Math.max(0, Math.floor(detection.bbox.y1 * scale));
    const targetX1 = Math.min(width, Math.ceil(detection.bbox.x2 * scale));
    const targetY1 = Math.min(height, Math.ceil(detection.bbox.y2 * scale));
    const targetWidth = targetX1 - targetX0;
    const targetHeight = targetY1 - targetY0;

    if (targetWidth <= 0 || targetHeight <= 0) {
      continue;
    }

    maskCount += 1;

    if (detection.maskWidth > 0 && detection.maskHeight > 0) {
      maxCellTexels = Math.max(
        maxCellTexels,
        targetWidth / detection.maskWidth,
        targetHeight / detection.maskHeight,
      );
    }

    fillReactNativeLiveMask({
      data,
      detection,
      maskId,
      targetHeight,
      targetWidth,
      targetX0,
      targetY0,
      width,
    });
  }

  if (maskCount === 0) {
    return undefined;
  }

  return {
    data,
    edgeFeatherTexels: Math.min(12, Math.max(1, maxCellTexels / 2)),
    fillPalette,
    hasStroke: strokeWidth > 0,
    height,
    maskCount,
    maxStrokeWidth: strokeWidth,
    opacity: options.fillOpacity ?? 1,
    scale,
    strokePalette,
    strokeWidths,
    width,
  };
}

function resolveReactNativeLiveIdMaskErrorMessage(error: unknown) {
  "worklet";

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as { readonly message?: unknown };

    if (typeof record.message === "string") {
      return record.message;
    }
  }

  return "native-id-mask-builder-error";
}

/**
 * Builds one live ID-mask artifact with the native builder when available and
 * falls back to the JS builder otherwise. Both paths produce byte-identical
 * artifacts; diagnostics report which builder ran and why a fallback happened.
 *
 * Safe to call from a VisionCamera/worklet lane as long as the native builder
 * handle produced by `loadReactNativeLiveIdMaskNativeBuilder()` is captured
 * from the React side and passed through `options.nativeBuilder`.
 */
export function createReactNativeLiveIdMaskArtifactAuto(
  options: ReactNativeLiveIdMaskArtifactAutoOptions,
): ReactNativeLiveIdMaskBuildResult | undefined {
  "worklet";

  const nativeBuilder = options.nativeBuilder ?? null;
  let fallbackReason = "native-id-mask-builder-not-loaded";

  if (nativeBuilder) {
    if (isReactNativeLiveIdMaskNativeBuilderAvailable(nativeBuilder)) {
      const nativeStartedAt = Date.now();

      try {
        const artifact = createReactNativeLiveIdMaskArtifactWithNativeBuilder(
          nativeBuilder,
          options,
        );

        if (!artifact) {
          return undefined;
        }

        return {
          artifact,
          diagnostics: {
            builder: "native",
            // Prefer the native-core loop time; the surrounding App-level
            // prep metric already captures JSI and upload overhead.
            fillMs: artifact.nativeFillMs ?? Date.now() - nativeStartedAt,
          },
        };
      } catch (error) {
        fallbackReason = resolveReactNativeLiveIdMaskErrorMessage(error);
      }
    } else {
      fallbackReason =
        nativeBuilder.fallbackReason ?? "native-id-mask-builder-unavailable";
    }
  }

  const jsStartedAt = Date.now();
  const artifact = createReactNativeLiveIdMaskArtifact(options);

  if (!artifact) {
    return undefined;
  }

  return {
    artifact,
    diagnostics: {
      builder: "js",
      fillMs: Date.now() - jsStartedAt,
      fallbackReason,
    },
  };
}

/**
 * Live variant of `resolveReactNativeIdMaskUniforms()` for worklet lanes where
 * only the media rect is available instead of a full frame layout.
 */
export function resolveReactNativeLiveIdMaskUniforms(
  options: ReactNativeLiveIdMaskUniformOptions,
): ReactNativeIdMaskUniforms {
  "worklet";

  const { artifact, mediaRect } = options;
  const edgeSmoothing =
    options.edgeSmoothing ?? DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING;

  return {
    uBorderEnabled: artifact.hasStroke ? 1 : 0,
    uEdgeSmoothing: Math.max(0, Math.min(edgeSmoothing, 1)),
    // Defensive default: an out-of-date native binary can return artifacts
    // without this field, and Skia hard-errors on any missing uniform.
    uFeatherTexels: artifact.edgeFeatherTexels ?? 1,
    uFillPalette: Array.from(artifact.fillPalette),
    uMaxStrokeWidth: Math.min(
      artifact.maxStrokeWidth,
      MAX_ID_MASK_STROKE_WIDTH,
    ),
    uMediaRect: [mediaRect.x, mediaRect.y, mediaRect.width, mediaRect.height],
    uOpacity: artifact.opacity,
    uStrokePalette: Array.from(artifact.strokePalette),
    uStrokeWidths: Array.from(artifact.strokeWidths),
    uTextureSize: [artifact.width, artifact.height],
  };
}

function createShaderArrayLookup(options: {
  readonly fallback: string;
  readonly functionName: string;
  readonly paletteName: string;
  readonly returnType: string;
}) {
  const branches = Array.from(
    { length: MAX_ID_MASK_PALETTE_ENTRIES - 1 },
    (_, index) => {
      const id = index + 1;

      return `  if (maskId == ${id}) { return ${options.paletteName}[${id}]; }`;
    },
  ).join("\n");

  return `${options.returnType} ${options.functionName}(int maskId) {
${branches}
  return ${options.fallback};
}`;
}

export function resolveReactNativeFramePresentation<THandle = unknown>(
  options: ReactNativeFramePresentationOptions<THandle> &
    ReactNativeFramePresentationStyleOptions,
): ReactNativeFramePresentation<THandle> {
  const { boxStyle, detectionFrame, labelStyle, maskStyle, mediaFrame } =
    options;
  const boxes: BoxDrawInstruction[] = [];
  const labels: LabelDrawInstruction[] = [];
  const masks: MaskDrawInstruction[] = [];

  detectionFrame.detections.forEach((detection, detectionIndex) => {
    const baseContext = {
      detectionIndex,
      frame: detectionFrame,
      mediaTime: detectionFrame.mediaTime,
    };
    const box = boxStyle?.resolve(detection, baseContext);
    const label = labelStyle?.resolve(detection, baseContext);
    const mask = maskStyle?.resolve(detection, baseContext);

    if (box) {
      boxes.push(box);
    }

    if (label) {
      labels.push(label);
    }

    if (mask) {
      masks.push(mask);
    }
  });

  return {
    boxes,
    labels,
    maskOpacity: maskStyle?.opacity ?? null,
    masks,
    mediaFrame,
    mediaMetadata: mediaFrame.metadata,
  };
}

function resolveReactNativeLabelPosition(options: {
  readonly anchor: Rect;
  readonly height: number;
  readonly layout: ReactNativeFrameLayout;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly placement?: LabelPlacement;
  readonly width: number;
}) {
  const { anchor, height, layout, offsetX, offsetY, placement, width } =
    options;

  switch (placement ?? LabelPlacement.Top) {
    case LabelPlacement.Bottom:
      return {
        x: anchor.x + offsetX,
        y: anchor.y + anchor.height + offsetY,
      };
    case LabelPlacement.Center:
      return {
        x: anchor.x + anchor.width / 2 - width / 2 + offsetX,
        y: anchor.y + anchor.height / 2 - height / 2 + offsetY,
      };
    case LabelPlacement.InsideBottom:
      return {
        x: anchor.x + offsetX,
        y: Math.max(
          layout.mediaRect.y,
          anchor.y + anchor.height - height - offsetY,
        ),
      };
    case LabelPlacement.InsideTop:
      return {
        x: anchor.x + offsetX,
        y: anchor.y + offsetY,
      };
    case LabelPlacement.Top:
      return {
        x: anchor.x + offsetX,
        y: Math.max(layout.mediaRect.y, anchor.y - height - offsetY),
      };
  }
}
