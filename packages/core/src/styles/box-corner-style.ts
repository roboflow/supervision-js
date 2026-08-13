import { resolveStrokeStyle } from "#styles/stroke-style";
import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import type {
  BaseBoxCornerStyleOptions,
  BoxCornerDrawInstruction,
  BoxCornerStyle,
  BoxCornerStyleContext,
} from "#types/box-corner-style";

const DEFAULT_CORNER_LENGTH = 20;
const DEFAULT_CORNER_STROKE = {
  alpha: 1,
  cap: "round" as const,
  color: 0x00ff66,
  join: "round" as const,
  width: 2,
};

/**
 * Configurable four-corner decoration derived from a detection rectangle.
 *
 * This is the BoxCornerAnnotator-style facade: it keeps the rectangle semantic
 * and draws only its four open corner segments.
 */
export class BaseBoxCornerStyle implements BoxCornerStyle {
  protected readonly options: BaseBoxCornerStyleOptions;

  constructor(options: BaseBoxCornerStyleOptions = {}) {
    this.options = options;
  }

  resolve(
    detection: Detection,
    context: BoxCornerStyleContext,
  ): BoxCornerDrawInstruction | undefined {
    if (
      !detection.rect ||
      context.hidden ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const resolvedLength =
      resolveStyleValue(this.options.length, detection, context) ??
      DEFAULT_CORNER_LENGTH;
    const viewportScale =
      context.viewportScale && context.viewportScale > 0
        ? context.viewportScale
        : 1;
    const length = Math.min(
      Math.max(0, resolvedLength / viewportScale),
      detection.rect.width / 2,
      detection.rect.height / 2,
    );
    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    if (length <= 0 || stroke === null) return undefined;

    const { height, width, x, y } = detection.rect;
    const left = x - width / 2;
    const right = x + width / 2;
    const top = y - height / 2;
    const bottom = y + height / 2;

    const { alignment: _alignment, ...openStroke } = resolveStrokeStyle(
      stroke,
      DEFAULT_CORNER_STROKE,
    );

    return {
      segments: [
        [
          { x: left + length, y: top },
          { x: left, y: top },
          { x: left, y: top + length },
        ],
        [
          { x: right - length, y: top },
          { x: right, y: top },
          { x: right, y: top + length },
        ],
        [
          { x: left + length, y: bottom },
          { x: left, y: bottom },
          { x: left, y: bottom - length },
        ],
        [
          { x: right - length, y: bottom },
          { x: right, y: bottom },
          { x: right, y: bottom - length },
        ],
      ],
      stroke: openStroke,
    };
  }
}
