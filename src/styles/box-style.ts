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
   * Box geometry. Pass a resolver for per-class or per-state shape changes.
   */
  readonly shape?: DetectionStyleValue<BoxShape, BoxStyleContext>;
  /**
   * Rounded rectangle corner radius in media pixels.
   */
  readonly cornerRadius?: DetectionStyleValue<
    number | undefined,
    BoxStyleContext
  >;
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
 * Default configurable box style.
 *
 * This is the simplest `supervision-js` equivalent of a box annotator: it
 * converts detections with `rect` geometry into renderer-neutral box draw
 * instructions. Use options such as `shape`, `cornerRadius`, `stroke`, and
 * `fill` for static or per-detection styling.
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

    const shape = this.resolveShape(detection, context);
    const cornerRadius = this.resolveCornerRadius(detection, context, shape);
    const instruction: BoxDrawInstruction = {
      fill: this.resolveFill(detection, context),
      rect: detection.rect,
      shape,
      stroke: this.resolveStroke(detection, context),
    };

    if (cornerRadius !== undefined) {
      return {
        ...instruction,
        cornerRadius,
      };
    }

    return instruction;
  }

  protected resolveShape(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxShape {
    return (
      resolveStyleValue(this.options.shape, detection, context) ?? BoxShape.Rect
    );
  }

  protected resolveCornerRadius(
    detection: Detection,
    context: BoxStyleContext,
    shape: BoxShape,
  ): number | undefined {
    if (shape !== BoxShape.RoundedRect) {
      return undefined;
    }

    return resolveStyleValue(this.options.cornerRadius, detection, context);
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
