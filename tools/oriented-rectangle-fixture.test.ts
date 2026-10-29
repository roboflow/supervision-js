import { readFileSync, readdirSync } from "node:fs";

import { expect, it } from "vitest";

import type { Detection } from "../packages/core/src/types/detections";
import { getOrientedRectangleGeometry } from "../packages/core/src/utils/oriented-rectangle";

it("recognizes every committed rounded oriented-box fixture", () => {
  const directory = new URL(
    "../demo/fixtures/basketball_sam3/detections/",
    import.meta.url,
  );
  let found = false;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const chunk: { frames: { detections: Detection[] }[] } = JSON.parse(
      readFileSync(new URL(name, directory), "utf8"),
    );
    for (const frame of chunk.frames) {
      for (const detection of frame.detections) {
        if (!detection.orientedBox) continue;
        found = true;
        expect(
          getOrientedRectangleGeometry(detection.orientedBox),
          name,
        ).not.toBeNull();
      }
    }
  }
  expect(found).toBe(true);
});
