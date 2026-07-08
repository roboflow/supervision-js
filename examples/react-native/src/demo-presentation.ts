import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  LabelPlacement,
  MaskRenderMode,
  type Detection,
  type DetectionFrame,
} from "supervision-js-core";

export const DEMO_MASK_BORDER_WIDTH = 0;
export const DEMO_MASK_FILL_OPACITY = 0.5;
const DEMO_ROBOFLOW_PALETTE = [
  0x38bdf8, 0x22c55e, 0xa78bfa, 0xfacc15, 0xf97316, 0xf472b6, 0x60a5fa,
  0xfb7185, 0x34d399, 0xe879f9,
] as const;

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
    stroke: (detection, context) => ({
      alpha: 0.98,
      color: resolveDemoDetectionColor(detection, context.detectionIndex),
      width: 3,
    }),
  });
}

export function createDemoMaskStyle() {
  return new BaseMaskStyle({
    color: (detection, context) =>
      resolveDemoDetectionColor(detection, context.detectionIndex),
    mode: MaskRenderMode.FillOnly,
    opacity: DEMO_MASK_FILL_OPACITY,
  });
}

export function createDemoLabelStyle() {
  return new BaseLabelStyle({
    background: (detection, context) => ({
      alpha: 0.84,
      color: resolveDemoDetectionColor(detection, context.detectionIndex),
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
      const color = detection.color ?? resolveDemoClassColor(className, index);

      return {
        className,
        confidence: detection.score,
        id: `live:${index}`,
        metadata: { color },
        rect: {
          height: detection.bbox.y2 - detection.bbox.y1,
          width: detection.bbox.x2 - detection.bbox.x1,
          x: detection.bbox.x1,
          y: detection.bbox.y1,
        },
      };
    }),
    frameIndex: options.frameIndex,
    mediaTime: options.mediaTime ?? 0,
  };
}

export function resolveDemoClassColor(
  className: string | undefined,
  fallbackIndex = 0,
) {
  "worklet";

  const fallback =
    DEMO_ROBOFLOW_PALETTE[
      Math.abs(fallbackIndex) % DEMO_ROBOFLOW_PALETTE.length
    ] ?? DEMO_ROBOFLOW_PALETTE[0];
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

export function resolveDemoDetectionColor(
  detection: Detection,
  fallbackIndex = 0,
) {
  "worklet";

  const metadataColor = detection.metadata?.color;

  if (typeof metadataColor === "number") {
    return metadataColor;
  }

  return resolveDemoClassColor(detection.className, fallbackIndex);
}
