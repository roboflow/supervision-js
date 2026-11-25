import { describe, expect, it } from "vitest";
import {
  BaseKeypointStyle,
  BaseOrientedBoxStyle,
  BasePolygonStyle,
  BasePolylineStyle,
  KeypointMarkerShape,
  KeypointVisibility,
} from "../index";

const frame = {
  mediaTime: 0,
  detections: [],
};
const context = { detectionIndex: 0, frame, mediaTime: 0, viewportScale: 2 };

describe("vector presentation styles", () => {
  it("resolves closed polygons and open dashed polylines", () => {
    const points = [
      { x: 1, y: 2 },
      { x: 5, y: 2 },
      { x: 3, y: 6 },
    ];
    expect(
      new BasePolygonStyle({
        stroke: { cap: "round", join: "bevel", miterLimit: 7 },
      }).resolve({ polygon: { points } }, context),
    ).toMatchObject({
      points,
      fill: { alpha: 0.16 },
      stroke: { cap: "round", join: "bevel", miterLimit: 7, width: 2 },
    });
    expect(
      new BasePolylineStyle({
        stroke: {
          cap: "square",
          dash: [6, 4],
          join: "round",
          miterLimit: 5,
          width: 3,
        },
      }).resolve({ polyline: { points } }, context),
    ).toMatchObject({
      stroke: {
        cap: "square",
        dash: [6, 4],
        join: "round",
        miterLimit: 5,
        width: 3,
      },
    });
  });

  it("resolves an explicit oriented-box quadrilateral like a closed polygon", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 2 },
      { x: 8, y: 10 },
      { x: -2, y: 8 },
    ] as const;

    expect(
      new BaseOrientedBoxStyle({
        stroke: { cap: "round", join: "bevel", miterLimit: 7 },
      }).resolve({ orientedBox: { points } }, context),
    ).toMatchObject({
      points,
      fill: { alpha: 0.16 },
      stroke: { cap: "round", join: "bevel", miterLimit: 7, width: 2 },
    });
  });

  // Degenerate-input handling (fewer than four points, zero-enclosed-area,
  // hidden/shouldRender) is covered by `oriented-box-style.test.ts`; this
  // file focuses on the shared stroke/points resolution this style has in
  // common with the other closed-path vector styles above.

  it("uses schema colors, shadows, and occluded cross markers", () => {
    const instruction = new BaseKeypointStyle({
      definitions: {
        person: {
          edges: [{ from: 0, to: 1, color: 0x123456 }],
          vertices: [
            { id: 0, name: "a", color: 0xabcdef },
            { id: 1, name: "b" },
          ],
        },
      },
      edgeShadowStroke: {
        cap: "square",
        join: "bevel",
        miterLimit: 8,
      },
      edgeStroke: { cap: "round", join: "round", miterLimit: 6 },
      markerStroke: { cap: "butt", join: "miter", miterLimit: 4 },
    }).resolve(
      {
        className: "person",
        keypoints: {
          edges: [[0, 1]],
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
          visibility: [KeypointVisibility.Occluded, KeypointVisibility.Visible],
        },
      },
      context,
    );

    expect(instruction?.markers[0]).toMatchObject({
      fill: { color: 0xabcdef },
      shape: KeypointMarkerShape.Cross,
      stroke: { cap: "butt", join: "miter", miterLimit: 4 },
    });
    expect(instruction?.edges[0]).toMatchObject({
      shadowStroke: {
        cap: "square",
        color: 0x000000,
        join: "bevel",
        miterLimit: 8,
      },
      stroke: {
        cap: "round",
        color: 0x123456,
        join: "round",
        miterLimit: 6,
      },
    });
  });

  it("inks an occluded keypoint's cross in the point's own color", () => {
    const style = new BaseKeypointStyle({
      definitions: {
        person: {
          edges: [],
          vertices: [
            { id: 0, name: "a", color: 0xabcdef },
            { id: 1, name: "b" },
            { id: 2, name: "c" },
          ],
        },
      },
      markerFill: { alpha: 0.4, color: 0x22c55e },
      markerStroke: { alpha: 1, color: 0xffffff, width: 1 },
      radius: 3.5,
    });
    const markers = style.resolve(
      {
        className: "person",
        keypoints: {
          edges: [],
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
          visibility: [
            KeypointVisibility.Occluded,
            KeypointVisibility.Occluded,
            KeypointVisibility.Visible,
          ],
        },
      },
      context,
    )?.markers;

    // The vertex color, or the marker fill without one; a third of the
    // marker's diameter wide, so it reads as solidly as a filled point.
    expect(markers?.[0]?.stroke).toEqual({
      alpha: 0.4,
      color: 0xabcdef,
      width: 7 / 3,
    });
    expect(markers?.[1]?.stroke).toEqual({
      alpha: 0.4,
      color: 0x22c55e,
      width: 7 / 3,
    });
    // A visible point keeps the contrast ring around its filled disc.
    expect(markers?.[2]).toMatchObject({
      fill: { alpha: 0.4, color: 0x22c55e },
      shape: KeypointMarkerShape.Circle,
      stroke: { alpha: 1, color: 0xffffff, width: 1 },
    });
  });
});
