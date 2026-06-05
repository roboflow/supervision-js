import type { Detection } from "#types/detections";

/**
 * Predicate used by base styles to include or skip a detection.
 */
export type DetectionStylePredicate<TContext> = (
  detection: Detection,
  context: TContext,
) => boolean;

/**
 * Static style value or resolver function.
 *
 * Use static values for simple global styling. Use resolver functions for
 * per-class, per-confidence, or frame-aware presentation without mutating the
 * underlying detection data.
 */
export type DetectionStyleValue<TValue, TContext> =
  | TValue
  | ((detection: Detection, context: TContext) => TValue);
