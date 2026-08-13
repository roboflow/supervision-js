import { resolveStrokeStyle } from "#styles/stroke-style";
import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import { MarkerShape, MarkerSizeSpace } from "#types/shape-style";
import type {
  BaseMarkerStyleOptions,
  MarkerDrawInstruction,
  MarkerStyle,
  MarkerStyleContext,
} from "#types/marker-style";

const DEFAULT_FILL = { alpha: 1, color: 0x00ff66 };
const DEFAULT_STROKE = { alpha: 1, color: 0xffffff, width: 1 };
const DEFAULT_SIZE = 12;

/**
 * Configurable marker renderer style anchored to semantic detection geometry.
 *
 * Use `center` for any domain-specific anchor (keypoint, centroid, or custom
 * metadata). Without it, the marker lands at the detection rectangle center.
 */
export class BaseMarkerStyle implements MarkerStyle {
  protected readonly options: BaseMarkerStyleOptions;

  constructor(options: BaseMarkerStyleOptions = {}) {
    this.options = options;
  }

  resolve(
    detection: Detection,
    context: MarkerStyleContext,
  ): MarkerDrawInstruction | undefined {
    if (
      context.hidden ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const center =
      resolveStyleValue(this.options.center, detection, context) ??
      (detection.rect
        ? { x: detection.rect.x, y: detection.rect.y }
        : undefined);
    const shape =
      resolveStyleValue(this.options.shape, detection, context) ??
      MarkerShape.Circle;
    const size =
      resolveStyleValue(this.options.size, detection, context) ?? DEFAULT_SIZE;
    const sizeSpace =
      resolveStyleValue(this.options.sizeSpace, detection, context) ??
      MarkerSizeSpace.Screen;
    const rotation = resolveStyleValue(
      this.options.rotation,
      detection,
      context,
    );
    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    if (!center || !Number.isFinite(size) || size <= 0) {
      return undefined;
    }

    if (shape === MarkerShape.Cross) {
      if (stroke === null) {
        return undefined;
      }
      const resolvedStroke = resolveStrokeStyle(stroke, DEFAULT_STROKE);
      const openStroke = {
        alpha: resolvedStroke.alpha,
        cap: resolvedStroke.cap,
        color: resolvedStroke.color,
        dash: resolvedStroke.dash,
        join: resolvedStroke.join,
        miterLimit: resolvedStroke.miterLimit,
        width: resolvedStroke.width,
      };
      return {
        center,
        shape,
        size,
        sizeSpace,
        ...(rotation === undefined ? {} : { rotation }),
        stroke: openStroke,
      };
    }

    const fill = resolveStyleValue(this.options.fill, detection, context);
    if (fill === null && stroke === null) {
      return undefined;
    }

    return {
      center,
      shape,
      size,
      sizeSpace,
      ...(rotation === undefined ? {} : { rotation }),
      ...(fill === null
        ? {}
        : {
            fill: {
              alpha: fill?.alpha ?? DEFAULT_FILL.alpha,
              color: fill?.color ?? DEFAULT_FILL.color,
            },
          }),
      ...(stroke === null
        ? {}
        : stroke === undefined
          ? { stroke: DEFAULT_STROKE }
          : { stroke: resolveStrokeStyle(stroke, DEFAULT_STROKE) }),
    };
  }
}
