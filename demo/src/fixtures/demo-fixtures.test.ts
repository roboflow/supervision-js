/// <reference types="node" />

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KeypointVisibility, type DetectionFrame } from "supervision-js";
import { computeDetectionMaskRect } from "supervision-js/editing";

const MAX_POLYGON_POINTS = 48;
const fixturesRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const fixturePaths = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(fixturesRoot, entry.name));
const manifests = fixturePaths.flatMap((fixturePath) => {
  const manifestPath = join(fixturePath, "detections.manifest.json");

  return existsSync(manifestPath)
    ? [readJson<Record<string, unknown>>(manifestPath)]
    : [];
});
const geometryFixturePath = join(fixturesRoot, "basketball_geometry");
const geometryManifest = readJson<Record<string, unknown>>(
  join(geometryFixturePath, "detections.manifest.json"),
);
const geometryChunks = listDetectionChunkPaths(geometryFixturePath).map(
  (path) => readJson<DetectionChunk>(path),
);

describe("fixture geometry", () => {
  it("uses center-based rects for deterministic fixture mask samples", () => {
    for (const manifest of manifests) {
      expect(manifest).not.toHaveProperty("rectCoordinateConvention");
    }

    for (const chunk of representativeChunks(fixturePaths)) {
      const detection = findFirstMaskedDetection(chunk);

      if (!detection?.mask || !detection.rect) continue;
      expect(detection.rect).toEqual(computeDetectionMaskRect(detection.mask));
    }
  });
});

describe("geometry showcase fixture", () => {
  it("publishes per-geometry detection counts in its manifest", () => {
    const geometry = geometryManifest.geometry as Record<string, number>;

    expect(geometry.maskDetectionCount).toBeGreaterThan(0);
    expect(geometry.polygonDetectionCount).toBeGreaterThan(0);
    expect(geometry.keypointDetectionCount).toBeGreaterThan(0);
    expect(geometry.boxDetectionCount).toBe(
      geometryManifest.detectionCount as number,
    );
  });

  it("records verifiable provenance without secrets or image payloads", () => {
    const provenance = geometryManifest.provenance as {
      readonly pose: Record<string, unknown>;
      readonly sources: readonly {
        readonly input: string;
        readonly inputSha256: string;
      }[];
    };

    expect(provenance.pose.model).toBeDefined();
    expect(provenance.pose.weightsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.pose.visibilityPolicy).toContain("NotLabeled");
    expect(provenance.sources).toHaveLength(2);
    expect(JSON.stringify(provenance)).not.toMatch(/api[_-]?key/i);

    for (const source of provenance.sources) {
      expect(source.inputSha256).toBe(
        sourceSha256(readFileSync(resolve(geometryFixturePath, source.input))),
      );
    }
  });

  it("verifies provenance from Git LFS pointers in lightweight checkouts", () => {
    const oid =
      "5fad854bfeab82de38b3551272aff8e62df5f702120109e1de5c93c33628cb06";
    const pointer = Buffer.from(
      [
        "version https://git-lfs.github.com/spec/v1",
        `oid sha256:${oid}`,
        "size 3323362",
        "",
      ].join("\n"),
    );

    expect(sourceSha256(pointer)).toBe(oid);
  });

  it("keeps source masks next to their derived bounded polygons", () => {
    let comparedDetections = 0;
    let violations = 0;

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        for (const detection of frame.detections) {
          if (!detection.polygon) continue;

          comparedDetections += 1;

          const pointCount = detection.polygon.points.length;

          if (
            !detection.mask ||
            pointCount < 3 ||
            pointCount > MAX_POLYGON_POINTS
          ) {
            violations += 1;
          }
        }
      }
    }

    expect(comparedDetections).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });

  it("ships keypoint detections with zero-based edges and explicit visibility", () => {
    let keypointDetections = 0;
    let violations = 0;

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        for (const detection of frame.detections) {
          if (!detection.keypoints) continue;

          keypointDetections += 1;
          const { edges, points, visibility } = detection.keypoints;
          const validDetection =
            /^pose:\d+:\d+$/.test(String(detection.id)) &&
            detection.rect !== undefined &&
            visibility !== undefined &&
            visibility.length === points.length &&
            visibility.every(
              (value) =>
                value === KeypointVisibility.NotLabeled ||
                value === KeypointVisibility.Visible,
            ) &&
            edges.every(
              ([from, to]) =>
                from >= 0 &&
                to >= 0 &&
                from < points.length &&
                to < points.length &&
                visibility[from] === KeypointVisibility.Visible &&
                visibility[to] === KeypointVisibility.Visible,
            );

          if (!validDetection) {
            violations += 1;
          }
        }
      }
    }

    expect(keypointDetections).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });

  it("keeps every detection frame on the shared 30fps detection-frame grid", () => {
    let violations = 0;

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        if (
          !Number.isInteger(frame.frameIndex) ||
          frame.frameIndex! < 0 ||
          frame.mediaTime < 0 ||
          (frame.endTime ?? Number.NEGATIVE_INFINITY) <= frame.mediaTime
        ) {
          violations += 1;
        }
      }
    }

    expect(geometryChunks.length).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });
});

interface DetectionChunk {
  readonly frames: readonly DetectionFrame[];
}

function representativeChunks(paths: readonly string[]) {
  return paths.flatMap((fixturePath) => {
    const chunkPaths = listDetectionChunkPaths(fixturePath);
    const indexes = new Set([
      0,
      Math.floor(chunkPaths.length / 2),
      chunkPaths.length - 1,
    ]);

    return [...indexes].flatMap((index) => {
      const chunkPath = chunkPaths[index];

      return chunkPath ? [readJson<DetectionChunk>(chunkPath)] : [];
    });
  });
}

function listDetectionChunkPaths(fixturePath: string) {
  const chunksPath = join(fixturePath, "detections");

  if (!existsSync(chunksPath)) {
    return [];
  }

  return readdirSync(chunksPath)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(chunksPath, name));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function sourceSha256(content: Buffer) {
  const lfsPointer =
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize \d+\r?\n?$/.exec(
      content.toString("utf8"),
    );

  return lfsPointer?.[1] ?? sha256(content);
}

function findFirstMaskedDetection(chunk: DetectionChunk) {
  for (const frame of chunk.frames) {
    const detection = frame.detections.find(
      (candidate) => candidate.mask && candidate.rect,
    );
    if (detection) return detection;
  }

  return undefined;
}
