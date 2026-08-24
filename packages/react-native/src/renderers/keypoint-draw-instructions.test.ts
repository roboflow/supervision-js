import { describe, expect, it } from "vitest";

import {
  KeypointVisibility,
  resolveDetectionClassColorStyle,
  type DetectionFrame,
} from "supervision-js-core";

import { createReactNativeKeypointDrawInstructions } from "./keypoint-draw-instructions";

const points = [
  { x: 10, y: 20 },
  { x: 30, y: 40 },
];

describe("createReactNativeKeypointDrawInstructions", () => {
  it("colors each skeleton by its own class", () => {
    // The producer contract carries `className` per detection, so two classes
    // in one frame must not collapse to a single color.
    const frame: DetectionFrame = {
      detections: [
        { className: "worker", keypoints: { edges: [[0, 1]], points } },
        { className: "forklift", keypoints: { edges: [[0, 1]], points } },
      ],
      mediaTime: 0,
    };

    const [worker, forklift] = createReactNativeKeypointDrawInstructions(frame);

    expect(worker!.markers[0]!.fill!.color).toBe(
      resolveDetectionClassColorStyle("worker").fill,
    );
    expect(forklift!.markers[0]!.fill!.color).toBe(
      resolveDetectionClassColorStyle("forklift").fill,
    );
    expect(worker!.markers[0]!.fill!.color).not.toBe(
      forklift!.markers[0]!.fill!.color,
    );
    // Edges and markers agree, so a skeleton never draws in two colors.
    expect(worker!.edges[0]!.stroke.color).toBe(
      worker!.markers[0]!.fill!.color,
    );
  });

  it("lets an explicit color override every detection", () => {
    const frame: DetectionFrame = {
      detections: [
        { className: "worker", keypoints: { edges: [[0, 1]], points } },
        { className: "forklift", keypoints: { edges: [[0, 1]], points } },
      ],
      mediaTime: 0,
    };

    const instructions = createReactNativeKeypointDrawInstructions(
      frame,
      0x123456,
    );

    for (const instruction of instructions) {
      expect(instruction.markers[0]!.fill!.color).toBe(0x123456);
      expect(instruction.edges[0]!.stroke.color).toBe(0x123456);
    }
  });

  it("falls back to the person color for an unlabeled detection", () => {
    const [instruction] = createReactNativeKeypointDrawInstructions({
      detections: [{ keypoints: { edges: [], points } }],
      mediaTime: 0,
    });

    expect(instruction!.markers[0]!.fill!.color).toBe(
      resolveDetectionClassColorStyle("person").fill,
    );
  });

  it("drops an edge whose index is outside the point list", () => {
    // An open producer supplies its own skeleton; a bad index used to reach
    // the vector lane as an undefined point rather than being skipped.
    const [instruction] = createReactNativeKeypointDrawInstructions({
      detections: [
        {
          className: "worker",
          keypoints: {
            edges: [
              [0, 1],
              [0, 7],
              [-1, 0],
            ],
            points,
          },
        },
      ],
      mediaTime: 0,
    });

    expect(instruction!.edges).toHaveLength(1);
    expect(instruction!.edges[0]).toMatchObject({
      from: points[0],
      to: points[1],
    });
  });

  it("skips unlabeled points and detections without keypoints", () => {
    const instructions = createReactNativeKeypointDrawInstructions({
      detections: [
        { className: "box", rect: { height: 1, width: 1, x: 0, y: 0 } },
        {
          className: "worker",
          keypoints: {
            edges: [],
            points: [...points, { x: 50, y: 60 }],
            visibility: [
              KeypointVisibility.Visible,
              KeypointVisibility.Occluded,
              KeypointVisibility.NotLabeled,
            ],
          },
        },
      ],
      mediaTime: 0,
    });

    // The box detection produces no instruction at all, and the unlabeled
    // point is the only one of three dropped — occluded still draws.
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.markers.map((marker) => marker.index)).toEqual([
      0, 1,
    ]);
  });
});
