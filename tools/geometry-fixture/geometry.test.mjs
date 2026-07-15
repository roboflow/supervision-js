import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COCO_SKELETON_EDGES_ONE_BASED,
  KEYPOINT_VISIBILITY_NOT_LABELED,
  KEYPOINT_VISIBILITY_VISIBLE,
  convertOneBasedEdges,
  normalizePoseDetection,
  simplifyPolygonPoints,
  summarizeFrameGeometry,
  xyxyToCenterRect,
} from "./geometry.mjs";

describe("xyxyToCenterRect", () => {
  it("converts corner boxes into center-based rects", () => {
    assert.deepEqual(xyxyToCenterRect([100, 200, 300, 500]), {
      height: 300,
      width: 200,
      x: 200,
      y: 350,
    });
  });

  it("rejects empty and inverted boxes", () => {
    assert.equal(xyxyToCenterRect([100, 200, 100, 500]), undefined);
    assert.equal(xyxyToCenterRect([300, 200, 100, 500]), undefined);
  });
});

describe("convertOneBasedEdges", () => {
  it("converts COCO one-based skeleton edges to zero-based pairs", () => {
    const edges = convertOneBasedEdges(COCO_SKELETON_EDGES_ONE_BASED, 17);

    assert.equal(edges.length, COCO_SKELETON_EDGES_ONE_BASED.length);
    assert.deepEqual(edges[0], [15, 13]);
    assert.deepEqual(edges.at(-1), [4, 6]);
    assert.ok(
      edges.every(([from, to]) => from >= 0 && from < 17 && to >= 0 && to < 17),
    );
  });

  it("rejects edges outside the vertex range instead of drawing off-by-one skeletons", () => {
    assert.throws(() => convertOneBasedEdges([[0, 1]], 17));
    assert.throws(() => convertOneBasedEdges([[1, 18]], 17));
  });
});

describe("simplifyPolygonPoints", () => {
  it("drops collinear contour points", () => {
    const points = Array.from({ length: 30 }, (_, index) =>
      index < 15 ? { x: index * 10, y: 0 } : { x: (29 - index) * 10, y: 40 },
    );
    const simplified = simplifyPolygonPoints(points, { maxPoints: 16 });

    assert.ok(simplified);
    assert.ok(simplified.length <= 8);
    assert.ok(simplified.length >= 3);
  });

  it("bounds pathological zig-zag contours to the configured maximum", () => {
    const pathological = Array.from({ length: 5000 }, (_, index) => ({
      x: index,
      y: index % 2 === 0 ? 0 : 500,
    }));
    const simplified = simplifyPolygonPoints(pathological, { maxPoints: 48 });

    assert.ok(simplified);
    assert.ok(simplified.length <= 48);
  });

  it("is deterministic and returns integer media-pixel points", () => {
    const points = Array.from({ length: 200 }, (_, index) => ({
      x: 100 + 50 * Math.cos((index / 200) * Math.PI * 2),
      y: 100 + 80 * Math.sin((index / 200) * Math.PI * 2),
    }));
    const first = simplifyPolygonPoints(points, { maxPoints: 24 });
    const second = simplifyPolygonPoints(points, { maxPoints: 24 });

    assert.deepEqual(first, second);
    assert.ok(first.length <= 24);
    assert.ok(
      first.every(
        (point) => Number.isInteger(point.x) && Number.isInteger(point.y),
      ),
    );
  });

  it("returns undefined for degenerate contours", () => {
    assert.equal(
      simplifyPolygonPoints([
        { x: 0, y: 0 },
        { x: 0.2, y: 0.1 },
      ]),
      undefined,
    );
  });
});

describe("normalizePoseDetection", () => {
  const rawDetection = {
    confidence: 0.91,
    keypoints: {
      confidence: Array.from({ length: 17 }, (_, index) =>
        index < 13 ? 0.9 : 0.1,
      ),
      xy: Array.from({ length: 17 }, (_, index) => [100 + index, 200 + index]),
    },
    xyxy: [50, 100, 150, 300],
  };

  it("normalizes model output into a supervision-js keypoint detection", () => {
    const detection = normalizePoseDetection(rawDetection, {
      frameIndex: 12,
      personIndex: 3,
    });

    assert.equal(detection.id, "pose:12:3");
    assert.equal(detection.className, "person");
    assert.equal(detection.confidence, 0.91);
    assert.deepEqual(detection.rect, {
      height: 200,
      width: 100,
      x: 100,
      y: 200,
    });
    assert.equal(detection.keypoints.points.length, 17);
    assert.equal(detection.zIndex, 103);
  });

  it("applies the visibility threshold without inventing occlusion", () => {
    const detection = normalizePoseDetection(rawDetection, {
      frameIndex: 0,
      personIndex: 0,
    });
    const visibility = detection.keypoints.visibility;

    assert.ok(
      visibility
        .slice(0, 13)
        .every((value) => value === KEYPOINT_VISIBILITY_VISIBLE),
    );
    assert.ok(
      visibility
        .slice(13)
        .every((value) => value === KEYPOINT_VISIBILITY_NOT_LABELED),
    );
  });

  it("keeps only skeleton edges whose endpoints are both visible", () => {
    const detection = normalizePoseDetection(rawDetection, {
      frameIndex: 0,
      personIndex: 0,
    });

    // Keypoints 13..16 (zero-based) are below the confidence threshold, so
    // every ankle/knee edge referencing them must be dropped.
    assert.ok(detection.keypoints.edges.length > 0);
    assert.ok(
      detection.keypoints.edges.every(([from, to]) => from < 13 && to < 13),
    );
  });

  it("drops detections with no visible keypoints", () => {
    const detection = normalizePoseDetection(
      {
        ...rawDetection,
        keypoints: {
          ...rawDetection.keypoints,
          confidence: Array.from({ length: 17 }, () => 0.05),
        },
      },
      { frameIndex: 0, personIndex: 0 },
    );

    assert.equal(detection, undefined);
  });
});

describe("summarizeFrameGeometry", () => {
  it("counts detections per geometry type instead of assuming masks", () => {
    const frames = [
      {
        detections: [
          { mask: {}, polygon: {}, rect: {} },
          { keypoints: {}, rect: {} },
          { polyline: {} },
        ],
        mediaTime: 0,
      },
    ];

    assert.deepEqual(summarizeFrameGeometry(frames), {
      boxDetectionCount: 2,
      keypointDetectionCount: 1,
      maskDetectionCount: 1,
      polygonDetectionCount: 1,
      polylineDetectionCount: 1,
    });
  });
});
