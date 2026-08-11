import type { StrokeStyle } from "#types/paint-style";

/**
 * Resolves the renderer-neutral stroke contract without dropping optional
 * geometry controls as styles move from public configuration to draw
 * instructions.
 *
 * Keep this as the single normalization point for every built-in style. That
 * makes additions to `StrokeStyle` deliberate instead of relying on each style
 * implementation to copy a growing property list correctly.
 */
export function resolveStrokeStyle(
  stroke: Partial<StrokeStyle> | undefined,
  defaults: StrokeStyle,
): StrokeStyle {
  const alignment = stroke?.alignment ?? defaults.alignment;
  const cap = stroke?.cap ?? defaults.cap;
  const dash = stroke?.dash ?? defaults.dash;
  const join = stroke?.join ?? defaults.join;
  const miterLimit = stroke?.miterLimit ?? defaults.miterLimit;

  return {
    alpha: stroke?.alpha ?? defaults.alpha,
    color: stroke?.color ?? defaults.color,
    width: stroke?.width ?? defaults.width,
    ...(alignment === undefined ? {} : { alignment }),
    ...(cap === undefined ? {} : { cap }),
    ...(dash === undefined ? {} : { dash }),
    ...(join === undefined ? {} : { join }),
    ...(miterLimit === undefined ? {} : { miterLimit }),
  };
}
