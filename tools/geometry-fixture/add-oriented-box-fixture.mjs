#!/usr/bin/env node
/**
 * Adds a synthetic `orientedBox` demonstration quadrilateral to the existing
 * `demo/fixtures/basketball_sam3` basketball detections, for the oriented-box
 * annotation renderer's docs playground and demo.
 *
 * This is a separate, additive step layered on top of the real SAM3-derived
 * fixture produced by `npm run fixture:geometry:create`; it does not
 * regenerate or replace that fixture, and it does not run any model or
 * inference. It takes every "basketball" detection's existing, already-
 * committed SAM3-derived `rect` in each frame -- not just the first -- and
 * rotates it by a fixed, hand-chosen angle around its own center,
 * independently per detection. The result is clearly a synthetic
 * demonstration quadrilateral, not detector output; see
 * `provenance.orientedBox` in the manifest this script writes, and
 * docs/public/annotation-renderers/oriented-box.md.
 *
 * A basketball detection whose rect is implausibly large (a small number of
 * degenerate full-frame SAM3 boxes already present in the fixture) is left
 * untouched so the demo never draws a giant rotated rectangle across the
 * whole picture; other eligible detections in the same frame are unaffected
 * by that one being skipped.
 *
 * Run via `npm run fixture:geometry:add-oriented-box` from the repository
 * root, after the base fixture already exists.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Overridable only so the generator's own regression test can point this at
// an isolated temp directory and exercise the real script end to end without
// touching the committed demo fixture; unset in every real invocation, so
// `npm run fixture:geometry:add-oriented-box` always targets the same
// fixture it always has.
const FIXTURE_DIR =
  process.env.OBB_FIXTURE_DIR ??
  join(REPO_ROOT, "demo", "fixtures", "basketball_sam3");
const DETECTIONS_DIR = join(FIXTURE_DIR, "detections");
const MANIFEST_PATH = join(FIXTURE_DIR, "detections.manifest.json");

const ROTATION_DEGREES = 22;
const ROTATION_RADIANS = (ROTATION_DEGREES * Math.PI) / 180;
const MAX_BALL_RECT_AREA = 10000;
const GENERATION_COMMAND = "npm run fixture:geometry:add-oriented-box";

function rotatedQuadrilateral(rect, angleRadians) {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  // Clockwise starting from the box's local top-left corner, matching
  // `OrientedBoxGeometry`'s documented vertex order.
  const localCorners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ];
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);

  return localCorners.map((corner) => ({
    x: round(rect.x + corner.x * cos - corner.y * sin),
    y: round(rect.y + corner.x * sin + corner.y * cos),
  }));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function main() {
  const chunkFiles = readdirSync(DETECTIONS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  let attachedCount = 0;
  let consideredCount = 0;

  for (const fileName of chunkFiles) {
    const chunkPath = join(DETECTIONS_DIR, fileName);
    const chunk = JSON.parse(readFileSync(chunkPath, "utf8"));

    for (const frame of chunk.frames) {
      const balls = frame.detections.filter(
        (detection) => detection.className === "basketball" && detection.rect,
      );

      for (const ball of balls) {
        consideredCount += 1;
        const area = ball.rect.width * ball.rect.height;

        if (area <= 0 || area > MAX_BALL_RECT_AREA) {
          continue;
        }

        ball.orientedBox = {
          points: rotatedQuadrilateral(ball.rect, ROTATION_RADIANS),
        };
        attachedCount += 1;
      }
    }

    // The fixture's chunk files are committed minified with a trailing
    // newline; match that so a re-run's diff only shows real content changes.
    writeFileSync(chunkPath, `${JSON.stringify(chunk)}\n`);
  }

  console.log(
    `Considered ${consideredCount} basketball detections across ${chunkFiles.length} chunks; attached orientedBox to ${attachedCount}.`,
  );

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  manifest.geometry = {
    ...manifest.geometry,
    orientedBoxDetectionCount: attachedCount,
  };
  manifest.provenance = {
    ...manifest.provenance,
    orientedBox: {
      algorithm: "hand-authored-demo-rotation-v1",
      derivedFrom:
        "existing SAM3-derived basketball `rect` in this same fixture, rotated in place",
      generationCommand: GENERATION_COMMAND,
      note: "Synthetic demonstration geometry only. No oriented-box model or inference produced these quadrilaterals; a fixed 22 degree clockwise rotation was applied independently to each basketball detection's already-committed real rect, for every such detection in a frame (not only the first) whose rect is a plausible ball size, so the oriented-box renderer docs playground has real, deterministic quadrilateral input to draw. This is a separate, additive step on top of the base fixture, not part of `npm run fixture:geometry:create`.",
      rotationDegrees: ROTATION_DEGREES,
      skippedRectAreaAbove: MAX_BALL_RECT_AREA,
      targetClassName: "basketball",
    },
  };

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest)}\n`);
  console.log("Updated detections.manifest.json geometry + provenance.");
}

main();
