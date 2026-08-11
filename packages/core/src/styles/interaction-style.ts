import { resolveStyleValue } from "#styles/style-value";
import { resolveStrokeStyle } from "#styles/stroke-style";
import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxFillStyle,
  type BoxStyle,
  type BoxStrokeStyle,
} from "#types/box-style";
import type { Detection, Rect } from "#types/detections";
import {
  DetectionInteractionState,
  type InteractionPresentation,
  type InteractionStyle,
  type InteractionStyleContext,
} from "#types/interaction-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

const DEFAULT_HOVER_FILL_COLOR = 0x67e8f9;
const DEFAULT_HOVER_FILL_ALPHA = 0.1;
const DEFAULT_HOVER_STROKE_COLOR = 0x67e8f9;
const DEFAULT_HOVER_STROKE_ALPHA = 0.95;
const DEFAULT_HOVER_STROKE_WIDTH = 3;
const DEFAULT_SELECTED_FILL_COLOR = 0xfde047;
const DEFAULT_SELECTED_FILL_ALPHA = 0.18;
const DEFAULT_SELECTED_STROKE_COLOR = 0xfde047;
const DEFAULT_SELECTED_STROKE_ALPHA = 1;
const DEFAULT_SELECTED_STROKE_WIDTH = 4;

export interface BaseInteractionStyleOptions {
  /**
   * Presentation applied to hovered detections. Uses the same style objects as
   * the base renderer presentation.
   */
  readonly hovered?: InteractionPresentation | null;
  /**
   * Presentation applied to selected detections. Uses the same style objects as
   * the base renderer presentation.
   */
  readonly selected?: InteractionPresentation | null;
  /**
   * Highlight geometry. Pass a resolver for per-class or per-state changes.
   *
   * @deprecated Prefer `hovered.boxStyle` and `selected.boxStyle`.
   */
  readonly shape?: DetectionStyleValue<BoxShape, InteractionStyleContext>;
  /**
   * Rounded highlight corner radius in media pixels.
   *
   * @deprecated Prefer `hovered.boxStyle` and `selected.boxStyle`.
   */
  readonly cornerRadius?: DetectionStyleValue<
    number | undefined,
    InteractionStyleContext
  >;
  /**
   * Highlight stroke. Pass `null` to disable strokes, or a resolver for
   * per-state/per-detection styling.
   *
   * @deprecated Prefer `hovered.boxStyle` and `selected.boxStyle`.
   */
  readonly stroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    InteractionStyleContext
  >;
  /**
   * Highlight fill. Pass `null` to disable fills, or a resolver for
   * per-state/per-detection styling.
   *
   * @deprecated Prefer `hovered.boxStyle` and `selected.boxStyle`.
   */
  readonly fill?: DetectionStyleValue<
    Partial<BoxFillStyle> | null,
    InteractionStyleContext
  >;
  /**
   * Return false to skip rendering an interaction highlight.
   */
  readonly shouldRender?: DetectionStylePredicate<InteractionStyleContext>;
}

/**
 * Default configurable interaction style.
 *
 * It resolves hover and selected picks into state-specific presentations using
 * the same style contracts as normal boxes, masks, and labels. The older
 * rectangle options are kept as compatibility sugar and resolve to a box style.
 */
export class BaseInteractionStyle implements InteractionStyle {
  protected readonly options: BaseInteractionStyleOptions;

  constructor(options: BaseInteractionStyleOptions = {}) {
    this.options = options;
  }

  resolve(
    detection: Detection,
    context: InteractionStyleContext,
  ): InteractionPresentation | undefined {
    if (this.options.shouldRender?.(detection, context) === false) {
      return undefined;
    }

    const statePresentation =
      context.state === DetectionInteractionState.Selected
        ? this.options.selected
        : this.options.hovered;

    if (statePresentation !== undefined) {
      return statePresentation ?? undefined;
    }

    const rect = detection.rect;

    if (!rect) {
      return undefined;
    }

    return {
      boxStyle: createResolvedBoxStyle(
        this.resolveBoxInstruction(detection, context, rect),
      ),
    };
  }

  protected resolveBoxInstruction(
    detection: Detection,
    context: InteractionStyleContext,
    rect: Rect,
  ): BoxDrawInstruction {
    const shape = this.resolveShape(detection, context);
    const cornerRadius = this.resolveCornerRadius(detection, context, shape);
    const instruction: BoxDrawInstruction = {
      fill: this.resolveFill(detection, context),
      rect,
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
    context: InteractionStyleContext,
  ): BoxShape {
    return (
      resolveStyleValue(this.options.shape, detection, context) ?? BoxShape.Rect
    );
  }

  protected resolveCornerRadius(
    detection: Detection,
    context: InteractionStyleContext,
    shape: BoxShape,
  ): number | undefined {
    if (shape !== BoxShape.RoundedRect) {
      return undefined;
    }

    return resolveStyleValue(this.options.cornerRadius, detection, context);
  }

  protected resolveStroke(
    detection: Detection,
    context: InteractionStyleContext,
  ): BoxStrokeStyle | undefined {
    const stroke = resolveStyleValue(this.options.stroke, detection, context);

    if (stroke === null) {
      return undefined;
    }

    const defaults = getStateDefaults(context.state);
    return resolveStrokeStyle(stroke, {
      alpha: defaults.strokeAlpha,
      color: defaults.strokeColor,
      width: defaults.strokeWidth,
    });
  }

  protected resolveFill(
    detection: Detection,
    context: InteractionStyleContext,
  ): BoxFillStyle | undefined {
    const fill = resolveStyleValue(this.options.fill, detection, context);

    if (fill === null) {
      return undefined;
    }

    const defaults = getStateDefaults(context.state);

    return {
      alpha: fill?.alpha ?? defaults.fillAlpha,
      color: fill?.color ?? defaults.fillColor,
    };
  }
}

function createResolvedBoxStyle(instruction: BoxDrawInstruction): BoxStyle {
  return {
    resolve() {
      return instruction;
    },
  };
}

function getStateDefaults(state: DetectionInteractionState) {
  if (state === DetectionInteractionState.Selected) {
    return {
      fillAlpha: DEFAULT_SELECTED_FILL_ALPHA,
      fillColor: DEFAULT_SELECTED_FILL_COLOR,
      strokeAlpha: DEFAULT_SELECTED_STROKE_ALPHA,
      strokeColor: DEFAULT_SELECTED_STROKE_COLOR,
      strokeWidth: DEFAULT_SELECTED_STROKE_WIDTH,
    };
  }

  return {
    fillAlpha: DEFAULT_HOVER_FILL_ALPHA,
    fillColor: DEFAULT_HOVER_FILL_COLOR,
    strokeAlpha: DEFAULT_HOVER_STROKE_ALPHA,
    strokeColor: DEFAULT_HOVER_STROKE_COLOR,
    strokeWidth: DEFAULT_HOVER_STROKE_WIDTH,
  };
}
