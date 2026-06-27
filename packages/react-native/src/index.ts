import type {
  BoxDrawInstruction,
  DetectionFrame,
  LabelDrawInstruction,
  MaskDrawInstruction,
  MediaFrameMetadata,
  MediaRendererPresentation,
  PlatformMediaFrame,
} from "supervision-js-core";

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
