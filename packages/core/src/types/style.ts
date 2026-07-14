import type { Detection, DetectionFrame } from "#types/detections";

/** Shared presentation state supplied to every annotation style resolver. */
export interface AnnotationStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly detectionIndex: number;
  /** Media-to-screen scale. Screen-space style values are divided by this. */
  readonly viewportScale?: number;
  readonly ephemeral?: boolean;
  readonly isCreating?: boolean;
  readonly hidden?: boolean;
  readonly loading?: boolean;
  readonly hovered?: boolean;
  readonly selected?: boolean;
}

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
  TValue | ((detection: Detection, context: TContext) => TValue);
