import { resolveStyleValue } from "#styles/style-value";
import { resolveStrokeStyle } from "#styles/stroke-style";
import type { BoxStrokeStyle } from "#types/box-style";
import type { Detection } from "#types/detections";
import type {
  PolylineDrawInstruction,
  PolylineStyle,
  PolylineStyleContext,
} from "#types/polyline-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export interface BasePolylineStyleOptions {
  readonly stroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    PolylineStyleContext
  >;
  /**
   * Contrast stroke drawn under the path. An absent value draws no shadow; the
   * canonical default polyline style supplies one.
   */
  readonly shadowStroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    PolylineStyleContext
  >;
  readonly shouldRender?: DetectionStylePredicate<PolylineStyleContext>;
}

export class BasePolylineStyle implements PolylineStyle {
  constructor(private readonly options: BasePolylineStyleOptions = {}) {}

  resolve(
    detection: Detection,
    context: PolylineStyleContext,
  ): PolylineDrawInstruction | undefined {
    if (
      !detection.polyline ||
      context.hidden ||
      detection.polyline.points.length < 2 ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    if (stroke === null) {
      return undefined;
    }

    const shadowStroke = resolveStyleValue(
      this.options.shadowStroke,
      detection,
      context,
    );

    return {
      points: detection.polyline.points,
      ...(shadowStroke === undefined || shadowStroke === null
        ? {}
        : {
            shadowStroke: resolveStrokeStyle(shadowStroke, {
              alpha: 0.65,
              color: 0x000000,
              width: 4,
            }),
          }),
      stroke: resolveStrokeStyle(stroke, {
        alpha: 1,
        color: 0x00ff66,
        width: 2,
      }),
    };
  }
}
