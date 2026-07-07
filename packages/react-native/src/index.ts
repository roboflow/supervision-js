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
  float edgeSmoothing = clamp(uEdgeSmoothing, 0.0, 1.0);

  if (id <= 0.0) {
    if (edgeSmoothing > 0.0) {
      float neighborId = resolveNeighborMaskId(coord, texel);

      if (neighborId > 0.0) {
        int neighborMaskId = int(neighborId);
        half4 neighborColor = resolveFillColor(neighborMaskId);
        half featherAlpha =
          neighborColor.a * half(uOpacity) * half(0.16 * edgeSmoothing);

        return half4(neighborColor.rgb * featherAlpha, featherAlpha);
      }
    }

    return half4(0.0);
  }

  int maskId = int(id);
  half4 fillColor = resolveFillColor(maskId);
  half outputAlpha = fillColor.a * half(uOpacity);

  if (edgeSmoothing > 0.0) {
    float sameNeighborRatio = resolveSameNeighborRatio(coord, texel, id);
    half edgeAlphaMultiplier = half(mix(
      1.0,
      0.58 + sameNeighborRatio * 0.42,
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
  readonly uFillPalette: readonly number[];
  readonly uMaxStrokeWidth: number;
  readonly uMediaRect: readonly number[];
  readonly uOpacity: number;
  readonly uStrokePalette: readonly number[];
  readonly uStrokeWidths: readonly number[];
  readonly uTextureSize: readonly number[];
}

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

export function resolveReactNativeIdMaskUniforms(
  options: ReactNativeIdMaskUniformOptions,
): ReactNativeIdMaskUniforms {
  const { artifact, layout } = options;
  const edgeSmoothing =
    options.edgeSmoothing ?? DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING;

  return {
    uBorderEnabled: artifact.hasStroke ? 1 : 0,
    uEdgeSmoothing: Math.max(0, Math.min(edgeSmoothing, 1)),
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
