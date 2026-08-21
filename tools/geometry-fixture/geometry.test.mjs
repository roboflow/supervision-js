import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COCO_SKELETON_EDGES_ONE_BASED,
  DEFAULT_POSE_MATCH_IOU,
  KEYPOINT_VISIBILITY_NOT_LABELED,
  KEYPOINT_VISIBILITY_VISIBLE,
  associateHeadDetectionsToPlayers,
  attachPoseKeypointsToDetections,
  convertOneBasedEdges,
  createContainedSmoothedRect,
  createTemporallyStabilizedRects,
  normalizePoseDetection,
  selectMotionGatedDetection,
  simplifyPolygonPoints,
  summarizeFrameGeometry,
  stabilizeHeadDetectionFrames,
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

describe("selectMotionGatedDetection", () => {
  const previousObservation = { mediaTime: 1, x: 100, y: 100 };

  it("keeps the spatially continuous candidate when source ids swap", () => {
    const selected = selectMotionGatedDetection(
      [
        {
          confidence: 0.5,
          id: "sam:ball:0",
          rect: { height: 20, width: 20, x: 1000, y: 700 },
        },
        {
          confidence: 0.8,
          id: "sam:ball:1",
          rect: { height: 20, width: 20, x: 130, y: 110 },
        },
      ],
      previousObservation,
      1 + 1 / 30,
    );

    assert.equal(selected?.id, "sam:ball:1");
  });

  it("rejects a teleport instead of producing a false segment", () => {
    const selected = selectMotionGatedDetection(
      [
        {
          confidence: 0.9,
          id: "sam:ball:0",
          rect: { height: 20, width: 20, x: 600, y: 600 },
        },
      ],
      previousObservation,
      1 + 1 / 30,
    );

    assert.equal(selected, undefined);
  });

  it("uses confidence and source order only when starting a new trace", () => {
    const selected = selectMotionGatedDetection(
      [
        {
          confidence: 0.7,
          id: "sam:ball:0",
          rect: { height: 20, width: 20, x: 400, y: 400 },
        },
        {
          confidence: 0.9,
          id: "sam:ball:1",
          rect: { height: 20, width: 20, x: 900, y: 900 },
        },
      ],
      undefined,
      1,
    );

    assert.equal(selected?.id, "sam:ball:1");
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

describe("associateHeadDetectionsToPlayers", () => {
  const mask = { counts: "fixture", encoding: "compressedRle" };

  it("matches direct head masks one-to-one by the player top-center", () => {
    const leftPlayer = {
      className: "yellow team player",
      id: "yellow:0",
      rect: { height: 300, width: 120, x: 200, y: 300 },
    };
    const rightPlayer = {
      className: "white team player",
      id: "white:0",
      rect: { height: 320, width: 130, x: 275, y: 330 },
    };
    const leftHead = {
      className: "head",
      confidence: 0.84,
      id: "head:0",
      mask,
      rect: { height: 50, width: 40, x: 205, y: 165 },
    };
    const rightHead = {
      className: "head",
      confidence: 0.82,
      id: "head:1",
      mask,
      rect: { height: 48, width: 38, x: 270, y: 180 },
    };

    const result = associateHeadDetectionsToPlayers(
      [rightHead, leftHead],
      [leftPlayer, rightPlayer],
      {
        targetClassNames: ["white team player", "yellow team player"],
      },
    );

    assert.equal(result.matches.length, 2);
    assert.deepEqual(
      result.matches.map(({ head, player }) => [head.id, player.id]).sort(),
      [
        ["head:0", "yellow:0"],
        ["head:1", "white:0"],
      ],
    );
    assert.equal(result.unmatchedHeadCount, 0);
    assert.equal(result.unmatchedPlayerCount, 0);
  });

  it("drops audience heads and low-confidence candidates without changing masks", () => {
    const player = {
      className: "yellow team player",
      id: "yellow:0",
      rect: { height: 300, width: 120, x: 200, y: 300 },
    };
    const directHead = {
      className: "head",
      confidence: 0.81,
      id: "head:player",
      mask,
      rect: { height: 50, width: 40, x: 205, y: 165 },
    };
    const result = associateHeadDetectionsToPlayers(
      [
        directHead,
        {
          ...directHead,
          confidence: 0.2,
          id: "head:low-confidence",
        },
        {
          ...directHead,
          id: "head:audience",
          rect: { ...directHead.rect, x: 600 },
        },
      ],
      [player],
    );

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].head, directHead);
    assert.equal(result.matches[0].head.mask, mask);
    assert.equal(result.ignoredLowConfidenceHeadCount, 1);
    assert.equal(result.unmatchedHeadCount, 1);
  });

  it("keeps an exact repeated mask with its previous player", () => {
    const leftPlayer = {
      className: "yellow team player",
      id: "yellow:0",
      rect: { height: 200, width: 80, x: 100, y: 180 },
    };
    const rightPlayer = {
      className: "white team player",
      id: "white:0",
      rect: { height: 200, width: 80, x: 130, y: 180 },
    };
    const repeatedHead = {
      className: "head",
      confidence: 0.8,
      id: "raw:repeated",
      mask: { ...mask, counts: "stable-mask" },
      rect: { height: 40, width: 30, x: 119, y: 95 },
    };
    const competingHead = {
      ...repeatedHead,
      id: "raw:competing",
      mask: { ...mask, counts: "new-mask" },
      rect: { ...repeatedHead.rect, x: 111 },
    };

    const result = associateHeadDetectionsToPlayers(
      [repeatedHead, competingHead],
      [leftPlayer, rightPlayer],
      {
        frameIndex: 11,
        previousAssignments: new Map([
          [
            "yellow:0",
            {
              frameIndex: 10,
              maskSignature: "x:stable-mask",
              relativeCenter: { x: 0.2, y: 0.075 },
              relativeHeight: 0.2,
              relativeWidth: 0.375,
            },
          ],
        ]),
        targetClassNames: ["white team player", "yellow team player"],
      },
    );

    assert.equal(
      result.matches.find(({ player }) => player.id === "yellow:0")?.head.id,
      "raw:repeated",
    );
  });

  it("does not transfer a repeated mask to a different player", () => {
    const repeatedHead = {
      className: "head",
      confidence: 0.8,
      id: "raw:repeated",
      mask: { ...mask, counts: "stable-mask" },
      rect: { height: 40, width: 30, x: 130, y: 95 },
    };
    const result = associateHeadDetectionsToPlayers(
      [repeatedHead],
      [
        {
          className: "white team player",
          id: "white:0",
          rect: { height: 200, width: 80, x: 130, y: 180 },
        },
      ],
      {
        frameIndex: 11,
        previousMaskOwners: new Map([
          ["x:stable-mask", { frameIndex: 10, playerId: "yellow:0" }],
        ]),
        targetClassNames: ["white team player"],
      },
    );

    assert.equal(result.matches.length, 0);
  });
});

describe("stabilizeHeadDetectionFrames", () => {
  const mask = {
    counts: "fixture",
    encoding: "compressedRle",
    height: 300,
    width: 400,
  };
  const player = (frameIndex) => ({
    className: "yellow team player",
    id: "yellow:0",
    rect: { height: 200, width: 80, x: 100 + frameIndex * 2, y: 180 },
  });
  const head = (frameIndex, confidence) => ({
    className: "head",
    confidence,
    id: `raw:${frameIndex}`,
    mask,
    rect: { height: 40, width: 30, x: 100 + frameIndex * 2, y: 95 },
  });

  it("continues an established track through low confidence and a short gap", () => {
    const result = stabilizeHeadDetectionFrames(
      [
        {
          frameIndex: 0,
          headDetections: [head(0, 0.8)],
          playerDetections: [player(0)],
        },
        {
          frameIndex: 1,
          headDetections: [],
          playerDetections: [],
        },
        {
          frameIndex: 2,
          headDetections: [head(2, 0.55)],
          playerDetections: [player(2)],
        },
      ],
      {
        fillGap: ({ sourceHead, sourcePlayer, targetPlayer }) => ({
          ...sourceHead,
          rect: {
            ...sourceHead.rect,
            x: sourceHead.rect.x + targetPlayer.rect.x - sourcePlayer.rect.x,
          },
        }),
        sourceId: "sam3-head",
        targetClassNames: ["yellow team player"],
      },
    );
    const detections = [0, 1, 2].map(
      (frameIndex) => result.detectionsByFrame.get(frameIndex)[0],
    );

    assert.deepEqual(
      detections.map((detection) => detection.id),
      ["head:yellow:0", "head:yellow:0", "head:yellow:0"],
    );
    assert.deepEqual(
      detections.map((detection) => detection.trackerId),
      [1, 1, 1],
    );
    assert.equal(detections[1].metadata.headObservation, "gap-filled");
    assert.equal(detections[1].metadata.rawMaskRect.x, 102);
    assert.equal(detections[2].metadata.headObservation, "observed");
    assert.equal(result.summary.gapFilledHeadCount, 1);
    assert.equal(result.summary.continuedLowConfidenceHeadCount, 1);
  });

  it("uses the other boundary when the nearest mask cannot be translated", () => {
    const result = stabilizeHeadDetectionFrames(
      [
        {
          frameIndex: 0,
          headDetections: [head(0, 0.8)],
          playerDetections: [player(0)],
        },
        { frameIndex: 1, headDetections: [], playerDetections: [] },
        {
          frameIndex: 2,
          headDetections: [head(2, 0.8)],
          playerDetections: [player(2)],
        },
      ],
      {
        fillGap: ({ sourceHead }) =>
          sourceHead.id === "raw:0"
            ? undefined
            : {
                ...sourceHead,
                metadata: { gapFillBoundary: "next" },
              },
        sourceId: "sam3-head",
        targetClassNames: ["yellow team player"],
      },
    );

    assert.equal(
      result.detectionsByFrame.get(1)[0].metadata.gapFillBoundary,
      "next",
    );
    assert.equal(result.summary.gapFilledHeadCount, 1);
  });

  it("pads and smooths crops without excluding current mask bounds", () => {
    const previous = { height: 60, width: 50, x: 100, y: 100 };
    const maskRect = { height: 40, width: 30, x: 130, y: 115 };
    const result = createContainedSmoothedRect(maskRect, previous, {
      padding: 6,
      smoothing: 0.2,
    });

    assert.ok(result.x - result.width / 2 <= maskRect.x - 21);
    assert.ok(result.x + result.width / 2 >= maskRect.x + 21);
    assert.ok(result.y - result.height / 2 <= maskRect.y - 26);
    assert.ok(result.y + result.height / 2 >= maskRect.y + 26);
  });
});

describe("createTemporallyStabilizedRects", () => {
  it("anticipates local growth while containing every current mask", () => {
    const observations = [
      { frameIndex: 0, rect: { height: 20, width: 18, x: 100, y: 100 } },
      { frameIndex: 1, rect: { height: 22, width: 20, x: 102, y: 101 } },
      { frameIndex: 2, rect: { height: 44, width: 40, x: 106, y: 103 } },
      { frameIndex: 3, rect: { height: 22, width: 20, x: 108, y: 104 } },
    ];
    const stabilized = createTemporallyStabilizedRects(observations, {
      padding: 0,
      windowRadius: 2,
    });

    assert.equal(stabilized.get(1).width, 40);
    for (const observation of observations) {
      const crop = stabilized.get(observation.frameIndex);
      assert.ok(crop);
      assert.ok(
        crop.x - crop.width / 2 <=
          observation.rect.x - observation.rect.width / 2,
      );
      assert.ok(
        crop.x + crop.width / 2 >=
          observation.rect.x + observation.rect.width / 2,
      );
      assert.ok(
        crop.y - crop.height / 2 <=
          observation.rect.y - observation.rect.height / 2,
      );
      assert.ok(
        crop.y + crop.height / 2 >=
          observation.rect.y + observation.rect.height / 2,
      );
    }
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

describe("attachPoseKeypointsToDetections", () => {
  const keypoints = {
    edges: [[0, 1]],
    points: [
      { x: 90, y: 90 },
      { x: 110, y: 110 },
    ],
    visibility: [2, 2],
  };

  it("merges each pose into one overlapping team detection", () => {
    const teamDetection = {
      className: "yellow team player",
      confidence: 0.95,
      id: "sam:yellow:0",
      mask: { counts: "fixture" },
      metadata: { sam3Prompt: "yellow team player" },
      polygon: { points: [] },
      rect: { height: 100, width: 80, x: 100, y: 100 },
      sourceId: "sam3",
    };
    const result = attachPoseKeypointsToDetections(
      [teamDetection],
      [
        {
          className: "person",
          confidence: 0.9,
          id: "pose:0:0",
          keypoints,
          rect: { height: 100, width: 80, x: 102, y: 101 },
          sourceId: "yolo-pose",
        },
      ],
      {
        minimumIou: DEFAULT_POSE_MATCH_IOU,
        targetClassNames: ["white team player", "yellow team player"],
      },
    );

    assert.equal(result.matchedPoseCount, 1);
    assert.equal(result.unmatchedPoseCount, 0);
    assert.equal(result.unmatchedTargetCount, 0);
    assert.equal(result.detections.length, 1);
    assert.equal(result.detections[0].className, "yellow team player");
    assert.equal(result.detections[0].id, "sam:yellow:0");
    assert.equal(result.detections[0].sourceId, "sam3");
    assert.equal(result.detections[0].keypoints, keypoints);
    assert.deepEqual(result.detections[0].metadata.poseDetection, {
      confidence: 0.9,
      id: "pose:0:0",
      matchIou: 0.9328,
      sourceId: "yolo-pose",
    });
  });

  it("does not duplicate a pose or retain unmatched person detections", () => {
    const result = attachPoseKeypointsToDetections(
      [
        {
          className: "white team player",
          id: "sam:white:0",
          rect: { height: 100, width: 80, x: 100, y: 100 },
        },
        {
          className: "yellow team player",
          id: "sam:yellow:0",
          rect: { height: 100, width: 80, x: 104, y: 100 },
        },
        {
          className: "basketball",
          id: "sam:ball:0",
          rect: { height: 20, width: 20, x: 100, y: 100 },
        },
      ],
      [
        {
          className: "person",
          id: "pose:0:0",
          keypoints,
          rect: { height: 100, width: 80, x: 100, y: 100 },
        },
        {
          className: "person",
          id: "pose:0:1",
          keypoints,
          rect: { height: 40, width: 40, x: 500, y: 500 },
        },
      ],
      {
        minimumIou: DEFAULT_POSE_MATCH_IOU,
        targetClassNames: ["white team player", "yellow team player"],
      },
    );

    assert.equal(result.matchedPoseCount, 1);
    assert.equal(result.unmatchedPoseCount, 1);
    assert.equal(result.unmatchedTargetCount, 1);
    assert.equal(result.detections.length, 3);
    assert.equal(
      result.detections.filter((detection) => detection.keypoints).length,
      1,
    );
    assert.equal(
      result.detections.some((detection) => detection.className === "person"),
      false,
    );
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
