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

    return {
      points: detection.polyline.points,
      stroke: resolveStrokeStyle(stroke, {
        alpha: 1,
        color: 0x00ff66,
        width: 2,
      }),
    };
  }
}
