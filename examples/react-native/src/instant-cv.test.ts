import { describe, expect, it } from "vitest";

import {
  createInstantCvFreeShapeZone,
  createInstantCvGoldenPoseBaseline,
  createInstantCvRectangleZone,
  createInstantCvRuleVectorInstructions,
  evaluateInstantCvRules,
  normalizeInstantCvRect,
  pickInstantCvObjectAtPoint,
  pickInstantCvPoseAtPoint,
  resolveInstantCvInferenceMode,
  type InstantCvPosePoint,
  type InstantCvRule,
} from "./instant-cv";

function createPose(overrides: Partial<Record<number, [number, number]>> = {}) {
  const defaults: Record<number, [number, number]> = {
    5: [40, 30],
    6: [60, 30],
    7: [35, 50],
    8: [65, 50],
    9: [30, 70],
    10: [70, 70],
    11: [43, 65],
    12: [57, 65],
    13: [42, 85],
    14: [58, 85],
    15: [40, 105],
    16: [60, 105],
  };
  const points: InstantCvPosePoint[] = new Array(17)
    .fill(null)
    .map(() => ({ visible: false, x: 0, y: 0 }));

  for (const [index, coordinates] of Object.entries({
    ...defaults,
    ...overrides,
  })) {
    if (!coordinates) continue;

    points[Number(index)] = {
      visible: true,
      x: coordinates[0],
      y: coordinates[1],
    };
  }

  return { points };
}

describe("Instant CV rule engine", () => {
  it("routes only Golden Pose to the pose model", () => {
    expect(resolveInstantCvInferenceMode("golden-pose")).toBe("pose");
    expect(resolveInstantCvInferenceMode("safety-zone")).toBe("segmentation");
    expect(resolveInstantCvInferenceMode("clear-to-start")).toBe(
      "segmentation",
    );
  });

  it("normalizes a drawn zone regardless of drag direction", () => {
    expect(
      normalizeInstantCvRect({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 }),
    ).toEqual({
      height: 0.6,
      width: 0.6000000000000001,
      x: 0.2,
      y: 0.1,
    });
  });

  it("captures and evaluates a golden pose after its dwell", () => {
    const pose = createPose();
    const baselineAngles = createInstantCvGoldenPoseBaseline(pose.points);

    expect(baselineAngles).not.toBeNull();

    const rules: InstantCvRule[] = [
      {
        baselineAngles: baselineAngles!,
        baselinePoints: pose.points,
        dwellMs: 300,
        id: "pose",
        recipe: "golden-pose",
        toleranceDegrees: 12,
      },
    ];
    const first = evaluateInstantCvRules({
      frameHeight: 120,
      frameWidth: 100,
      nowMs: 1_000,
      poses: [pose],
      previous: [],
      rules,
    });
    const stable = evaluateInstantCvRules({
      frameHeight: 120,
      frameWidth: 100,
      nowMs: 1_350,
      poses: [pose],
      previous: first,
      rules,
    });

    expect(first[0]?.status).toBe("evaluating");
    expect(stable[0]).toMatchObject({ score: 0, status: "pass" });
  });

  it("fails a golden pose that exceeds the angle tolerance", () => {
    const baseline = createPose();
    const changed = createPose({ 9: [50, 50], 10: [50, 50] });
    const rules: InstantCvRule[] = [
      {
        baselineAngles: createInstantCvGoldenPoseBaseline(baseline.points)!,
        baselinePoints: baseline.points,
        dwellMs: 0,
        id: "pose",
        recipe: "golden-pose",
        toleranceDegrees: 5,
      },
    ];

    expect(
      evaluateInstantCvRules({
        frameHeight: 120,
        frameWidth: 100,
        nowMs: 1_000,
        poses: [changed],
        previous: [],
        rules,
      })[0]?.status,
    ).toBe("fail");
  });

  it("uses segmented person geometry for a safety zone", () => {
    const rules: InstantCvRule[] = [
      {
        dwellMs: 0,
        id: "zone",
        recipe: "safety-zone",
        zone: createInstantCvRectangleZone(
          { x: 0.3, y: 0.6 },
          { x: 0.7, y: 0.9 },
        ),
      },
    ];

    expect(
      evaluateInstantCvRules({
        frameHeight: 120,
        frameWidth: 100,
        nowMs: 1_000,
        objects: [
          {
            bbox: { x1: 40, x2: 60, y1: 70, y2: 110 },
            label: "person",
          },
        ],
        previous: [],
        rules,
      })[0]?.status,
    ).toBe("fail");
  });

  it("keeps clear-to-start blocked while the selected class is in the zone", () => {
    const rules: InstantCvRule[] = [
      {
        className: "bottle",
        dwellMs: 0,
        id: "clear",
        recipe: "clear-to-start",
        zone: createInstantCvRectangleZone({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }),
      },
    ];
    const blocked = evaluateInstantCvRules({
      frameHeight: 100,
      frameWidth: 100,
      nowMs: 1_000,
      objects: [
        {
          bbox: { x1: 10, x2: 30, y1: 10, y2: 40 },
          label: "bottle",
        },
      ],
      previous: [],
      rules,
    });
    const clear = evaluateInstantCvRules({
      frameHeight: 100,
      frameWidth: 100,
      nowMs: 1_010,
      objects: [],
      previous: blocked,
      rules,
    });

    expect(blocked[0]?.status).toBe("fail");
    expect(clear[0]?.status).toBe("pass");
  });

  it("prefers a mask hit and falls back to the smallest containing box", () => {
    const detections = [
      {
        bbox: { x1: 0, x2: 100, y1: 0, y2: 100 },
        label: "large",
        mask: Uint8Array.from([0, 0, 0, 1]),
        maskHeight: 2,
        maskWidth: 2,
      },
      {
        bbox: { x1: 40, x2: 60, y1: 40, y2: 60 },
        label: "small",
      },
    ];

    expect(
      pickInstantCvObjectAtPoint({
        detections,
        frameHeight: 100,
        frameWidth: 100,
        point: { x: 0.5, y: 0.5 },
      }),
    ).toEqual({ detectionIndex: 0, label: "large", usedMask: true });
    expect(
      pickInstantCvObjectAtPoint({
        detections,
        frameHeight: 100,
        frameWidth: 100,
        point: { x: 0.45, y: 0.45 },
      }),
    ).toEqual({ detectionIndex: 1, label: "small", usedMask: false });
  });

  it("picks the smallest pose containing a normalized touch", () => {
    expect(
      pickInstantCvPoseAtPoint({
        frameHeight: 120,
        frameWidth: 100,
        point: { x: 0.5, y: 0.5 },
        poses: [createPose(), createPose({ 5: [48, 45], 6: [52, 45] })],
      }),
    ).toBe(1);
  });

  it("prepares status-colored rule geometry in frame coordinates", () => {
    const pose = createPose();
    const rules: InstantCvRule[] = [
      {
        baselineAngles: createInstantCvGoldenPoseBaseline(pose.points)!,
        baselinePoints: pose.points.map((point) => ({
          ...point,
          x: point.x / 100,
          y: point.y / 120,
        })),
        dwellMs: 0,
        id: "pose",
        recipe: "golden-pose",
        toleranceDegrees: 12,
      },
      {
        dwellMs: 0,
        id: "zone",
        recipe: "safety-zone",
        zone: createInstantCvRectangleZone(
          { x: 0.1, y: 0.2 },
          { x: 0.6, y: 0.45 },
        ),
      },
    ];
    const instructions = createInstantCvRuleVectorInstructions({
      frameHeight: 120,
      frameWidth: 100,
      markerShape: "test-circle",
      rules,
      runtime: [
        {
          candidate: "pass",
          candidateSinceMs: 0,
          id: "pose",
          status: "pass",
        },
        {
          candidate: "fail",
          candidateSinceMs: 0,
          id: "zone",
          status: "fail",
        },
      ],
    });

    expect(instructions.keypoints[0]?.markers[0]).toMatchObject({
      fill: { color: 0x57f287 },
      shape: "test-circle",
    });
    expect(instructions.polygons[0]).toMatchObject({
      points: [
        { x: 10, y: 24 },
        { x: 60, y: 24 },
        { x: 60, y: 54 },
        { x: 10, y: 54 },
      ],
      stroke: { color: 0xff5d73 },
    });
  });

  it("creates and prepares a free-shape safety zone", () => {
    const zone = createInstantCvFreeShapeZone([
      { x: 0.1, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.6, y: 0.75 },
      { x: 0.2, y: 0.8 },
    ]);

    expect(zone).not.toBeNull();

    const rules: InstantCvRule[] = [
      {
        dwellMs: 0,
        id: "free-zone",
        recipe: "safety-zone",
        zone: zone!,
      },
    ];
    const instructions = createInstantCvRuleVectorInstructions({
      frameHeight: 200,
      frameWidth: 100,
      markerShape: "circle",
      rules,
      runtime: [],
    });

    expect(instructions.polygons[0]?.points).toEqual([
      { x: 10, y: 40 },
      { x: 80, y: 40 },
      { x: 60, y: 150 },
      { x: 20, y: 160 },
    ]);

    const runtime = evaluateInstantCvRules({
      frameHeight: 200,
      frameWidth: 100,
      nowMs: 1_000,
      objects: [
        {
          bbox: { x1: 35, x2: 55, y1: 70, y2: 130 },
          label: "person",
          mask: Uint8Array.from([1, 1, 1, 1]),
          maskHeight: 2,
          maskWidth: 2,
        },
      ],
      previous: [],
      rules,
    });

    expect(runtime[0]?.status).toBe("fail");

    expect(
      evaluateInstantCvRules({
        frameHeight: 200,
        frameWidth: 100,
        nowMs: 1_000,
        objects: [
          {
            bbox: { x1: 74, x2: 79, y1: 145, y2: 155 },
            label: "person",
            mask: Uint8Array.from([1, 1, 1, 1]),
            maskHeight: 2,
            maskWidth: 2,
          },
        ],
        previous: [],
        rules,
      })[0]?.status,
    ).toBe("pass");
  });
});
