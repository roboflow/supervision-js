export function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTime(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "-"
    : `${value.toFixed(2)}s`;
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
