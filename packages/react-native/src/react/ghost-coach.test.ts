import { describe, expect, it } from "vitest";

import { KeypointVisibility, type DetectionFrame } from "supervision-js-core";

import {
  createReactNativeGhostCoachState,
  evaluateReactNativeGhostCoach,
} from "./ghost-coach";

function squatFrame(kneeY: number): DetectionFrame {
  const points = Array.from({ length: 17 }, (_, index) => ({
    x: 100 + (index % 2) * 36,
    y: 80 + Math.floor(index / 2) * 18,
  }));
  // Shoulders / hips / knees / ankles describe a person in a fixed camera.
  points[5] = { x: 88, y: 120 };
  points[6] = { x: 148, y: 120 };
  points[11] = { x: 96, y: 200 };
  points[12] = { x: 140, y: 200 };
  points[13] = { x: 92, y: kneeY };
  points[14] = { x: 144, y: kneeY };
  points[15] = { x: 90, y: 300 };
  points[16] = { x: 146, y: 300 };
  return {
    detections: [
      {
        className: "person",
        id: "athlete",
        keypoints: {
          edges: [],
          points,
          visibility: points.map(() => KeypointVisibility.Visible),
        },
      },
    ],
    frameIndex: 1,
    mediaTime: 0,
  };
}

describe("evaluateReactNativeGhostCoach", () => {
  it("learns normalized landmarks and renders the vector ghost during coaching", () => {
    const state = createReactNativeGhostCoachState();
    const capture = {
      active: true,
      intent: "capture" as const,
      reference: null,
    };

    let learned = null;
    for (let nowMs = 0; nowMs <= 2400; nowMs += 300) {
      learned = evaluateReactNativeGhostCoach({
        config: capture,
        frame: squatFrame(nowMs % 600 === 0 ? 255 : 230),
        nowMs,
        state,
      });
    }

    expect(learned?.reference?.samples.length).toBeGreaterThanOrEqual(8);
    const coaching = evaluateReactNativeGhostCoach({
      config: { active: true, intent: "coach", reference: null },
      frame: squatFrame(242),
      nowMs: 2600,
      state,
    });

    expect(coaching.runtime.status).toBe("coaching");
    expect(coaching.keypoints).toHaveLength(3);
    expect(coaching.keypoints[2]?.markers.length).toBeGreaterThan(10);
  });
});
