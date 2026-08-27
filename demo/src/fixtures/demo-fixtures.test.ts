/// <reference types="node" />

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KeypointVisibility, type DetectionFrame } from "supervision";
import { computeDetectionMaskRect } from "supervision/editing";
import { demoFixtureCatalog, demoFixtures } from "./demo-fixtures";

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
const regionsFixturePath = join(fixturesRoot, "basketball_regions");
const regionsManifest = readJson<Record<string, unknown>>(
  join(regionsFixturePath, "detections.manifest.json"),
);
const regionsChunks = listDetectionChunkPaths(regionsFixturePath).map((path) =>
  readJson<DetectionChunk>(path),
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
  it("keeps documentation-only privacy media out of the general demo selector", () => {
    expect(
      demoFixtureCatalog.find(
        ({ sampleName }) => sampleName === "people_privacy_segmentation",
      ),
    ).toMatchObject({
      datasetId: "people_privacy_segmentation_v1",
      showInDemo: false,
    });
    expect(
      demoFixtures.some(
        ({ sampleName }) => sampleName === "people_privacy_segmentation",
      ),
    ).toBe(false);
  });

  it("exposes the demo samples with their documented geometry", () => {
    expect(
      demoFixtures.map(({ displayName, sampleName }) => ({
        displayName,
        sampleName,
      })),
    ).toEqual([
      { displayName: "70s horse trail", sampleName: "horse_trail" },
      {
        displayName: "Basketball Region Effects",
        sampleName: "basketball_regions",
      },
      {
        displayName: "Basketball with Keypoints",
        sampleName: "basketball_geometry",
      },
    ]);
  });

  it("keeps the dense horse trail sample above its smooth-playback threshold", () => {
    const fixture = demoFixtures.find(
      ({ sampleName }) => sampleName === "horse_trail",
    );

    expect(fixture?.presentationDefaults).toEqual({
      boxesEnabled: false,
      confidenceThreshold: 0.5,
      keypointsEnabled: false,
      polygonsEnabled: false,
    });
    expect(fixture?.presentationAvailability).toEqual({
      keypointsEnabled: false,
      polygonsEnabled: false,
    });
  });

  it("defaults the basketball keypoint sample to keypoints and labels", () => {
    const fixture = demoFixtures.find(
      ({ sampleName }) => sampleName === "basketball_geometry",
    );

    expect(fixture?.presentationDefaults).toEqual({
      boxesEnabled: false,
      focusEnabled: false,
      keypointsEnabled: true,
      labelsEnabled: true,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    });
  });

  it("publishes per-geometry detection counts in its manifest", () => {
    const geometry = geometryManifest.geometry as Record<string, number>;

    expect(geometry.maskDetectionCount).toBeGreaterThan(0);
    expect(geometry.polygonDetectionCount).toBeGreaterThan(0);
    expect(geometry.keypointDetectionCount).toBeGreaterThan(0);
    expect(geometry.polylineDetectionCount).toBeGreaterThan(0);
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
    expect(provenance.pose.associationPolicy).toContain(
      "standalone pose detections are omitted",
    );
    expect(provenance.pose.minimumMatchIou).toBe(0.3);
    expect(provenance.pose.matchedPoseDetectionCount).toBeGreaterThan(0);
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

  it("attaches keypoints to team detections with zero-based edges and explicit visibility", () => {
    let keypointDetections = 0;
    let violations = 0;
    let personDetections = 0;

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        for (const detection of frame.detections) {
          if (detection.className === "person") personDetections += 1;
          if (!detection.keypoints) continue;

          keypointDetections += 1;
          const { edges, points, visibility } = detection.keypoints;
          const validDetection =
            (detection.className === "white team player" ||
              detection.className === "yellow team player") &&
            detection.sourceId === "sam3" &&
            detection.mask !== undefined &&
            detection.polygon !== undefined &&
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
    expect(personDetections).toBe(0);
    expect(geometryManifest.classNames).not.toContain("person");
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

  it("stores the basketball trace on one masked frozen identity", () => {
    const provenance = geometryManifest.provenance as {
      readonly polyline: {
        readonly algorithm: string;
        readonly interpolation: string;
        readonly maxAssociationGapSeconds: number;
        readonly maxPoints: number;
        readonly maxSpeedPixelsPerSecond: number;
        readonly positionTolerancePixels: number;
        readonly trackId: string;
        readonly windowSeconds: number;
      };
    };
    let polylineCount = 0;
    let maximumSegmentLength = 0;
    let violations = 0;
    const trackedSourceIds = new Set<string>();

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        for (const detection of frame.detections) {
          if (!detection.polyline) continue;
          polylineCount += 1;
          trackedSourceIds.add(String(detection.id ?? ""));

          const previousPoint = detection.polyline.points.at(-2);
          const currentPoint = detection.polyline.points.at(-1);

          if (previousPoint && currentPoint) {
            maximumSegmentLength = Math.max(
              maximumSegmentLength,
              Math.hypot(
                currentPoint.x - previousPoint.x,
                currentPoint.y - previousPoint.y,
              ),
            );
          }

          if (
            detection.className !== "basketball" ||
            detection.metadata?.trajectoryTrackId !==
              provenance.polyline.trackId ||
            !detection.mask ||
            !detection.rect ||
            detection.polyline.points.length < 2 ||
            detection.polyline.points.length > provenance.polyline.maxPoints ||
            detection.polyline.points.at(-1)?.x !== detection.rect.x ||
            detection.polyline.points.at(-1)?.y !== detection.rect.y
          ) {
            violations += 1;
          }
        }
      }
    }

    expect(provenance.polyline).toMatchObject({
      algorithm: "basketball-motion-track-v1",
      derivedFrom:
        "motion-gated nearest-neighbor association across SAM3 basketball detections on the shared frame grid",
      interpolation: "none",
      maxAssociationGapSeconds: 0.1,
      maxPoints: 60,
      maxSpeedPixelsPerSecond: 2700,
      positionTolerancePixels: 12,
      trackId: "basketball-track:0",
      windowSeconds: 1,
    });
    expect(polylineCount).toBeGreaterThan(0);
    expect(violations).toBe(0);
    expect(trackedSourceIds).toContain("2:1");
    expect(maximumSegmentLength).toBeLessThanOrEqual(
      provenance.polyline.maxSpeedPixelsPerSecond *
        provenance.polyline.maxAssociationGapSeconds +
        provenance.polyline.positionTolerancePixels,
    );
    expect(geometryManifest.geometry).toMatchObject({
      polylineDetectionCount: polylineCount,
    });
  });
});

describe("basketball region fixture", () => {
  it("keeps stabilized, padded head masks with stable short-gap-free tracks", () => {
    let headCount = 0;
    let frameCount = 0;
    const framesByTrack = new Map<string, number[]>();
    const representativeHeadByTrack = new Map<
      string,
      DetectionFrame["detections"][number]
    >();

    for (const chunk of regionsChunks) {
      for (const frame of chunk.frames) {
        frameCount += 1;
        const matchedPlayerIds = new Set<string>();
        let frameHeadCount = 0;

        for (const detection of frame.detections) {
          if (detection.sourceId !== "sam3-head") continue;

          headCount += 1;
          frameHeadCount += 1;
          const matchedPlayerId = String(
            detection.metadata?.matchedPlayerDetectionId ?? "",
          );
          const rawMaskRect = detection.metadata?.rawMaskRect as
            NonNullable<typeof detection.rect> | undefined;
          const rawSam3MaskRect = detection.metadata?.rawSam3MaskRect as
            NonNullable<typeof detection.rect> | undefined;
          const cropRect = detection.rect!;
          const trackId = String(detection.id);
          const trackFrames = framesByTrack.get(trackId) ?? [];

          expect(detection.className).toBe("head");
          expect(detection.mask).toBeDefined();
          expect(detection.polygon).toBeUndefined();
          expect(detection.metadata?.association).toBe(
            "sam3-head-temporal-mask-v4",
          );
          expect(detection.metadata?.maskStabilization).toBe(
            "sam3-head-temporal-mask-v4",
          );
          expect(rawMaskRect).toBeDefined();
          if (detection.metadata?.headObservation === "observed") {
            expect(rawSam3MaskRect).toBeDefined();
          } else {
            expect(detection.metadata?.headObservation).toBe("gap-filled");
            expect(rawSam3MaskRect).toBeUndefined();
          }
          if (!rawMaskRect) throw new Error("Head mask bounds are required.");
          expect(cropRect.x - cropRect.width / 2).toBeLessThanOrEqual(
            rawMaskRect.x - rawMaskRect.width / 2,
          );
          expect(cropRect.x + cropRect.width / 2).toBeGreaterThanOrEqual(
            rawMaskRect.x + rawMaskRect.width / 2,
          );
          expect(cropRect.y - cropRect.height / 2).toBeLessThanOrEqual(
            rawMaskRect.y - rawMaskRect.height / 2,
          );
          expect(cropRect.y + cropRect.height / 2).toBeGreaterThanOrEqual(
            rawMaskRect.y + rawMaskRect.height / 2,
          );
          expect(detection.trackerId).toBeTypeOf("number");
          expect(trackId).toBe(`head:${matchedPlayerId}`);
          expect(matchedPlayerId).not.toBe("");
          expect(matchedPlayerIds.has(matchedPlayerId)).toBe(false);
          matchedPlayerIds.add(matchedPlayerId);
          trackFrames.push(frame.frameIndex!);
          framesByTrack.set(trackId, trackFrames);
          if (!representativeHeadByTrack.has(trackId)) {
            representativeHeadByTrack.set(trackId, detection);
          }
        }

        expect(frameHeadCount).toBeGreaterThan(0);
      }
    }

    expect(headCount).toBeGreaterThan(0);
    expect(frameCount).toBe(regionsManifest.frameCount);

    for (const frameIndexes of framesByTrack.values()) {
      for (let index = 1; index < frameIndexes.length; index += 1) {
        const gapLength = frameIndexes[index] - frameIndexes[index - 1] - 1;

        expect(gapLength === 0 || gapLength > 7).toBe(true);
      }
    }

    for (const detection of representativeHeadByTrack.values()) {
      expect(detection.metadata?.rawMaskRect).toEqual(
        computeDetectionMaskRect(detection.mask!),
      );
    }

    expect(regionsManifest.geometry).toMatchObject({
      maskDetectionCount: regionsManifest.detectionCount,
    });
    expect(
      (regionsManifest.geometry as Record<string, number>).maskDetectionCount -
        (regionsManifest.geometry as Record<string, number>)
          .polygonDetectionCount,
    ).toBe(headCount);
  });

  it("records the frozen SAM3 head input and association policy", () => {
    const provenance = regionsManifest.provenance as {
      readonly headRegions: Record<string, unknown>;
      readonly sources: readonly {
        readonly id: string;
        readonly input: string;
        readonly inputSha256: string;
      }[];
    };
    const headSource = provenance.sources.find(({ id }) => id === "sam3-head");

    expect(provenance.headRegions).toMatchObject({
      algorithm: "sam3-head-temporal-mask-v4",
      prompt: "head",
      sourceId: "sam3-head",
    });
    expect(provenance.headRegions.associationPolicy).toContain(
      "internal gaps of at most 7 frames are filled",
    );
    expect(provenance.headRegions.cropPolicy).toContain(
      "every crop remains a superset of its stabilized mask bounds",
    );
    expect(provenance.headRegions.gapFilledHeadCount).toBeGreaterThan(0);
    expect(provenance.headRegions.stableTrackCount).toBeGreaterThan(0);
    expect(provenance.headRegions.matchedHeadCount).toBeGreaterThan(0);
    expect(
      provenance.headRegions.temporallyStabilizedMaskCount,
    ).toBeGreaterThan(0);
    expect(headSource).toBeDefined();
    expect(headSource?.inputSha256).toBe(
      sourceSha256(
        readFileSync(resolve(regionsFixturePath, headSource!.input)),
      ),
    );
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
