import { resolveStyleValue } from "#styles/style-value";
import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection } from "#types/detections";
import type {
  PolygonDrawInstruction,
  PolygonStyle,
  PolygonStyleContext,
} from "#types/polygon-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export interface BasePolygonStyleOptions {
  readonly fill?: DetectionStyleValue<
    Partial<BoxFillStyle> | null,
    PolygonStyleContext
  >;
  readonly stroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    PolygonStyleContext
  >;
  readonly shouldRender?: DetectionStylePredicate<PolygonStyleContext>;
}

export class BasePolygonStyle implements PolygonStyle {
  constructor(private readonly options: BasePolygonStyleOptions = {}) {}

  resolve(
    detection: Detection,
    context: PolygonStyleContext,
  ): PolygonDrawInstruction | undefined {
    if (
      !detection.polygon ||
      context.hidden ||
      detection.polygon.points.length < 3 ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const fill = resolveStyleValue(this.options.fill, detection, context);
    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    return {
      points: detection.polygon.points,
      ...(fill === null
        ? {}
        : {
            fill: {
              alpha: fill?.alpha ?? 0.16,
              color: fill?.color ?? 0x00ff66,
            },
          }),
      ...(stroke === null
        ? {}
        : {
            stroke: {
              alpha: stroke?.alpha ?? 1,
              color: stroke?.color ?? 0x00ff66,
              width: stroke?.width ?? 2,
              ...(stroke?.alignment === undefined
                ? {}
                : { alignment: stroke.alignment }),
              ...(stroke?.dash === undefined ? {} : { dash: stroke.dash }),
            },
          }),
    };
  }
}
