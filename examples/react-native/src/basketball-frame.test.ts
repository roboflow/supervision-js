/// <reference types="node" />

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Detection } from "supervision-js-react-native";

import { basketballDetectionFrame } from "./basketball-frame";

interface GeometryFixture {
  readonly frames: readonly {
    readonly detections: readonly Pick<
      Detection,
      "className" | "confidence" | "keypoints" | "polygon"
    >[];
  }[];
}

describe("React Native basketball geometry fixture", () => {
  it("matches the committed first geometry frame exactly", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../demo/fixtures/basketball_sam3/detections/000000.json",
            import.meta.url,
          ).href,
        ),
        "utf8",
      ),
    ) as GeometryFixture;
    const sourceDetections = fixture.frames[0]!.detections;

    for (const detection of basketballDetectionFrame.detections) {
      // Five basketballs share a class name, so the example pins the one a
      // viewer would look at. Taking the first would tie this file to the
      // order a fixture rebuild happens to emit.
      const source = sourceDetections
        .filter((candidate) => candidate.className === detection.className)
        .sort(
          (left, right) => (right.confidence ?? 0) - (left.confidence ?? 0),
        )[0];

      expect(source, detection.className).toBeDefined();
      expect(detection.polygon).toEqual(source?.polygon);
      expect(detection.keypoints).toEqual(source?.keypoints);
    }
  });
});
