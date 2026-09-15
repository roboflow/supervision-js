/** How a session-option figure reads, wherever one is shown. */

export function formatOptionSeconds(value: number | undefined) {
  return value === undefined ? "none" : `${trimOptionZeros(value)}s`;
}

export function formatOptionMebibytes(value: number) {
  return `${trimOptionZeros(value)} MiB`;
}

export function formatOptionCount(value: number | undefined) {
  return value === undefined ? "none" : String(value);
}

export function formatOptionFlag(value: boolean | undefined) {
  if (value === undefined) {
    return "unset";
  }

  return value ? "on" : "off";
}

export function trimOptionZeros(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
