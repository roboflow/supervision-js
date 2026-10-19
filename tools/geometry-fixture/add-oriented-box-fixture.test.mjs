import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Exercises the real generator as a real subprocess (its own `main()`,
// unmodified) against an isolated temp directory, never the committed demo
// fixture. `OBB_FIXTURE_DIR` is the one narrow, additive override the
// generator accepts for exactly this purpose; every real invocation of
// `npm run fixture:geometry:add-oriented-box` leaves it unset and targets
// the same fixture it always has.
const SCRIPT = fileURLToPath(
  new URL("./add-oriented-box-fixture.mjs", import.meta.url),
);

const ROTATION_DEGREES = 22;
const MAX_BALL_RECT_AREA = 10000;

function rotatedQuadrilateralExpected(rect, angleDegrees) {
  const angle = (angleDegrees * Math.PI) / 180;
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const localCorners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const round = (value) => Math.round(value * 10) / 10;

  return localCorners.map((corner) => ({
    x: round(rect.x + corner.x * cos - corner.y * sin),
    y: round(rect.y + corner.x * sin + corner.y * cos),
  }));
}

function buildFrame() {
  return {
    detections: [
      {
        className: "basketball",
        confidence: 0.2,
        id: "sam3:ball:low-confidence-eligible",
        rect: { height: 20, width: 20, x: 100, y: 100 },
      },
      {
        className: "basketball",
        confidence: 0.9,
        id: "sam3:ball:high-confidence-eligible",
        rect: { height: 24, width: 18, x: 400, y: 250 },
      },
      {
        className: "basketball",
        confidence: 0.9,
        id: "sam3:ball:oversized",
        rect: { height: 200, width: 200, x: 600, y: 300 },
      },
      {
        className: "basketball",
        confidence: 0.9,
        id: "sam3:ball:no-rect",
        metadata: { note: "no geometry at all, only class/confidence" },
      },
      {
        className: "white team player",
        confidence: 0.95,
        id: "sam3:player:0",
        rect: { height: 300, width: 120, x: 550, y: 300 },
      },
    ],
    endTime: 0.033,
    frameIndex: 0,
    mediaTime: 0,
  };
}

function buildFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "obb-fixture-test-"));
  mkdirSync(join(dir, "detections"));
  writeFileSync(
    join(dir, "detections", "000000.json"),
    `${JSON.stringify({ frames: [buildFrame()] })}\n`,
  );
  writeFileSync(
    join(dir, "detections.manifest.json"),
    `${JSON.stringify({ geometry: {}, provenance: {} })}\n`,
  );
  return dir;
}

function runGenerator(fixtureDir) {
  const run = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, OBB_FIXTURE_DIR: fixtureDir },
  });
  assert.equal(
    run.status,
    0,
    `generator exited ${run.status}: ${run.stdout ?? ""}${run.stderr ?? ""}`,
  );
  return run;
}

function readChunkBytes(fixtureDir) {
  return readFileSync(join(fixtureDir, "detections", "000000.json"), "utf8");
}

function readManifestBytes(fixtureDir) {
  return readFileSync(join(fixtureDir, "detections.manifest.json"), "utf8");
}

describe("add-oriented-box-fixture.mjs", () => {
  it("attaches an OBB to every eligible basketball in a frame, not only the first", () => {
    const fixtureDir = buildFixtureDir();
    try {
      // buildFrame() returns a fresh object literal on every call, so this
      // is already independent of whatever buildFixtureDir() wrote to disk
      // -- no cloning needed to compare against it later.
      const originalUnrelated = buildFrame().detections.find(
        (detection) => detection.className === "white team player",
      );

      runGenerator(fixtureDir);

      const chunk = JSON.parse(readChunkBytes(fixtureDir));
      const [low, high, oversized, noRect, unrelated] =
        chunk.frames[0].detections;

      // Both eligible basketballs -- not just the first -- receive an OBB,
      // independently rotated around each rectangle's own center. This is
      // the exact regression: a later, above-threshold basketball
      // previously had no OBB at all because the generator's per-frame
      // `.find()` only ever looked at the first basketball detection.
      assert.deepEqual(low.orientedBox, {
        points: rotatedQuadrilateralExpected(low.rect, ROTATION_DEGREES),
      });
      assert.deepEqual(high.orientedBox, {
        points: rotatedQuadrilateralExpected(high.rect, ROTATION_DEGREES),
      });

      // Confidence itself is never touched by this script, and does not
      // gate attachment -- the low-confidence detection is just as
      // eligible as the high-confidence one; only rect plausibility does.
      assert.equal(low.confidence, 0.2);
      assert.equal(high.confidence, 0.9);

      // An implausibly large rect is still skipped -- now per detection,
      // not per frame.
      assert.equal(
        oversized.rect.width * oversized.rect.height > MAX_BALL_RECT_AREA,
        true,
      );
      assert.equal(oversized.orientedBox, undefined);

      // A basketball with no rect at all is left alone, not crashed on.
      assert.equal(noRect.orientedBox, undefined);
      assert.equal(noRect.rect, undefined);

      // A same-frame detection of an unrelated class is completely
      // unchanged -- no cross-contamination from processing every
      // basketball instead of just the first.
      assert.deepEqual(unrelated, originalUnrelated);

      // The scenario the maintainer described directly: a first basketball
      // below a hypothetical downstream confidence threshold, and a later
      // one above it. Both got an OBB above; simulating a `>= 0.5` filter
      // (this script itself never filters by confidence -- this is this
      // test's own stand-in for whatever threshold a consumer applies)
      // confirms the surviving, above-threshold detection still carries
      // its OBB after that filter runs.
      const survivors = chunk.frames[0].detections.filter(
        (detection) => (detection.confidence ?? 1) >= 0.5,
      );
      const survivingBall = survivors.find(
        (detection) => detection.id === "sam3:ball:high-confidence-eligible",
      );
      assert.ok(
        survivingBall?.orientedBox,
        "surviving detection must keep its OBB after filtering",
      );
      assert.deepEqual(survivingBall.orientedBox, {
        points: rotatedQuadrilateralExpected(high.rect, ROTATION_DEGREES),
      });

      const manifest = JSON.parse(readManifestBytes(fixtureDir));
      assert.equal(manifest.geometry.orientedBoxDetectionCount, 2);
      assert.equal(manifest.provenance.orientedBox.rotationDegrees, 22);
      assert.equal(
        manifest.provenance.orientedBox.skippedRectAreaAbove,
        MAX_BALL_RECT_AREA,
      );
      assert.equal(
        manifest.provenance.orientedBox.targetClassName,
        "basketball",
      );
      assert.match(manifest.provenance.orientedBox.note, /not only the first/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("is deterministic: running it twice from the same input produces byte-identical output", () => {
    const fixtureDir = buildFixtureDir();
    try {
      runGenerator(fixtureDir);
      const chunkAfterFirstRun = readChunkBytes(fixtureDir);
      const manifestAfterFirstRun = readManifestBytes(fixtureDir);

      runGenerator(fixtureDir);
      const chunkAfterSecondRun = readChunkBytes(fixtureDir);
      const manifestAfterSecondRun = readManifestBytes(fixtureDir);

      assert.equal(chunkAfterSecondRun, chunkAfterFirstRun);
      assert.equal(manifestAfterSecondRun, manifestAfterFirstRun);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
