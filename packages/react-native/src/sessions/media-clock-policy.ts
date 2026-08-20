/**
 * How late a frame may be and still be worth presenting.
 *
 * Roughly half a frame at 30fps. Past this the frame's moment has gone, and
 * presenting it anyway only pushes every following frame further behind.
 */
export const MEDIA_CLOCK_LATE_TOLERANCE_MS = 16;

export interface MediaClockDecision {
  /**
   * Milliseconds until this frame is due. Negative means it is already late.
   */
  readonly slackMs: number;
  /** Drop the frame without presenting it: its moment has passed. */
  readonly shouldDrop: boolean;
  /**
   * Whether the clock has slack to pay for inference on this frame.
   *
   * Inference costs far more than a frame budget, so running one puts the
   * session behind. The next frames then reuse the held detections and present
   * cheaply until the schedule recovers, which makes the inference rate
   * self-regulating rather than a hardcoded interval.
   */
  readonly shouldInfer: boolean;
}

/**
 * Decides what the media clock should do with one decoded frame.
 *
 * Pure so the policy can be tested without Skia, worklets, or a decoder. The
 * pump owns the waiting and the presenting; this owns only the arithmetic.
 */
export function resolveMediaClockDecision(options: {
  /** Wall-clock time the first presented frame was pinned to. */
  readonly anchorMs: number;
  /** Presentation timestamp of that first frame. */
  readonly anchorPts: number;
  readonly lateToleranceMs?: number;
  readonly nowMs: number;
  /** Presentation timestamp of the frame being decided. */
  readonly timestampMs: number;
}): MediaClockDecision {
  "worklet";

  const lateToleranceMs =
    options.lateToleranceMs ?? MEDIA_CLOCK_LATE_TOLERANCE_MS;
  const dueAtMs = options.anchorMs + (options.timestampMs - options.anchorPts);
  const slackMs = dueAtMs - options.nowMs;
  const shouldDrop = slackMs < -lateToleranceMs;

  return {
    shouldDrop,
    // A dropped frame is never inferred: paying for a result nobody will see
    // is what puts the schedule further behind in the first place.
    shouldInfer: !shouldDrop && slackMs >= 0,
    slackMs,
  };
}

/**
 * Wall-clock time a frame should be presented at.
 *
 * Exposed separately because the pump waits on this value directly, and a
 * spin loop must not recompute the policy on every iteration.
 */
export function resolveMediaClockDueAt(options: {
  readonly anchorMs: number;
  readonly anchorPts: number;
  readonly timestampMs: number;
}): number {
  "worklet";

  return options.anchorMs + (options.timestampMs - options.anchorPts);
}
