import {
  DEFAULT_BOX_STROKE_ALPHA,
  DEFAULT_BOX_STROKE_COLOR,
  DEFAULT_BOX_STROKE_WIDTH,
} from "#constants/media-renderer";
import type { Detection } from "#types/detections";
import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxFillStyle,
  type BoxStrokeStyle,
  type BoxStyle,
} from "#types/box-style";

export interface BaseBoxStyleOptions {
  readonly stroke?: Partial<BoxStrokeStyle> | null;
  readonly fill?: Partial<BoxFillStyle> | null;
}

export class BaseBoxStyle implements BoxStyle {
  protected readonly stroke: BoxStrokeStyle | undefined;
  protected readonly fill: BoxFillStyle | undefined;

  constructor(options: BaseBoxStyleOptions = {}) {
    this.stroke =
      options.stroke === null
        ? undefined
        : {
            alpha: options.stroke?.alpha ?? DEFAULT_BOX_STROKE_ALPHA,
            color: options.stroke?.color ?? DEFAULT_BOX_STROKE_COLOR,
            width: options.stroke?.width ?? DEFAULT_BOX_STROKE_WIDTH,
          };
    this.fill =
      options.fill === null || options.fill === undefined
        ? undefined
        : {
            alpha: options.fill.alpha ?? 1,
            color: options.fill.color ?? DEFAULT_BOX_STROKE_COLOR,
          };
  }

  resolve(detection: Detection): BoxDrawInstruction | undefined {
    if (!detection.rect) {
      return undefined;
    }

    return {
      fill: this.fill,
      rect: detection.rect,
      shape: BoxShape.Rect,
      stroke: this.stroke,
    };
  }
}

export interface RoundedBoxStyleOptions extends BaseBoxStyleOptions {
  readonly cornerRadius?: number;
}

export class RoundedBoxStyle extends BaseBoxStyle {
  private readonly cornerRadius: number;

  constructor(options: RoundedBoxStyleOptions = {}) {
    super(options);
    this.cornerRadius = options.cornerRadius ?? 6;
  }

  override resolve(detection: Detection): BoxDrawInstruction | undefined {
    const instruction = super.resolve(detection);

    if (!instruction) {
      return undefined;
    }

    return {
      ...instruction,
      cornerRadius: this.cornerRadius,
      shape: BoxShape.RoundedRect,
    };
  }
}
