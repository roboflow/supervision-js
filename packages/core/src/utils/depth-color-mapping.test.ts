import { describe, expect, it } from "vitest";

import {
  DepthMapKind,
  DepthQuantity,
  type DepthCamera,
  type DepthMap,
  type PreviewDepthSamples,
  type ScaledDepthSamples,
} from "#types/depth-map";
import {
  computeDepthPercentileRange,
  convertDepthValue,
  decodeDepthSample,
  resolveDepthColorMapping,
  resolveDepthQuantity,
  type DepthColorMapping,
} from "#utils/depth-color-mapping";

/** fx * B = 100, so disparity 4 px is 25 m and 100 px is 1 m. */
const camera: DepthCamera = { baselineM: 0.1, fxPx: 1000 };

function scaledMap(
  kind: DepthMapKind,
  values: readonly number[],
  options: Partial<DepthMap> & { scale?: number } = {},
): DepthMap {
  const { scale = 1, ...rest } = options;

  return {
    height: 1,
    kind,
    samples: { encoding: "scaled16", scale, values: Uint16Array.from(values) },
    width: values.length,
    ...rest,
  };
}

describe("depth colour mapping", () => {
  it.each([
    [
      DepthMapKind.DisparityPx,
      DepthQuantity.Disparity,
      [100, 4],
      { max: 100, min: 4 },
    ],
    [
      DepthMapKind.DisparityPx,
      DepthQuantity.Depth,
      [100, 4],
      { max: 100, min: 4 },
    ],
    [DepthMapKind.DepthM, DepthQuantity.Depth, [1, 25], { max: 25, min: 1 }],
    [
      DepthMapKind.DepthM,
      DepthQuantity.Disparity,
      [1, 25],
      { max: 25, min: 1 },
    ],
    [
      DepthMapKind.RelativeInverse,
      DepthQuantity.Disparity,
      [9, 2],
      { max: 9, min: 2 },
    ],
    [
      DepthMapKind.RelativeInverse,
      DepthQuantity.Depth,
      [9, 2],
      { max: 9, min: 2 },
    ],
  ])(
    "puts the near end at t = 1 for %s coloured as %s",
    (kind, quantity, [near, far], displayRange) => {
      const map = scaledMap(kind, [near, far], { camera, displayRange });
      const mapping = resolveDepthColorMapping(map, {
        quantity,
        range: "clip",
      });

      expect(depthColorCoordinate(near, map.samples, mapping)).toBeCloseTo(
        1,
        9,
      );
      expect(depthColorCoordinate(far, map.samples, mapping)).toBeCloseTo(0, 9);
    },
  );

  it("applies the principal-point offset on the correct side", () => {
    const withOffset = { ...camera, doffsPx: 20 };
    const toDepth = resolveDepthColorMapping(
      scaledMap(DepthMapKind.DisparityPx, [80], {
        camera: withOffset,
        displayRange: { max: 80, min: 5 },
      }),
      { quantity: DepthQuantity.Depth },
    );
    const toDisparity = resolveDepthColorMapping(
      scaledMap(DepthMapKind.DepthM, [1], {
        camera: withOffset,
        displayRange: { max: 4, min: 1 },
      }),
      { quantity: DepthQuantity.Disparity },
    );

    // Z = 100 / (d + 20): 80 px is 1 m and 5 px is 4 m.
    expect([toDepth.lo, toDepth.hi]).toEqual([1, 4]);
    // d = 100 / Z - 20: 4 m is 5 px and 1 m is 80 px.
    expect([toDisparity.lo, toDisparity.hi]).toEqual([5, 80]);
  });

  it("leaves disparity at or below -doffsPx out of a depth range", () => {
    // Z = 100 / (d - 5): 10 px is 20 m, 40 px is 100 / 35 m.
    const map = scaledMap(
      DepthMapKind.DisparityPx,
      [2, 5, 10, 20, 40].flatMap((value) => [value, 0]),
      {
        camera: { ...camera, doffsPx: -5 },
        displayRange: { max: 60, min: 1 },
      },
    );
    const clip = resolveDepthColorMapping(map, {
      quantity: DepthQuantity.Depth,
    });

    // A display range reaching below 5 px has no image, so it falls back to
    // the percentiles of the pixels that have depth.
    expect([clip.lo, clip.hi]).toEqual([100 / 35, 20]);
  });

  it("falls back to disparity where depth is undefined, and says so", () => {
    expect(
      resolveDepthQuantity(DepthMapKind.RelativeInverse, DepthQuantity.Depth),
    ).toEqual({ fellBack: true, quantity: DepthQuantity.Disparity });
    expect(
      resolveDepthQuantity(DepthMapKind.DisparityPx, DepthQuantity.Depth),
    ).toEqual({ fellBack: true, quantity: DepthQuantity.Disparity });
    expect(
      resolveDepthQuantity(
        DepthMapKind.DisparityPx,
        DepthQuantity.Depth,
        camera,
      ),
    ).toEqual({ fellBack: false, quantity: DepthQuantity.Depth });
  });

  it("colours metric depth as plain inverse depth without a camera", () => {
    const mapping = resolveDepthColorMapping(
      scaledMap(DepthMapKind.DepthM, [2], {
        displayRange: { max: 10, min: 0.5 },
      }),
    );

    expect(mapping).toMatchObject({
      hi: 2,
      lo: 0.1,
      quantity: DepthQuantity.Disparity,
    });
  });

  it("uses an explicit range as given and never paints no-depth samples", () => {
    const map = scaledMap(DepthMapKind.DisparityPx, [0, 10, 30], {
      displayRange: { max: 100, min: 0.5 },
    });
    const mapping = resolveDepthColorMapping(map, {
      range: { max: 20, min: 10 },
    });

    expect([mapping.lo, mapping.hi]).toEqual([10, 20]);
    expect(depthColorCoordinate(0, map.samples, mapping)).toBeNull();
    expect(depthColorCoordinate(30, map.samples, mapping)).toBe(1);
  });
});

describe("depth percentile ranges", () => {
  /**
   * The histogram reads every second pixel, so the odd columns hold values
   * that would move the answer if they were read.
   */
  function stridedMap(sampled: readonly number[]): DepthMap {
    const values: number[] = [];

    for (const value of sampled) values.push(value, 60_000);

    return scaledMap(DepthMapKind.DisparityPx, values, { camera });
  }

  it("takes exact nearest-rank percentiles and ignores no-depth samples", () => {
    const codes = Array.from({ length: 100 }, (_, index) => index + 1);
    const map = stridedMap([...codes, ...new Array<number>(40).fill(0)]);

    // 100 valid samples: rank round(0.02 * 99) = 2 and round(0.98 * 99) = 97.
    expect(computeDepthPercentileRange(map)).toEqual({ max: 98, min: 3 });
    expect(computeDepthPercentileRange(map, { high: 1, low: 0 })).toEqual({
      max: 100,
      min: 1,
    });
    // fx * B = 100: codes 1..100 px are 100..1 m, so the bounds swap.
    expect(
      computeDepthPercentileRange(map, {
        high: 1,
        low: 0,
        quantity: DepthQuantity.Depth,
      }),
    ).toEqual({ max: 100, min: 1 });
    // A flat frame widens by one stored step.
    expect(
      computeDepthPercentileRange(stridedMap([512, 512, 512]), {
        quantity: DepthQuantity.Disparity,
      }),
    ).toEqual({ max: 513, min: 512 });
  });

  it("widens a TV-range preview frame held at its top code below it, never above", () => {
    const tvPreview = (codes: readonly number[]): DepthMap => ({
      height: 1,
      kind: DepthMapKind.DisparityPx,
      samples: {
        encoding: "preview8",
        levels: "tv",
        range: { max: 40, min: 1 },
        reservedMax: 31,
        values: Uint8Array.from(codes.flatMap((code) => [code, 0])),
      },
      width: codes.length * 2,
    });
    // Codes 32 to 235 step 39 / 203 apart; codes above 235 read as 40.
    const topStep = { max: 40, min: 1 + (202 / 203) * 39 };

    expect(
      computeDepthPercentileRange(
        tvPreview([235, ...new Array<number>(62).fill(236), 237]),
      ),
    ).toEqual(topStep);
  });

  it("returns null when under 1 % of the samples hold depth", () => {
    const sparse = stridedMap([7, ...new Array<number>(199).fill(0)]);

    expect(computeDepthPercentileRange(sparse)).toBeNull();
    expect(
      computeDepthPercentileRange(
        stridedMap([7, 8, ...new Array<number>(198).fill(0)]),
      ),
    ).not.toBeNull();
  });

  it("falls back from clip to auto, and from auto to every valid sample", () => {
    const codes = Array.from({ length: 100 }, (_, index) => index + 1);
    const noClip = resolveDepthColorMapping(stridedMap(codes), {
      range: "clip",
    });
    const sparse = resolveDepthColorMapping(
      stridedMap([7, 9, ...new Array<number>(398).fill(0)]),
      { range: "auto" },
    );

    expect([noClip.lo, noClip.hi]).toEqual([3, 98]);
    expect([sparse.lo, sparse.hi]).toEqual([7, 9]);
  });

  it("rejects percentiles outside 0..1", () => {
    const map = stridedMap([1, 2, 3]);

    expect(() =>
      computeDepthPercentileRange(map, { low: 0.9, high: 0.1 }),
    ).toThrow(RangeError);
    expect(() => computeDepthPercentileRange(map, { high: 98 })).toThrow(
      RangeError,
    );
  });
});

/**
 * What the depth shader computes for one stored value: its colour
 * coordinate, 1 at the near end, or null where there is no depth.
 */
function depthColorCoordinate(
  stored: number,
  samples: ScaledDepthSamples | PreviewDepthSamples,
  mapping: DepthColorMapping,
): number | null {
  const value = decodeDepthSample(stored, samples);

  if (value === null) {
    return null;
  }

  const converted = convertDepthValue(value, mapping);
  const t = Math.min(
    1,
    Math.max(0, (converted - mapping.lo) / (mapping.hi - mapping.lo)),
  );

  return mapping.nearIsLow ? 1 - t : t;
}
