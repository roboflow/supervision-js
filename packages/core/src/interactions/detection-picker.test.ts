import { describe, expect, it } from "vitest";

import {
  createDetectionPickKey,
  followDetectionPickAcrossFrames,
  haveSameDetectionPickIdentities,
  pickDetectionByMaskId,
  pickDetectionAtPoint,
  rebaseDetectionPickToFrame,
} from "#interactions/detection-picker";
import {
  DetectionMaskEncoding,
  KeypointVisibility,
  type DetectionMask,
} from "#types/detections";
import { DetectionPickTarget } from "#types/interaction";
import type { DetectionFrame } from "#types/detections";
import { encodeBinaryMask } from "#utils/detection-masks";

const frame: DetectionFrame = {
  detections: [
    {
      className: "person",
      id: "large",
      rect: { height: 100, width: 100, x: 50, y: 50 },
    },
    {
      className: "ball",
      id: "small",
      rect: { height: 10, width: 10, x: 50, y: 50 },
    },
  ],
  frameIndex: 12,
  mediaTime: 0.4,
};

describe("detection picker", () => {
  it("picks the smallest containing box so small objects win inside overlaps", () => {
    const pick = pickDetectionAtPoint(frame, { x: 50, y: 50 });

    expect(pick).toMatchObject({
      detection: expect.objectContaining({ id: "small" }),
      detectionIndex: 1,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 50, y: 50 },
      target: DetectionPickTarget.Box,
    });
  });

  it("supports padding around tiny boxes and creates stable pick keys", () => {
    const pick = pickDetectionAtPoint(frame, { x: 42, y: 42 }, { padding: 4 });

    expect(pick?.detection.id).toBe("small");
    expect(pick ? createDetectionPickKey(pick) : null).toBe(
      "12:0.4:id:string:small:box:geometry",
    );
  });

  it("returns null outside pickable detections", () => {
    expect(pickDetectionAtPoint(frame, { x: 120, y: 120 })).toBeNull();
  });

  it("picks the detection encoded by a prepared mask id", () => {
    const pick = pickDetectionByMaskId(frame, 2, { x: 47, y: 49 });

    expect(pick).toMatchObject({
      detection: expect.objectContaining({ id: "small" }),
      detectionIndex: 1,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 47, y: 49 },
      target: DetectionPickTarget.Mask,
    });
  });

  it("ignores background or out-of-range prepared mask ids", () => {
    expect(pickDetectionByMaskId(frame, 0, { x: 47, y: 49 })).toBeNull();
    expect(pickDetectionByMaskId(frame, 99, { x: 47, y: 49 })).toBeNull();
  });

  it("picks polygons, polylines, keypoints, edges, and semantic masks", () => {
    const mixedFrame: DetectionFrame = {
      detections: [
        {
          id: "polygon",
          polygon: {
            points: [
              { x: 0, y: 0 },
              { x: 20, y: 0 },
              { x: 20, y: 20 },
              { x: 0, y: 20 },
            ],
          },
        },
        {
          id: "polyline",
          polyline: {
            points: [
              { x: 30, y: 0 },
              { x: 30, y: 20 },
            ],
          },
        },
        {
          id: "skeleton",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 50, y: 5 },
              { x: 60, y: 5 },
              { x: 70, y: 5 },
            ],
            visibility: [
              KeypointVisibility.Visible,
              KeypointVisibility.Visible,
              KeypointVisibility.NotLabeled,
            ],
          },
        },
        {
          id: "mask",
          mask: encodeBinaryMask(Uint8Array.from([1, 0, 0, 0]), 2, 2),
        },
      ],
      mediaTime: 0,
    };

    expect(pickDetectionAtPoint(mixedFrame, { x: 10, y: 10 })?.target).toBe(
      DetectionPickTarget.Polygon,
    );
    expect(pickDetectionAtPoint(mixedFrame, { x: 32, y: 10 })?.target).toBe(
      DetectionPickTarget.Polyline,
    );
    expect(pickDetectionAtPoint(mixedFrame, { x: 50, y: 5 })).toMatchObject({
      geometryIndex: 0,
      target: DetectionPickTarget.Keypoint,
    });
    expect(
      pickDetectionAtPoint(mixedFrame, { x: 55, y: 5 }, { keypointPadding: 1 }),
    ).toMatchObject({
      geometryIndex: 0,
      target: DetectionPickTarget.Edge,
    });
    expect(pickDetectionAtPoint(mixedFrame, { x: 0, y: 0 })?.target).toBe(
      DetectionPickTarget.Mask,
    );
  });

  it("keeps skeleton edges pickable inside overlapping area geometry", () => {
    const overlappingFrame: DetectionFrame = {
      detections: [
        {
          id: "player-polygon",
          polygon: {
            points: [
              { x: 98, y: 195 },
              { x: 104, y: 195 },
              { x: 104, y: 205 },
              { x: 98, y: 205 },
            ],
          },
          rect: { height: 10, width: 6, x: 101, y: 200 },
        },
        {
          id: "player-pose",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 100, y: 100 },
              { x: 100, y: 300 },
            ],
          },
          rect: { height: 400, width: 200, x: 100, y: 200 },
        },
      ],
      mediaTime: 0,
    };

    expect(
      pickDetectionAtPoint(overlappingFrame, { x: 102, y: 200 }),
    ).toMatchObject({
      geometryIndex: 0,
      target: DetectionPickTarget.Edge,
    });
  });

  it("maps media-space points into lower-resolution masks and caches decoding", () => {
    const encoded = encodeBinaryMask(Uint8Array.from([0, 0, 0, 1]), 2, 2);
    let countsReads = 0;
    const mask = {
      encoding: DetectionMaskEncoding.CompressedRle,
      height: encoded.height,
      width: encoded.width,
      get counts() {
        countsReads += 1;
        return encoded.counts;
      },
    } satisfies DetectionMask;
    const maskFrame = {
      detections: [{ id: "scaled-mask", mask }],
      mediaTime: 0,
    } satisfies DetectionFrame;
    const options = { maskMediaDimensions: { height: 200, width: 200 } };

    expect(
      pickDetectionAtPoint(maskFrame, { x: 150, y: 150 }, options)?.detection
        .id,
    ).toBe("scaled-mask");
    expect(
      pickDetectionAtPoint(maskFrame, { x: 25, y: 25 }, options),
    ).toBeNull();
    expect(
      pickDetectionAtPoint(
        maskFrame,
        { x: 150, y: 150 },
        {
          ...options,
          includeMasks: false,
        },
      ),
    ).toBeNull();
    pickDetectionAtPoint(maskFrame, { x: 150, y: 150 }, options);

    expect(countsReads).toBe(1);
  });

  it("compares scaled masks against other geometry in media pixels", () => {
    const scaledFrame = {
      detections: [
        {
          id: "full-frame-mask",
          mask: encodeBinaryMask(Uint8Array.from([1, 1, 1, 1]), 2, 2),
        },
        {
          id: "small-box",
          rect: { height: 10, width: 10, x: 150, y: 150 },
        },
      ],
      mediaTime: 0,
    } satisfies DetectionFrame;

    expect(
      pickDetectionAtPoint(
        scaledFrame,
        { x: 150, y: 150 },
        { maskMediaDimensions: { height: 200, width: 200 } },
      )?.detection.id,
    ).toBe("small-box");
  });

  it("keeps id-based picks stable across reorder and honors z-order ties", () => {
    const originalPick = pickDetectionAtPoint(frame, { x: 50, y: 50 })!;
    const reordered: DetectionFrame = {
      ...frame,
      detections: [...frame.detections].reverse(),
    };
    const rebased = rebaseDetectionPickToFrame(originalPick, reordered);

    expect(rebased?.detection.id).toBe("small");
    expect(rebased?.detectionIndex).toBe(0);
    expect(createDetectionPickKey(rebased)).toBe(
      createDetectionPickKey(originalPick),
    );

    const tied = {
      detections: [
        { id: "low", rect: { height: 10, width: 10, x: 0, y: 0 }, zIndex: 1 },
        { id: "high", rect: { height: 10, width: 10, x: 0, y: 0 }, zIndex: 2 },
      ],
      mediaTime: 0,
    } satisfies DetectionFrame;
    expect(pickDetectionAtPoint(tied, { x: 5, y: 5 })?.detection.id).toBe(
      "high",
    );

    const renderOrdered = {
      detections: [
        { id: "first", rect: { height: 10, width: 10, x: 5, y: 5 } },
        {
          id: "explicit",
          rect: { height: 10, width: 10, x: 5, y: 5 },
          zIndex: 1,
        },
        { id: "last", rect: { height: 10, width: 10, x: 5, y: 5 } },
      ],
      mediaTime: 0,
    } satisfies DetectionFrame;
    expect(
      pickDetectionAtPoint(renderOrdered, { x: 5, y: 5 })?.detection.id,
    ).toBe("last");
  });

  it("follows a unique detection id onto a later frame", () => {
    const originalPick = pickDetectionAtPoint(frame, { x: 50, y: 50 })!;
    const laterFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "large",
          rect: { height: 100, width: 100, x: 70, y: 60 },
        },
        {
          className: "ball",
          id: "small",
          rect: { height: 10, width: 10, x: 90, y: 40 },
        },
      ],
      frameIndex: 13,
      mediaTime: 0.433,
    };

    expect(rebaseDetectionPickToFrame(originalPick, laterFrame)).toBeNull();

    const followed = followDetectionPickAcrossFrames(originalPick, laterFrame);

    expect(followed).toMatchObject({
      detection: laterFrame.detections[1],
      detectionIndex: 1,
      frame: laterFrame,
      mediaTime: 0.433,
      target: originalPick.target,
    });
  });

  it("follows ids across frames even when the detection order changes", () => {
    const originalPick = pickDetectionAtPoint(frame, { x: 50, y: 50 })!;
    const reorderedLaterFrame: DetectionFrame = {
      detections: [
        {
          className: "ball",
          id: "small",
          rect: { height: 10, width: 10, x: 90, y: 40 },
        },
        {
          className: "person",
          id: "large",
          rect: { height: 100, width: 100, x: 70, y: 60 },
        },
      ],
      frameIndex: 13,
      mediaTime: 0.433,
    };

    expect(
      followDetectionPickAcrossFrames(originalPick, reorderedLaterFrame),
    ).toMatchObject({
      detection: reorderedLaterFrame.detections[0],
      detectionIndex: 0,
    });
  });

  it("keeps a per-frame lifetime for picks without a followable identity", () => {
    const anonymousFrame: DetectionFrame = {
      detections: [{ rect: { height: 10, width: 10, x: 10, y: 10 } }],
      frameIndex: 0,
      mediaTime: 0,
    };
    const anonymousPick = pickDetectionAtPoint(anonymousFrame, {
      x: 10,
      y: 10,
    })!;
    const anonymousLaterFrame: DetectionFrame = {
      detections: [{ rect: { height: 10, width: 10, x: 10, y: 10 } }],
      frameIndex: 1,
      mediaTime: 0.033,
    };

    expect(
      followDetectionPickAcrossFrames(anonymousPick, anonymousLaterFrame),
    ).toBeNull();

    const duplicateIdFrame: DetectionFrame = {
      detections: [
        { id: "duplicate", rect: { height: 10, width: 10, x: 10, y: 10 } },
        { id: "duplicate", rect: { height: 10, width: 10, x: 30, y: 10 } },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const duplicatePick = pickDetectionAtPoint(duplicateIdFrame, {
      x: 10,
      y: 10,
    })!;
    const duplicateLaterFrame: DetectionFrame = {
      ...duplicateIdFrame,
      frameIndex: 1,
      mediaTime: 0.033,
    };

    expect(
      followDetectionPickAcrossFrames(duplicatePick, duplicateLaterFrame),
    ).toBeNull();
  });

  it("drops a followed pick when its detection leaves the timeline", () => {
    const originalPick = pickDetectionAtPoint(frame, { x: 50, y: 50 })!;
    const withoutBallFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "large",
          rect: { height: 100, width: 100, x: 70, y: 60 },
        },
      ],
      frameIndex: 13,
      mediaTime: 0.433,
    };

    expect(
      followDetectionPickAcrossFrames(originalPick, withoutBallFrame),
    ).toBeNull();
  });

  it("still rebases same-frame reloads through the follow helper", () => {
    const originalPick = pickDetectionAtPoint(frame, { x: 50, y: 50 })!;
    const reloadedFrame: DetectionFrame = {
      ...frame,
      detections: frame.detections.map((detection) => ({ ...detection })),
    };
    const followed = followDetectionPickAcrossFrames(
      originalPick,
      reloadedFrame,
    );

    expect(followed).toMatchObject({
      detection: reloadedFrame.detections[1],
      detectionIndex: 1,
    });
    expect(createDetectionPickKey(followed)).toBe(
      createDetectionPickKey(originalPick),
    );
  });

  it("uses the frame index for duplicate ids so interaction state does not collide", () => {
    const duplicateIds = {
      detections: [
        { id: "duplicate", rect: { height: 10, width: 10, x: 10, y: 10 } },
        { id: "duplicate", rect: { height: 10, width: 10, x: 30, y: 10 } },
      ],
      mediaTime: 0,
    } satisfies DetectionFrame;
    const first = pickDetectionAtPoint(duplicateIds, { x: 10, y: 10 });
    const second = pickDetectionAtPoint(duplicateIds, { x: 30, y: 10 });
    const cloned = {
      ...duplicateIds,
      detections: duplicateIds.detections.map((detection) => ({
        ...detection,
      })),
    } satisfies DetectionFrame;

    expect(createDetectionPickKey(first)).not.toBe(
      createDetectionPickKey(second),
    );
    expect(rebaseDetectionPickToFrame(second, cloned)).toMatchObject({
      detectionIndex: 1,
      detection: cloned.detections[1],
    });
  });

  it("keeps numeric and string ids as distinct selection identities", () => {
    const numericFrame = {
      detections: [{ id: 1, rect: { height: 10, width: 10, x: 10, y: 10 } }],
      frameIndex: 1,
      mediaTime: 0,
    } satisfies DetectionFrame;
    const stringFrame = {
      detections: [{ id: "1", rect: { height: 10, width: 10, x: 10, y: 10 } }],
      frameIndex: 2,
      mediaTime: 0.033,
    } satisfies DetectionFrame;
    const numericPick = pickDetectionAtPoint(numericFrame, { x: 10, y: 10 })!;
    const stringPick = pickDetectionAtPoint(stringFrame, { x: 10, y: 10 })!;

    expect(haveSameDetectionPickIdentities([numericPick], [numericPick])).toBe(
      true,
    );
    expect(haveSameDetectionPickIdentities([numericPick], [stringPick])).toBe(
      false,
    );
  });
});
