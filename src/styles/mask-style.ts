import type { Detection } from "#types/detections";
import type { MaskDrawInstruction, MaskStyle } from "#types/mask-style";

export interface BaseMaskStyleOptions {
  readonly color?: number;
  readonly alpha?: number;
}

export class BaseMaskStyle implements MaskStyle {
  readonly artifactKey: string;
  readonly opacity: number;

  private readonly color: number;

  constructor(options: BaseMaskStyleOptions = {}) {
    this.color = options.color ?? 0x00ff66;
    this.opacity = clampOpacity(options.alpha ?? 0.35);
    this.artifactKey = `base:${this.color}`;
  }

  resolve(detection: Detection): MaskDrawInstruction | undefined {
    if (!detection.mask) {
      return undefined;
    }

    return {
      alpha: 1,
      color: this.color,
      mask: detection.mask,
    };
  }
}

function clampOpacity(opacity: number) {
  return Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 1;
}
