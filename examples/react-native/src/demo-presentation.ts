import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  LabelPlacement,
  MaskRenderMode,
  resolveDetectionClassColorStyle,
  type Detection,
  type DetectionFrame,
} from "supervision-js-react-native";

export const DEMO_MASK_BORDER_WIDTH = 0;
export const DEMO_MASK_FILL_OPACITY = 0.5;

export interface DemoLiveDetectionInput {
  readonly bbox: {
    readonly x1: number;
    readonly x2: number;
    readonly y1: number;
    readonly y2: number;
  };
  readonly color?: number;
  readonly label?: string;
  readonly mask?: Uint8Array | readonly number[];
  readonly maskHeight?: number;
  readonly maskWidth?: number;
  readonly score?: number;
}

export interface DemoLiveDetectionFrameOptions {
  readonly detections: readonly DemoLiveDetectionInput[];
  readonly frameIndex?: number;
  readonly mediaTime?: number;
}

export function createDemoBoxStyle(
  options: { readonly rounded?: boolean } = {},
) {
  const rounded = options.rounded ?? true;

  return new BaseBoxStyle({
    cornerRadius: rounded ? 8 : 0,
    fill: null,
    shape: rounded ? BoxShape.RoundedRect : BoxShape.Rect,
    stroke: (detection) => ({
      alpha: 0.98,
      color: resolveDemoDetectionColor(detection),
      width: 3,
    }),
  });
}

export function createDemoMaskStyle() {
  return new BaseMaskStyle({
    color: (detection) => resolveDemoDetectionColor(detection),
    mode: MaskRenderMode.FillOnly,
    opacity: DEMO_MASK_FILL_OPACITY,
  });
}

export function createDemoLabelStyle() {
  return new BaseLabelStyle({
    background: (detection) => ({
      alpha: 0.84,
      color: resolveDemoDetectionColor(detection),
      cornerRadius: 5,
      paddingX: 7,
      paddingY: 3,
    }),
    includeConfidence: true,
    offsetY: 5,
    placement: LabelPlacement.Top,
    textStyle: {
      alpha: 0.96,
      color: 0xffffff,
      fontSize: 13,
      fontWeight: "800",
    },
  });
}

export function createDemoDetectionFrameFromLiveDetections(
  options: DemoLiveDetectionFrameOptions,
): DetectionFrame {
  return {
    detections: options.detections.map((detection, index) => {
      const className = detection.label || "object";
      const color =
        detection.color ?? resolveDetectionClassColorStyle(className).fill;

      return {
        className,
        confidence: detection.score,
        id: `live:${index}`,
        metadata: { color },
        rect: {
          height: detection.bbox.y2 - detection.bbox.y1,
          width: detection.bbox.x2 - detection.bbox.x1,
          x: (detection.bbox.x1 + detection.bbox.x2) / 2,
          y: (detection.bbox.y1 + detection.bbox.y2) / 2,
        },
      };
    }),
    frameIndex: options.frameIndex,
    mediaTime: options.mediaTime ?? 0,
  };
}

export function resolveDemoDetectionColor(detection: Detection) {
  "worklet";

  const metadataColor = detection.metadata?.color;

  if (typeof metadataColor === "number") {
    return metadataColor;
  }

  // Core's own resolver (worklet-marked in core, inert on web): the same
  // function picks this color in a browser session and on the phone.
  return resolveDetectionClassColorStyle(detection.className).fill;
}
