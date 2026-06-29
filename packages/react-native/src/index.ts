import type {
  BoxDrawInstruction,
  DetectionFrame,
  DetectionPickOptions,
  DetectionPickResult,
  LabelDrawInstruction,
  MaskDrawInstruction,
  MediaFrameMetadata,
  MediaRendererPresentation,
  PlatformMediaFrame,
  Rect,
} from "supervision-js-core";
import { LabelPlacement, pickDetectionAtPoint } from "supervision-js-core";

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
