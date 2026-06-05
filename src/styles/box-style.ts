import {
  DEFAULT_BOX_STROKE_ALPHA,
  DEFAULT_BOX_STROKE_COLOR,
  DEFAULT_BOX_STROKE_WIDTH,
} from "#constants/media-renderer";
import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxFillStyle,
  type BoxStrokeStyle,
  type BoxStyle,
  type BoxStyleContext,
} from "#types/box-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export interface BaseBoxStyleOptions {
  /**
   * Box stroke. Pass `null` to disable strokes, or a resolver for per-detection
   * stroke styling.
   */
  readonly stroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    BoxStyleContext
  >;
  /**
   * Optional box fill. Pass a resolver for per-class or confidence-aware fills.
   */
  readonly fill?: DetectionStyleValue<
    Partial<BoxFillStyle> | null,
    BoxStyleContext
  >;
  /**
   * Return false to skip rendering a detection in this box style.
   */
  readonly shouldRender?: DetectionStylePredicate<BoxStyleContext>;
}

/**
 * Default rectangular box style.
 *
 * This is the simplest `supervision-js` equivalent of a box annotator: it
 * converts detections with `rect` geometry into renderer-neutral box draw
 * instructions.
 */
export class BaseBoxStyle implements BoxStyle {
  protected readonly options: BaseBoxStyleOptions;

  constructor(options: BaseBoxStyleOptions = {}) {
    this.options = options;
  }

  resolve(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxDrawInstruction | undefined {
    if (
      !detection.rect ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    return {
      fill: this.resolveFill(detection, context),
      rect: detection.rect,
      shape: BoxShape.Rect,
      stroke: this.resolveStroke(detection, context),
    };
  }

  protected resolveStroke(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxStrokeStyle | undefined {
    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    if (stroke === null) {
      return undefined;
    }

    return {
      alpha: stroke?.alpha ?? DEFAULT_BOX_STROKE_ALPHA,
      color: stroke?.color ?? DEFAULT_BOX_STROKE_COLOR,
      width: stroke?.width ?? DEFAULT_BOX_STROKE_WIDTH,
    };
  }

  protected resolveFill(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxFillStyle | undefined {
    const fill = resolveStyleValue(this.options.fill, detection, context);

    if (fill === null || fill === undefined) {
      return undefined;
    }

    return {
      alpha: fill.alpha ?? 1,
      color: fill.color ?? DEFAULT_BOX_STROKE_COLOR,
    };
  }
}

export interface RoundedBoxStyleOptions extends BaseBoxStyleOptions {
  /**
   * Radius in media pixels for rounded box corners.
   */
  readonly cornerRadius?: number;
}

/**
 * Rounded rectangle variant of `BaseBoxStyle`.
 */
export class RoundedBoxStyle extends BaseBoxStyle {
  private readonly cornerRadius: number;

  constructor(options: RoundedBoxStyleOptions = {}) {
    super(options);
    this.cornerRadius = options.cornerRadius ?? 6;
  }

  override resolve(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxDrawInstruction | undefined {
    const instruction = super.resolve(detection, context);

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
