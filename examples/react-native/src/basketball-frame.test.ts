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
      "className" | "keypoints" | "polygon"
    >[];
  }[];
}

describe("React Native basketball geometry fixture", () => {
  it("matches the committed first geometry frame exactly", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../demo/fixtures/basketball_geometry/detections/000000.json",
            import.meta.url,
          ).href,
        ),
        "utf8",
      ),
    ) as GeometryFixture;
    const sourceDetections = fixture.frames[0]!.detections;

    for (const detection of basketballDetectionFrame.detections) {
      const source = sourceDetections.find(
        (candidate) => candidate.className === detection.className,
      );

      expect(source, detection.className).toBeDefined();
      expect(detection.polygon).toEqual(source?.polygon);
      expect(detection.keypoints).toEqual(source?.keypoints);
    }
  });
});
