/**
 * How late a frame may be and still be worth presenting.
 *
 * Roughly half a frame at 30fps. Past this the frame's moment has gone, and
 * presenting it anyway only pushes every following frame further behind.
 */
export const MEDIA_CLOCK_LATE_TOLERANCE_MS = 16;

/**
 * Budget carried between frames.
 *
 * `spareMs` is time the clock has banked by waiting for frames that arrived
 * early. That waiting is the only slack a media-paced session ever has, so it
 * is what inference must be paid for out of. `lastInferenceMs` is the measured
 * price of one model run.
 */
export interface MediaClockBudget {
  readonly lastInferenceMs: number;
  readonly spareMs: number;
}

export interface MediaClockDecision {
  /**
   * Milliseconds until this frame is due. Negative means it is already late.
   */
  readonly slackMs: number;
  /** Drop the frame without presenting it: its moment has passed. */
  readonly shouldDrop: boolean;
  /**
   * Whether the banked budget can pay for inference on this frame.
   *
   * Inference costs far more than a frame budget, so spending it on every
   * frame that happens to be on time means presenting roughly one frame per
   * model run — correct duration, unwatchable video. Requiring the wait time
   * to have already covered the last measured cost is what leaves room to
   * present the frames in between from held detections.
   */
  readonly shouldInfer: boolean;
}

/**
 * Decides what the media clock should do with one decoded frame.
 *
 * Pure so the policy can be tested without Skia, worklets, or a decoder. The
 * pump owns the waiting, the presenting, and the budget; this owns only the
 * arithmetic.
 */
export function resolveMediaClockDecision(options: {
  /** Wall-clock time the first presented frame was pinned to. */
  readonly anchorMs: number;
  /** Presentation timestamp of that first frame. */
  readonly anchorPts: number;
  readonly budget: MediaClockBudget;
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
  // The first run has no measured price yet, so it is always affordable.
  // Without that seed nothing would ever infer.
  const isAffordable =
    options.budget.lastInferenceMs <= 0 ||
    options.budget.spareMs >= options.budget.lastInferenceMs;

  return {
    shouldDrop,
    // A dropped frame is never inferred: paying for a result nobody will see
    // is what puts the schedule further behind in the first place.
    shouldInfer: !shouldDrop && isAffordable,
    slackMs,
  };
}

/**
 * Folds one frame's outcome back into the budget.
 *
 * Waiting banks time; inferring spends it. Keeping this beside the decision
 * means the two halves of the rule cannot drift apart.
 */
export function advanceMediaClockBudget(options: {
  readonly budget: MediaClockBudget;
  /** Measured cost of this frame's inference, or 0 if it did not run. */
  readonly inferenceMs: number;
  readonly inferred: boolean;
  /** Milliseconds actually spent waiting for this frame to come due. */
  readonly waitedMs: number;
}): MediaClockBudget {
  "worklet";

  const banked = options.budget.spareMs + Math.max(0, options.waitedMs);

  if (!options.inferred) {
    return { lastInferenceMs: options.budget.lastInferenceMs, spareMs: banked };
  }

  return {
    // Track the real price so the cadence follows the device rather than a
    // constant chosen on one machine.
    lastInferenceMs: options.inferenceMs,
    spareMs: Math.max(0, banked - options.inferenceMs),
  };
}

/** Budget for a session that has not presented a frame yet. */
export function createMediaClockBudget(): MediaClockBudget {
  "worklet";

  return { lastInferenceMs: 0, spareMs: 0 };
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
