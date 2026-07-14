import { BoxShape } from "#types/box-style";
import type {
  FocusDrawInstruction,
  FocusFallbackStyle,
  FocusFillStyle,
  FocusStyle,
  FocusStyleContext,
  FocusStyleValue,
} from "#types/focus-style";
import { FocusTargetMode } from "#types/focus-style";
import type { DetectionPickResult } from "#types/interaction";
import { DetectionPickTarget } from "#types/interaction";

const DEFAULT_FOCUS_FILL_COLOR = 0x020617;
const DEFAULT_FOCUS_FILL_ALPHA = 0.45;
const DEFAULT_FOCUS_CORNER_RADIUS = 8;

export interface BaseFocusStyleOptions {
  /**
   * Which interaction state should keep the media undimmed.
   */
  readonly targetMode?: FocusTargetMode;
  /**
   * Full-frame dim overlay. Pass `null` or return false from `shouldRender` to
   * disable focus rendering.
   */
  readonly fill?: FocusStyleValue<Partial<FocusFillStyle> | null>;
  /**
   * Geometry used when the focused target cannot use a prepared mask artifact.
   */
  readonly shape?: FocusStyleValue<BoxShape>;
  /**
   * Rounded-rectangle fallback corner radius in media pixels.
   */
  readonly cornerRadius?: FocusStyleValue<number | undefined>;
  readonly shouldRender?: (context: FocusStyleContext) => boolean;
}

/**
 * Default configurable focus style.
 *
 * Focus styles dim the current media frame while leaving the selected or
 * hovered detections visible. Renderers may use prepared mask artifacts for
 * shape-accurate cutouts, falling back to detection rectangles when needed.
 */
export class BaseFocusStyle implements FocusStyle {
  protected readonly options: BaseFocusStyleOptions;

  constructor(options: BaseFocusStyleOptions = {}) {
    this.options = options;
  }

  resolve(context: FocusStyleContext): FocusDrawInstruction | undefined {
    if (this.options.shouldRender?.(context) === false) {
      return undefined;
    }

    const targetMode = this.options.targetMode ?? FocusTargetMode.Selected;
    const targets = getFocusTargets(context, targetMode);
    const ambient =
      targetMode === FocusTargetMode.Ambient &&
      !context.selectedPick &&
      !context.hoveredPick;
    const fill = resolveFocusStyleValue(this.options.fill, context);

    if (targets.length === 0 || fill === null) {
      return undefined;
    }

    return {
      fallback: this.resolveFallback(context),
      fill: {
        alpha: fill?.alpha ?? DEFAULT_FOCUS_FILL_ALPHA,
        color: fill?.color ?? DEFAULT_FOCUS_FILL_COLOR,
      },
      targetMode,
      targets,
      ...(ambient ? { ambient: true } : {}),
    };
  }

  protected resolveFallback(context: FocusStyleContext): FocusFallbackStyle {
    const shape =
      resolveFocusStyleValue(this.options.shape, context) ??
      BoxShape.RoundedRect;
    const cornerRadius =
      shape === BoxShape.RoundedRect
        ? (resolveFocusStyleValue(this.options.cornerRadius, context) ??
          DEFAULT_FOCUS_CORNER_RADIUS)
        : undefined;

    if (cornerRadius === undefined) {
      return { shape };
    }

    return {
      cornerRadius,
      shape,
    };
  }
}

function getFocusTargets(
  context: FocusStyleContext,
  targetMode: FocusTargetMode,
) {
  const targets: DetectionPickResult[] = [];

  if (targetMode === FocusTargetMode.Ambient) {
    if (context.selectedPick) return [context.selectedPick];
    if (context.hoveredPick) return [context.hoveredPick];
    return context.frame.detections.map((detection, detectionIndex) => ({
      detection,
      detectionIndex,
      frame: context.frame,
      mediaTime: context.mediaTime,
      point: detection.rect
        ? { x: detection.rect.x, y: detection.rect.y }
        : { x: 0, y: 0 },
      target: detection.mask
        ? DetectionPickTarget.Mask
        : detection.polygon
          ? DetectionPickTarget.Polygon
          : DetectionPickTarget.Box,
    }));
  }

  if (
    (targetMode === FocusTargetMode.Selected ||
      targetMode === FocusTargetMode.HoveredAndSelected) &&
    context.selectedPick
  ) {
    targets.push(context.selectedPick);
  }

  if (
    (targetMode === FocusTargetMode.Hovered ||
      targetMode === FocusTargetMode.HoveredAndSelected) &&
    context.hoveredPick
  ) {
    targets.push(context.hoveredPick);
  }

  return dedupeTargetsForFrame(targets, context.frame);
}

function dedupeTargetsForFrame(
  targets: readonly DetectionPickResult[],
  frame: FocusStyleContext["frame"],
) {
  const keys = new Set<string>();
  const dedupedTargets: DetectionPickResult[] = [];

  for (const target of targets) {
    if (target.frame !== frame) {
      continue;
    }

    const key = `${target.detectionIndex}:${target.target}`;

    if (keys.has(key)) {
      continue;
    }

    keys.add(key);
    dedupedTargets.push(target);
  }

  return dedupedTargets;
}

function resolveFocusStyleValue<T>(
  value: FocusStyleValue<T> | undefined,
  context: FocusStyleContext,
) {
  if (typeof value === "function") {
    return (value as (context: FocusStyleContext) => T)(context);
  }

  return value;
}
