export function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTime(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "-"
    : `${value.toFixed(2)}s`;
}

export function formatExactTime(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "-"
    : `${value.toFixed(4)}s`;
}

export function formatMilliseconds(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "-"
    : `${value.toFixed(2)}ms`;
}

export function formatTimeRange(
  startTime: number | null,
  endTime: number | null,
) {
  if (startTime === null || endTime === null) {
    return "-";
  }

  return `${formatTime(startTime)}-${formatTime(endTime)}`;
}

/**
 * A looping detection buffer reports its ranges on an unbounded comparable
 * axis (media time plus whole laps), so a range read after a lap or two lands
 * far past the clip's duration. Fold both endpoints back into [0, duration)
 * before showing them next to a playhead that wraps.
 */
export function toSourceTimeRange(
  startTime: number | null,
  endTime: number | null,
  duration: number | null,
): { readonly endTime: number | null; readonly startTime: number | null } {
  if (
    startTime === null ||
    endTime === null ||
    duration === null ||
    duration <= 0 ||
    (startTime >= 0 && endTime <= duration)
  ) {
    return { endTime, startTime };
  }

  const wrap = (value: number) => ((value % duration) + duration) % duration;

  return { endTime: wrap(endTime), startTime: wrap(startTime) };
}
