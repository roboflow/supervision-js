import type {
  DetectionHeatmap,
  HeatmapAnnotationRenderer,
  HeatmapColorStop,
} from "supervision-js-core";

const DEFAULT_STOPS: readonly HeatmapColorStop[] = [
  { position: 0, color: 0xffd600 },
  { position: 0.35, color: 0xffd600 },
  { position: 0.7, color: 0xff7a00 },
  { position: 1, color: 0xdc1e1e },
];

/** Turns semantic scores into an RGBA raster; no palette enters cold data. */
export function colorizeHeatmap(
  map: DetectionHeatmap,
  renderer: HeatmapAnnotationRenderer,
): Uint8ClampedArray {
  const { width, height, values } = map;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    values.length !== width * height
  ) {
    throw new RangeError("Heatmap dimensions must match its row-major values.");
  }

  const scale = map.valueScale ?? 1;
  const threshold = (map.threshold ?? 0) * (renderer.thresholdScale ?? 1);
  const opacity = clamp01(renderer.opacity ?? 1);
  const minimumAlpha = clamp01(renderer.minimumAlpha ?? 0);
  const stops = renderer.colorStops ?? DEFAULT_STOPS;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(threshold) ||
    !Number.isFinite(renderer.thresholdScale ?? 1) ||
    (renderer.thresholdScale ?? 1) < 0 ||
    stops.length === 0 ||
    stops.some(
      (stop, index) =>
        !Number.isFinite(stop.position) ||
        stop.position < 0 ||
        stop.position > 1 ||
        (index > 0 && stop.position < stops[index - 1].position),
    )
  ) {
    throw new RangeError("Invalid heatmap scale, threshold, or color stops.");
  }

  let peak = threshold;
  for (const stored of values) {
    if (Number.isFinite(stored)) peak = Math.max(peak, stored * scale);
  }

  const rgba = new Uint8ClampedArray(values.length * 4);
  if (peak <= threshold || opacity === 0) return rgba;

  for (let index = 0; index < values.length; index += 1) {
    const score = values[index] * scale;
    if (!Number.isFinite(score) || score <= threshold) continue;
    const intensity = clamp01((score - threshold) / (peak - threshold));
    const color = interpolateColor(stops, intensity);
    const offset = index * 4;
    rgba[offset] = color >> 16;
    rgba[offset + 1] = (color >> 8) & 0xff;
    rgba[offset + 2] = color & 0xff;
    rgba[offset + 3] = Math.round(
      255 * opacity * (minimumAlpha + (1 - minimumAlpha) * intensity),
    );
  }
  return rgba;
}

function interpolateColor(stops: readonly HeatmapColorStop[], value: number) {
  const upperIndex = stops.findIndex((stop) => stop.position >= value);
  if (upperIndex === -1) return stops[stops.length - 1].color;
  if (upperIndex === 0) return stops[0].color;
  const left = stops[upperIndex - 1];
  const right = stops[upperIndex];
  const span = right.position - left.position;
  const ratio = span === 0 ? 1 : (value - left.position) / span;
  const channel = (shift: number) =>
    Math.round(
      ((left.color >> shift) & 0xff) * (1 - ratio) +
        ((right.color >> shift) & 0xff) * ratio,
    );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
