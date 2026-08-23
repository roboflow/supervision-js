import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxStyle,
} from "#types/box-style";
import type { Detection, Rect } from "#types/detections";
import {
  DetectionInteractionState,
  type InteractionPresentation,
  type InteractionStyle,
  type InteractionStyleContext,
} from "#types/interaction-style";
import type { DetectionStylePredicate } from "#types/style";

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
   * Return false to skip rendering an interaction highlight.
   */
  readonly shouldRender?: DetectionStylePredicate<InteractionStyleContext>;
}

/**
 * Default configurable interaction style.
 *
 * It resolves hover and selected picks into state-specific presentations using
 * the same style contracts as normal boxes, masks, and labels. A state left
 * unconfigured falls back to a highlight rectangle over the detection.
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
      boxStyle: createDefaultHighlightBoxStyle(context.state, rect),
    };
  }
}

function createDefaultHighlightBoxStyle(
  state: DetectionInteractionState,
  rect: Rect,
): BoxStyle {
  const defaults = getStateDefaults(state);
  const instruction: BoxDrawInstruction = {
    fill: { alpha: defaults.fillAlpha, color: defaults.fillColor },
    rect,
    shape: BoxShape.Rect,
    stroke: {
      alpha: defaults.strokeAlpha,
      color: defaults.strokeColor,
      width: defaults.strokeWidth,
    },
  };

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
