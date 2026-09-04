import { describe, expect, it } from "vitest";

import { KeypointVisibility, type DetectionFrame } from "supervision-js-core";

import {
  createReactNativeGhostCoachState,
  evaluateReactNativeGhostCoach,
} from "./ghost-coach";

function movementFrame(wristX: number): DetectionFrame {
  const points = Array.from({ length: 17 }, (_, index) => ({
    x: 100 + (index % 2) * 36,
    y: 80 + Math.floor(index / 2) * 18,
  }));
  // This is deliberately not a squat: the left wrist sweeps across the body.
  points[5] = { x: 88, y: 120 };
  points[6] = { x: 148, y: 120 };
  points[11] = { x: 96, y: 200 };
  points[12] = { x: 140, y: 200 };
  points[9] = { x: wristX, y: 100 };
  points[13] = { x: 92, y: 245 };
  points[14] = { x: 144, y: 245 };
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
  it("records an arbitrary movement until the user explicitly finishes", () => {
    const state = createReactNativeGhostCoachState();
    const recording = {
      active: true,
      intent: "recording" as const,
      reference: null,
    };

    let recorded = null;
    for (let nowMs = 0; nowMs <= 9_000; nowMs += 60) {
      recorded = evaluateReactNativeGhostCoach({
        config: recording,
        frame: movementFrame(70 + (nowMs % 480) / 8),
        nowMs,
        state,
      });
    }

    // Time alone never completes the reference; Finish recording does.
    expect(recorded?.runtime.status).toBe("recording");
    expect(recorded?.reference).toBeNull();
    const finished = evaluateReactNativeGhostCoach({
      config: { active: true, intent: "finish-recording", reference: null },
      frame: movementFrame(120),
      nowMs: 9_060,
      state,
    });

    expect(finished.runtime.status).toBe("ready");
    expect(finished.reference?.samples.length).toBeGreaterThanOrEqual(8);
    const coaching = evaluateReactNativeGhostCoach({
      config: { active: true, intent: "coach", reference: null },
      frame: movementFrame(120),
      nowMs: 9_120,
      state,
    });

    expect(coaching.runtime.status).toBe("coaching");
    expect(coaching.keypoints).toHaveLength(3);
    expect(coaching.keypoints[2]?.markers.length).toBeGreaterThan(10);
    expect(coaching.runtime.match).toBeGreaterThan(95);
    expect(coaching.runtime.progress).toBeGreaterThanOrEqual(0);
  });
});
