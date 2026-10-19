import { resolveStrokeStyle } from "#styles/stroke-style";
import { resolveStyleValue } from "#styles/style-value";
import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection } from "#types/detections";
import type {
  OrientedBoxDrawInstruction,
  OrientedBoxStyle,
  OrientedBoxStyleContext,
} from "#types/oriented-box-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";
import { polygonArea } from "#utils/geometry";

const DEFAULT_ORIENTED_BOX_STROKE_ALPHA = 1;
const DEFAULT_ORIENTED_BOX_STROKE_COLOR = 0x00ff66;
const DEFAULT_ORIENTED_BOX_STROKE_WIDTH = 2;
const DEFAULT_ORIENTED_BOX_FILL_ALPHA = 0.16;

export interface BaseOrientedBoxStyleOptions {
  /**
   * Optional fill. Pass `null` to disable it, or a resolver for per-class or
   * confidence-aware fills.
   */
  readonly fill?: DetectionStyleValue<
    Partial<BoxFillStyle> | null,
    OrientedBoxStyleContext
  >;
  /**
   * Stroke. Pass `null` to disable strokes, or a resolver for per-detection
   * stroke styling.
   */
  readonly stroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    OrientedBoxStyleContext
  >;
  /** Return false to skip rendering a detection in this style. */
  readonly shouldRender?: DetectionStylePredicate<OrientedBoxStyleContext>;
}

/**
 * Default configurable oriented-box style.
 *
 * Converts detections carrying explicit `orientedBox` quadrilateral geometry
 * into a renderer-neutral closed-path draw instruction, the same fill/stroke
 * shape `BasePolygonStyle` produces. A quadrilateral is skipped, rather than
 * emitted as an invalid or degenerate draw instruction, when it has fewer
 * or more than four vertices, a non-finite (NaN/Infinity) coordinate, or exactly
 * zero area (`polygonArea` already returns 0 for fewer than three points).
 * There is no near-zero/epsilon tolerance; only exact zero area is rejected.
 */
export class BaseOrientedBoxStyle implements OrientedBoxStyle {
  constructor(private readonly options: BaseOrientedBoxStyleOptions = {}) {}

  resolve(
    detection: Detection,
    context: OrientedBoxStyleContext,
  ): OrientedBoxDrawInstruction | undefined {
    const points = detection.orientedBox?.points;

    if (
      !points ||
      points.length !== 4 ||
      points.some(
        (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
      ) ||
      context.hidden ||
      polygonArea(points) === 0 ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const fill = resolveStyleValue(this.options.fill, detection, context);
    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    return {
      points,
      ...(fill === null
        ? {}
        : {
            fill: {
              alpha: fill?.alpha ?? DEFAULT_ORIENTED_BOX_FILL_ALPHA,
              color: fill?.color ?? DEFAULT_ORIENTED_BOX_STROKE_COLOR,
            },
          }),
      ...(stroke === null
        ? {}
        : {
            stroke: resolveStrokeStyle(stroke, {
              alpha: DEFAULT_ORIENTED_BOX_STROKE_ALPHA,
              color: DEFAULT_ORIENTED_BOX_STROKE_COLOR,
              width: DEFAULT_ORIENTED_BOX_STROKE_WIDTH,
            }),
          }),
    };
  }
}
