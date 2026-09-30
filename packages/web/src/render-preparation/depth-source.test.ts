import { describe, expect, it } from "vitest";

import type { DepthMap } from "supervision-js-core";
import {
  openDepthSource,
  validateDepthInput,
} from "#render-preparation/depth-source";

function depthMap(width: number, height: number): DepthMap {
  return {
    height,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 256,
      values: new Uint16Array(width * height),
    },
    width,
  };
}

describe("depth source", () => {
  it("answers every media time with a still map", () => {
    const map = depthMap(64, 36);
    const source = openDepthSource({ map }, { height: 720, width: 1280 });

    expect(source.getEntry(0)).toEqual({
      frameIndex: null,
      map,
      precision: "exact",
    });
    expect(source.getEntry(12.5)?.map).toBe(map);
  });

  it("accepts a map within 1 % of the media's aspect ratio", () => {
    expect(() =>
      openDepthSource(
        { map: depthMap(640, 362) },
        { height: 720, width: 1280 },
      ),
    ).not.toThrow();
  });

  it("rejects a map of another shape than the media", () => {
    expect(() =>
      openDepthSource(
        { map: depthMap(640, 480) },
        { height: 720, width: 1280 },
      ),
    ).toThrow(
      new RangeError(
        "Depth map 640x480 does not have the aspect ratio of the 1280x720 media.",
      ),
    );
  });

  it("rejects input without a well-formed map", () => {
    expect(() => validateDepthInput({} as never)).toThrow(
      "Depth input needs a map.",
    );
    expect(() =>
      validateDepthInput({ map: { ...depthMap(4, 4), width: 3 } }),
    ).toThrow("DepthMap samples.values has 16 values for 3x4 pixels.");
  });
});
