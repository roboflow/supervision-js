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
