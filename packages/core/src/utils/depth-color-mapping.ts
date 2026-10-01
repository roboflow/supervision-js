import {
  DepthMapKind,
  DepthQuantity,
  type DepthCamera,
  type DepthMap,
  type DepthRange,
  type PreviewDepthSamples,
  type ScaledDepthSamples,
} from "#types/depth-map";
import { depthPreviewTopCode } from "#utils/depth-manifest";

/** Percentiles `"auto"` colours between: outliers and flying pixels fall outside. */
export const DEFAULT_DEPTH_PERCENTILE_LOW = 0.02;
export const DEFAULT_DEPTH_PERCENTILE_HIGH = 0.98;

/** Below this share of valid samples a percentile says nothing about the scene. */
const MIN_VALID_SAMPLE_SHARE = 0.01;
const PERCENTILE_SAMPLE_STRIDE = 2;
const FALLBACK_RANGE: DepthRange = { min: 0, max: 1 };

/** How a depth renderer chooses what it colours; renderer descriptors fit it. */
export interface DepthColorMappingOptions {
  readonly quantity?: DepthQuantity;
  /**
   * `"clip"` is the map's own display range, `"auto"` this frame's 2nd to
   * 98th percentile, and an object is an explicit range in the quantity's
   * unit. `"clip"` without a display range behaves as `"auto"`.
   */
  readonly range?: "clip" | "auto" | DepthRange;
}

/** The quantity actually coloured, which can differ from the one requested. */
export interface DepthQuantityResolution {
  readonly quantity: DepthQuantity;
  /** True when the map cannot provide the requested quantity, so disparity is coloured. */
  readonly fellBack: boolean;
}

/**
 * How a value in the map kind's unit becomes the coloured quantity:
 * `reciprocal ? numerator / (x + innerOffset) + outerOffset : x`.
 */
export interface DepthValueConversion extends DepthQuantityResolution {
  readonly reciprocal: boolean;
  readonly numerator: number;
  readonly innerOffset: number;
  readonly outerOffset: number;
  /** Depth grows away from the camera, so its low end is the near, warm end. */
  readonly nearIsLow: boolean;
}

/**
 * Everything a depth shader needs besides the samples:
 * `t = clamp((v - lo) / (hi - lo))`, flipped to `1 - t` when `nearIsLow`.
 */
export interface DepthColorMapping extends DepthValueConversion {
  readonly lo: number;
  readonly hi: number;
}

export interface DepthPercentileRangeOptions {
  readonly quantity?: DepthQuantity;
  /** Lower percentile from 0 to 1. Defaults to 0.02. */
  readonly low?: number;
  /** Upper percentile from 0 to 1. Defaults to 0.98. */
  readonly high?: number;
}

/**
 * Metric depth needs a camera to come out of disparity, and relative inverse
 * depth has no metric depth at all, so both fall back to disparity.
 */
export function resolveDepthQuantity(
  kind: DepthMapKind,
  quantity: DepthQuantity = DepthQuantity.Disparity,
  camera?: DepthCamera,
): DepthQuantityResolution {
  if (quantity === DepthQuantity.Disparity) {
    return { fellBack: false, quantity };
  }
  if (
    kind === DepthMapKind.DepthM ||
    (kind === DepthMapKind.DisparityPx && camera !== undefined)
  ) {
    return { fellBack: false, quantity: DepthQuantity.Depth };
  }

  return { fellBack: true, quantity: DepthQuantity.Disparity };
}

export function resolveDepthValueConversion(
  map: Pick<DepthMap, "camera" | "kind">,
  quantity?: DepthQuantity,
): DepthValueConversion {
  const resolved = resolveDepthQuantity(map.kind, quantity, map.camera);
  const nearIsLow = resolved.quantity === DepthQuantity.Depth;
  const identity = {
    ...resolved,
    innerOffset: 0,
    nearIsLow,
    numerator: 1,
    outerOffset: 0,
    reciprocal: false,
  };
  const camera = map.camera;
  const focalBaseline = camera ? camera.fxPx * camera.baselineM : 1;
  const doffs = camera?.doffsPx ?? 0;

  if (
    map.kind === DepthMapKind.DisparityPx &&
    resolved.quantity === DepthQuantity.Depth
  ) {
    // Z = fx * B / (d + doffs)
    return {
      ...identity,
      innerOffset: doffs,
      numerator: focalBaseline,
      reciprocal: true,
    };
  }
  if (
    map.kind === DepthMapKind.DepthM &&
    resolved.quantity === DepthQuantity.Disparity
  ) {
    // d = fx * B / Z - doffs, or plain inverse depth without a camera.
    return {
      ...identity,
      numerator: focalBaseline,
      outerOffset: doffs === 0 ? 0 : -doffs,
      reciprocal: true,
    };
  }

  return identity;
}

export function convertDepthValue(
  value: number,
  conversion: DepthValueConversion,
): number {
  return conversion.reciprocal
    ? conversion.numerator / (value + conversion.innerOffset) +
        conversion.outerOffset
    : value;
}

/**
 * Converts a range in the map kind's unit, swapping its bounds under a
 * reciprocal. Null when a bound has no finite image, such as zero disparity.
 */
export function convertDepthRange(
  range: DepthRange,
  conversion: DepthValueConversion,
): DepthRange | null {
  const first = convertDepthValue(range.min, conversion);
  const second = convertDepthValue(range.max, conversion);
  const min = Math.min(first, second);
  const max = Math.max(first, second);

  return Number.isFinite(min) && Number.isFinite(max) && min < max
    ? { max, min }
    : null;
}

/** The value in the map kind's unit, or null where there is no depth. */
export function decodeDepthSample(
  stored: number,
  samples: ScaledDepthSamples | PreviewDepthSamples,
): number | null {
  if (samples.encoding === "scaled16") {
    return stored === 0 ? null : stored / samples.scale;
  }
  if (stored <= samples.reservedMax) {
    return null;
  }
  const span = depthPreviewSpan(samples);

  return (
    samples.range.min +
    (Math.min(stored - samples.reservedMax - 1, span) / span) *
      (samples.range.max - samples.range.min)
  );
}

/**
 * Steps between the lowest valid preview code and the top one, so one step
 * is `(range.max - range.min) / span`.
 */
export function depthPreviewSpan(samples: PreviewDepthSamples): number {
  return depthPreviewTopCode(samples.levels) - samples.reservedMax - 1;
}

/**
 * This map's own percentile range in the coloured quantity's unit, or null
 * when fewer than 1 % of the samples it reads hold depth.
 *
 * It depends on this map alone, so a frame always gets the same range. Pass
 * the result back as an explicit range to keep colours steady across frames.
 */
export function computeDepthPercentileRange(
  map: DepthMap,
  options: DepthPercentileRangeOptions = {},
): DepthRange | null {
  const low = options.low ?? DEFAULT_DEPTH_PERCENTILE_LOW;
  const high = options.high ?? DEFAULT_DEPTH_PERCENTILE_HIGH;

  if (
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    low < 0 ||
    high > 1 ||
    low >= high
  ) {
    throw new RangeError(
      "Depth percentiles need 0 <= low < high <= 1, as fractions.",
    );
  }

  const histogram = histogramDepthCodes(map);

  if (histogram.valid < histogram.sampled * MIN_VALID_SAMPLE_SHARE) {
    return null;
  }

  return rangeFromHistogram(map, histogram, low, high, options.quantity);
}

/**
 * The range a renderer colours between, in the coloured quantity's unit.
 *
 * `autoRange` lets a caller that already computed this map's percentile range
 * skip the histogram. A range that cannot be honoured falls back step by step:
 * the display range to the percentile range, and that to the full range of
 * the valid samples, so a sparse frame still colours what it has.
 */
export function resolveDepthDisplayRange(
  map: DepthMap,
  options: DepthColorMappingOptions,
  conversion: DepthValueConversion,
  autoRange?: DepthRange | null,
): DepthRange {
  const range = options.range ?? "clip";

  if (typeof range === "object") {
    return range;
  }
  if (range === "clip" && map.displayRange) {
    const clip = convertDepthRange(map.displayRange, conversion);

    if (clip) {
      return clip;
    }
  }

  const percentile =
    autoRange !== undefined
      ? autoRange
      : computeDepthPercentileRange(map, { quantity: conversion.quantity });

  if (percentile) {
    return percentile;
  }

  const histogram = histogramDepthCodes(map);

  return histogram.valid > 0
    ? rangeFromHistogram(map, histogram, 0, 1, conversion.quantity)
    : FALLBACK_RANGE;
}

/** Resolves a renderer's quantity and range for one map into shader terms. */
export function resolveDepthColorMapping(
  map: DepthMap,
  options: DepthColorMappingOptions = {},
  autoRange?: DepthRange | null,
): DepthColorMapping {
  const conversion = resolveDepthValueConversion(map, options.quantity);
  const range = resolveDepthDisplayRange(map, options, conversion, autoRange);

  return { ...conversion, hi: range.max, lo: range.min };
}

interface DepthCodeHistogram {
  readonly counts: Uint32Array;
  readonly sampled: number;
  readonly valid: number;
}

function histogramDepthCodes(map: DepthMap): DepthCodeHistogram {
  const { samples } = map;
  const values = samples.values;
  const counts = new Uint32Array(
    samples.encoding === "scaled16" ? 65_536 : 256,
  );
  const firstValid =
    samples.encoding === "scaled16" ? 1 : samples.reservedMax + 1;
  let sampled = 0;
  let valid = 0;

  for (let y = 0; y < map.height; y += PERCENTILE_SAMPLE_STRIDE) {
    const row = y * map.width;

    for (let x = 0; x < map.width; x += PERCENTILE_SAMPLE_STRIDE) {
      const code = values[row + x];

      sampled += 1;
      if (code >= firstValid) {
        counts[code] += 1;
        valid += 1;
      }
    }
  }

  return { counts, sampled, valid };
}

/**
 * Exact percentiles over the stored codes, taken by nearest rank and then
 * mapped through the monotonic conversion to the coloured quantity. A frame
 * whose chosen codes coincide is widened by one code, so the range stays
 * usable as an explicit range.
 */
function rangeFromHistogram(
  map: DepthMap,
  histogram: DepthCodeHistogram,
  low: number,
  high: number,
  quantity: DepthQuantity | undefined,
): DepthRange {
  const lastRank = histogram.valid - 1;
  let lowCode = codeAtRank(histogram.counts, Math.round(low * lastRank));
  let highCode = codeAtRank(histogram.counts, Math.round(high * lastRank));

  if (lowCode === highCode) {
    if (highCode < histogram.counts.length - 1) highCode += 1;
    else lowCode -= 1;
  }

  const conversion = resolveDepthValueConversion(map, quantity);
  const lowValue = decodeDepthSample(lowCode, map.samples) ?? 0;
  const highValue = decodeDepthSample(highCode, map.samples) ?? 0;

  return (
    convertDepthRange({ max: highValue, min: lowValue }, conversion) ??
    FALLBACK_RANGE
  );
}

function codeAtRank(counts: Uint32Array, rank: number): number {
  let seen = 0;

  for (let code = 0; code < counts.length; code += 1) {
    seen += counts[code];
    if (seen > rank) {
      return code;
    }
  }

  return counts.length - 1;
}
