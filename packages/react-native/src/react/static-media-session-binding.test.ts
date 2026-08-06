import {
  BaseBoxStyle,
  BaseKeypointStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BasePolygonStyle,
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
  MaskRenderMode,
} from "supervision-js-core";
import { describe, expect, it } from "vitest";

import {
  createReactNativeStaticMediaSessionBinding,
  getReactNativeMediaSessionViewReadout,
} from "./static-media-session-binding";

describe("createReactNativeStaticMediaSessionBinding", () => {
  it("keeps prepared artifacts behind an opaque binding and exposes semantic readouts", () => {
    const binding = createReactNativeStaticMediaSessionBinding({
      boxStyle: new BaseBoxStyle(),
      detectionFrame: {
        detections: [
          {
            className: "person",
            id: "person-1",
            keypoints: {
              edges: [],
              points: [{ x: 4, y: 5 }],
            },
            mask: {
              counts: encodeCompressedRleCounts([0, 1]),
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 1,
              width: 1,
            },
            polygon: {
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
              ],
            },
            rect: { height: 10, width: 10, x: 5, y: 5 },
          },
        ],
        mediaTime: 0,
      },
      imageSource: 1,
      keypointStyle: new BaseKeypointStyle(),
      labelStyle: new BaseLabelStyle(),
      maskStyle: new BaseMaskStyle({ mode: MaskRenderMode.FillOnly }),
      mediaMetadata: {
        duration: 1 / 30,
        frameIndex: 0,
        height: 10,
        mediaTime: 0,
        width: 10,
      },
      polygonStyle: new BasePolygonStyle(),
    });

    expect(getReactNativeMediaSessionViewReadout(binding)).toEqual({
      detectionCount: 1,
      keypointCount: 1,
      maskCount: 1,
      polygonCount: 1,
    });
    expect(Object.keys(binding)).toEqual([]);
  });
});
