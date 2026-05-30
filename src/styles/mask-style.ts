import type { Detection } from "#types/detections";
import type {
  MaskDrawInstruction,
  MaskStrokeStyle,
  MaskStyle,
} from "#types/mask-style";

export interface BaseMaskStyleOptions {
  readonly color?: number;
  readonly alpha?: number;
  readonly stroke?: MaskStrokeStyle;
}

export class BaseMaskStyle implements MaskStyle {
  readonly artifactKey: string;
  readonly opacity: number;

  private readonly color: number;
  private readonly stroke: MaskStrokeStyle | undefined;

  constructor(options: BaseMaskStyleOptions = {}) {
    this.color = options.color ?? 0x00ff66;
    this.opacity = clampOpacity(options.alpha ?? 0.35);
    this.stroke = options.stroke;
    this.artifactKey = `base:${this.color}:${serializeStroke(this.stroke)}`;
  }

  resolve(detection: Detection): MaskDrawInstruction | undefined {
    if (!detection.mask) {
      return undefined;
    }

    return {
      alpha: 1,
      color: this.color,
      mask: detection.mask,
      stroke: this.stroke,
    };
  }
}

function clampOpacity(opacity: number) {
  return Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 1;
}

function serializeStroke(stroke: MaskStrokeStyle | undefined) {
  if (!stroke) {
    return "none";
  }

  return `${stroke.color}:${stroke.alpha}:${stroke.width}`;
}
