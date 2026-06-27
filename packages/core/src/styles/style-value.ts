import type { Detection } from "#types/detections";
import type { DetectionStyleValue } from "#types/style";

export function resolveStyleValue<TValue, TContext>(
  value: DetectionStyleValue<TValue, TContext> | undefined,
  detection: Detection,
  context: TContext,
) {
  return typeof value === "function"
    ? (value as (detection: Detection, context: TContext) => TValue)(
        detection,
        context,
      )
    : value;
}
