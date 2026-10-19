import { resolveStrokeStyle } from "#styles/stroke-style";
import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import type { FillStyle, StrokeStyle } from "#types/paint-style";
import {
  PercentageBarPlacement,
  type BasePercentageBarStyleOptions,
  type PercentageBarDrawInstruction,
  type PercentageBarStyle,
  type PercentageBarStyleContext,
} from "#types/percentage-bar-style";
export { PercentageBarPlacement };
import { resolveDetectionClassColorStyle } from "#utils/color-palette";
import { getDetectionRect } from "#utils/geometry";

const DEFAULT_BAR_HEIGHT = 8;
const DEFAULT_BACKGROUND_FILL: FillStyle = { alpha: 0.75, color: 0x0f172a };
const DEFAULT_PROGRESS_ALPHA = 1;

/**
 * Configurable percentage bar style anchored to detection rectangles.
 *
 * Converts a detection's confidence or custom numeric metric into a
 * proportional progress bar positioned relative to the detection bounding box.
 */
export class BasePercentageBarStyle implements PercentageBarStyle {
  protected readonly options: BasePercentageBarStyleOptions;

  constructor(options: BasePercentageBarStyleOptions = {}) {
    this.options = options;
  }

  resolve(
    detection: Detection,
    context: PercentageBarStyleContext,
  ): PercentageBarDrawInstruction | undefined {
    if (
      context.hidden ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const rect = getDetectionRect(detection);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return undefined;
    }

    const rawValue =
      resolveStyleValue(this.options.value, detection, context) ??
      detection.confidence ??
      0;
    const value = Math.min(
      1,
      Math.max(0, Number.isFinite(rawValue) ? rawValue : 0),
    );

    const height =
      resolveStyleValue(this.options.height, detection, context) ??
      DEFAULT_BAR_HEIGHT;
    if (!Number.isFinite(height) || height <= 0) {
      return undefined;
    }

    const resolvedWidth = resolveStyleValue(
      this.options.width,
      detection,
      context,
    );
    const width =
      resolvedWidth !== undefined &&
      Number.isFinite(resolvedWidth) &&
      resolvedWidth > 0
        ? resolvedWidth
        : rect.width;

    const placement =
      resolveStyleValue(this.options.placement, detection, context) ??
      PercentageBarPlacement.Top;

    const offset = resolveStyleValue(this.options.offset, detection, context);
    const offsetX = offset?.x ?? 0;
    const offsetY = (offset?.y ?? 0) + (this.options.offsetY ?? 0);

    const rectTop = rect.y - rect.height / 2;
    const rectBottom = rect.y + rect.height / 2;

    const barLeft = rect.x - width / 2 + offsetX;
    let barTop: number;

    switch (placement) {
      case PercentageBarPlacement.Bottom:
        barTop = rectBottom + offsetY;
        break;
      case PercentageBarPlacement.InsideTop:
        barTop = rectTop + offsetY;
        break;
      case PercentageBarPlacement.InsideBottom:
        barTop = rectBottom - height + offsetY;
        break;
      case PercentageBarPlacement.Top:
      default:
        barTop = rectTop - height + offsetY;
        break;
    }

    const backgroundRect = {
      height,
      width,
      x: barLeft + width / 2,
      y: barTop + height / 2,
    };

    const valueWidth = width * value;
    const valueRect = {
      height,
      width: valueWidth,
      x: barLeft + valueWidth / 2,
      y: barTop + height / 2,
    };

    const background = this.resolveBackground(detection, context);
    const fill = this.resolveFill(detection, context);
    const border = this.resolveBorder(detection, context);

    if (!background && !fill && !border) {
      return undefined;
    }

    return {
      ...(background ? { background } : {}),
      ...(border ? { border } : {}),
      ...(fill ? { fill } : {}),
      backgroundRect,
      value,
      valueRect,
    };
  }

  protected resolveBackground(
    detection: Detection,
    context: PercentageBarStyleContext,
  ): FillStyle | undefined {
    const background = resolveStyleValue(
      this.options.background,
      detection,
      context,
    );
    if (background === null) {
      return undefined;
    }

    return {
      alpha: background?.alpha ?? DEFAULT_BACKGROUND_FILL.alpha,
      color: background?.color ?? DEFAULT_BACKGROUND_FILL.color,
    };
  }

  protected resolveFill(
    detection: Detection,
    context: PercentageBarStyleContext,
  ): FillStyle | undefined {
    const fill = resolveStyleValue(this.options.fill, detection, context);
    if (fill === null) {
      return undefined;
    }

    if (fill) {
      return {
        alpha: fill.alpha ?? DEFAULT_PROGRESS_ALPHA,
        color:
          fill.color ??
          resolveDetectionClassColorStyle(detection.className).stroke,
      };
    }

    const classColor = resolveDetectionClassColorStyle(detection.className);
    return {
      alpha: DEFAULT_PROGRESS_ALPHA,
      color: classColor.stroke,
    };
  }

  protected resolveBorder(
    detection: Detection,
    context: PercentageBarStyleContext,
  ): StrokeStyle | undefined {
    const border = resolveStyleValue(this.options.border, detection, context);
    if (!border) {
      return undefined;
    }

    return resolveStrokeStyle(border, {
      alpha: 1,
      color: 0xffffff,
      width: 1,
    });
  }
}
