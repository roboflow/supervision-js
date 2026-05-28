import type { Detection } from "#types/detections";
import type { MaskDrawInstruction, MaskStyle } from "#types/mask-style";

export interface BaseMaskStyleOptions {
  readonly color?: number;
  readonly alpha?: number;
}

export class BaseMaskStyle implements MaskStyle {
  private readonly color: number;
  private readonly alpha: number;

  constructor(options: BaseMaskStyleOptions = {}) {
    this.color = options.color ?? 0x00ff66;
    this.alpha = options.alpha ?? 0.35;
  }

  resolve(detection: Detection): MaskDrawInstruction | undefined {
    if (!detection.mask) {
      return undefined;
    }

    return {
      alpha: this.alpha,
      color: this.color,
      mask: detection.mask,
    };
  }
}
