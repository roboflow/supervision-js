import { describe, expect, it } from "vitest";

import {
  annotationRenderers,
  resolveDepthColorMapping,
  type DepthMap,
} from "supervision-js-core";
import {
  DEPTH_EDGE_RATIO,
  resolveDepthShaderUniforms,
} from "#renderers/pixi-depth-shader";

const disparityMap: DepthMap = {
  camera: { baselineM: 0.1, fxPx: 1000 },
  displayRange: { max: 100, min: 4 },
  height: 2,
  kind: "disparity_px",
  samples: { encoding: "scaled16", scale: 256, values: new Uint16Array(8) },
  width: 4,
};

function previewMap(levels?: "tv"): DepthMap {
  return {
    ...disparityMap,
    samples: {
      encoding: "preview8",
      ...(levels ? { levels } : {}),
      range: { max: 192, min: 0 },
      reservedMax: levels ? 31 : 15,
      values: new Uint8Array(8),
    },
  };
}

describe("pixi depth shader uniforms", () => {
  it("carry the mapping core resolved, the encoding and the sampling", () => {
    const uniforms = resolveDepthShaderUniforms(
      disparityMap,
      resolveDepthColorMapping(disparityMap, { quantity: "depth" }),
      annotationRenderers.depth({ noDepthColor: 0x336699, wipe: 0.25 }),
      { height: 80, width: 160 },
    );

    expect(uniforms).toMatchObject({
      uEdgeRatio: DEPTH_EDGE_RATIO,
      uEncoding: 0,
      uInnerOffset: 0,
      uInvScale: 1 / 256,
      uNearIsLow: 1,
      uNumerator: 100,
      uRangeHi: 25,
      uRangeLo: 1,
      uReciprocal: 1,
      uSampling: 1,
      uWipe: 0.25,
    });
    expect(Array.from(uniforms.uMapSize)).toEqual([4, 2]);
    expect(Array.from(uniforms.uNoDepthColor)).toEqual(
      [0.2, 0.4, 0.6, 1].map((value) => Math.fround(value)),
    );
  });

  it.each([
    ["full-range preview codes", previewMap(), 255, 15],
    ["TV-range preview codes", previewMap("tv"), 235, 31],
  ])(
    "describe %s, leaving no-depth pixels unpainted",
    (_, map, top, reserved) => {
      const uniforms = resolveDepthShaderUniforms(
        map,
        resolveDepthColorMapping(map),
        annotationRenderers.depth(),
        { height: 2, width: 4 },
      );

      expect(uniforms).toMatchObject({
        uEncoding: 1,
        uPreviewHi: 192,
        uPreviewLo: 0,
        uPreviewTop: top,
        uReservedMax: reserved,
        uWipe: 1,
      });
      expect(Array.from(uniforms.uNoDepthColor)).toEqual([0, 0, 0, 0]);
    },
  );

  it.each([
    ["nearest at the map's own size", "auto", { height: 2, width: 4 }, 0],
    [
      "edge-aware for a map smaller than the media",
      "auto",
      { height: 4, width: 8 },
      1,
    ],
    [
      "nearest when asked, whatever the size",
      "nearest",
      { height: 4, width: 8 },
      0,
    ],
  ] as const)("sample %s", (_, sampling, mesh, expected) => {
    expect(
      resolveDepthShaderUniforms(
        disparityMap,
        resolveDepthColorMapping(disparityMap),
        annotationRenderers.depth({ sampling }),
        mesh,
      ).uSampling,
    ).toBe(expected);
  });
});
