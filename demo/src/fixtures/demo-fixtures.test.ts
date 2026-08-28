/// <reference types="node" />

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KeypointVisibility, type DetectionFrame } from "supervision";
import { computeDetectionMaskRect } from "supervision/editing";
import {
  constrainDemoPresentationSettings,
  createDemoPresentation,
  defaultDemoPresentationSettings,
  type DemoPresentationLayerSetting,
} from "../presentation/demo-presentation";
import {
  demoFixtures,
  resolveDemoFixtureAvailability,
  resolveDemoFixturePlaybackSrc,
  type DemoFixtureGeometrySummary,
} from "./demo-fixtures";

const geometryCountKeys = {
  boxesEnabled: "boxDetectionCount",
  keypointsEnabled: "keypointDetectionCount",
  masksEnabled: "maskDetectionCount",
  polygonsEnabled: "polygonDetectionCount",
  polylinesEnabled: "polylineDetectionCount",
} as const satisfies Record<string, keyof DemoFixtureGeometrySummary>;
const geometryBackedLayers = Object.keys(
  geometryCountKeys,
) as readonly (keyof typeof geometryCountKeys & DemoPresentationLayerSetting)[];
/** The merged basketball fixture as its builder reports it without a pose run. */
const maskDerivedGeometry: DemoFixtureGeometrySummary = {
  boxDetectionCount: 5948,
  keypointDetectionCount: 0,
  maskDetectionCount: 5948,
  polygonDetectionCount: 5948,
  polylineDetectionCount: 224,
};

const MAX_POLYGON_POINTS = 48;
const fixturesRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const restorableDetections = readJson<{
  readonly fixtures: readonly {
    readonly detectionsSha256: string;
    readonly sampleName: string;
  }[];
}>(
  fileURLToPath(
    new URL(
      "../../../tools/sam3-fixture/restorable-detections.json",
      import.meta.url,
    ),
  ),
);
const fixturePaths = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(fixturesRoot, entry.name));
const manifests = fixturePaths.flatMap((fixturePath) => {
  const manifestPath = join(fixturePath, "detections.manifest.json");

  return existsSync(manifestPath)
    ? [readJson<Record<string, unknown>>(manifestPath)]
    : [];
});
const geometryFixturePath = join(fixturesRoot, "basketball_sam3");
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
    let comparedRects = 0;

    expect(manifests.length).toBeGreaterThan(0);

    for (const manifest of manifests) {
      expect(manifest).not.toHaveProperty("rectCoordinateConvention");
    }

    for (const chunk of representativeChunks(fixturePaths)) {
      const detection = findFirstMaskedDetection(chunk);

      if (!detection?.mask || !detection.rect) continue;

      comparedRects += 1;
      expect(detection.rect).toEqual(computeDetectionMaskRect(detection.mask));
    }

    expect(comparedRects).toBeGreaterThan(0);
  });
});

describe("geometry showcase fixture", () => {
  it("exposes the demo samples with their documented geometry", () => {
    expect(
      demoFixtures.map(({ displayName, sampleName }) => ({
        displayName,
        sampleName,
      })),
    ).toEqual([
      { displayName: "70s horse trail", sampleName: "horse_trail" },
      { displayName: "9s basketball sample", sampleName: "basketball_sam3" },
      {
        displayName: "Basketball Region Effects",
        sampleName: "basketball_regions",
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

  it("opens the basketball sample on the kinds its detections carry", () => {
    const fixture = demoFixtures.find(
      ({ sampleName }) => sampleName === "basketball_sam3",
    );

    expect(fixture?.presentationDefaults).toEqual({
      boxesEnabled: false,
      confidenceThreshold: 0.5,
      keypointsEnabled: true,
      labelsEnabled: true,
      masksEnabled: true,
      polygonsEnabled: false,
      polylinesEnabled: true,
    });
    // Nothing is closed: the detections carry every kind the demo can draw.
    expect(fixture?.presentationAvailability).toEqual({});
  });

  it("curates presentation defaults for every sample the picker offers", () => {
    expect(
      demoFixtures
        .filter(
          ({ presentationDefaults }) => presentationDefaults === undefined,
        )
        .map(({ sampleName }) => sampleName),
    ).toEqual([]);
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
    expect(provenance.pose.model).toBe("yolov8m-pose-640");
    expect(provenance.pose.runtime).toBe("roboflow-serverless");
    expect(provenance.pose.frameCount).toBe(geometryManifest.frameCount);
    expect(provenance.pose.visibilityPolicy).toContain("NotLabeled");
    expect(provenance.sources).toHaveLength(2);
    expect(JSON.stringify(provenance)).not.toMatch(/api[_-]?key/i);

    for (const source of provenance.sources) {
      expect(source.inputSha256).toBe(
        committedSourceSha256(resolve(geometryFixturePath, source.input)),
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

  it("keeps the basketball trace drawn for as long as the track holds", () => {
    const fixture = demoFixtures.find(
      (candidate) => candidate.sampleName === "basketball_sam3",
    )!;
    const presentation = createDemoPresentation(
      constrainDemoPresentationSettings(
        { ...defaultDemoPresentationSettings, ...fixture.presentationDefaults },
        fixture.presentationAvailability,
      ),
    );
    const drawn: boolean[] = [];
    let untracked = 0;

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        for (const [detectionIndex, detection] of frame.detections.entries()) {
          if (!detection.polyline) continue;

          const trackConfidence = detection.metadata?.trajectoryConfidence;

          if (
            typeof trackConfidence !== "number" ||
            trackConfidence < 0 ||
            trackConfidence > 1
          ) {
            untracked += 1;
          }

          drawn.push(
            presentation.polylineStyle?.resolve(detection, {
              detectionIndex,
              frame,
              mediaTime: frame.mediaTime,
            }) !== undefined,
          );
        }
      }
    }

    // The reported symptom: the trail starts, then blinks out. A frame the
    // fixture's own default threshold hides between two frames it shows is one
    // blink, whatever the run of frames around it does.
    const blinks = drawn.filter(
      (shown, index) =>
        !shown &&
        index > 0 &&
        drawn[index - 1] === true &&
        drawn[index + 1] === true,
    ).length;

    expect(drawn.length).toBeGreaterThan(0);
    expect(untracked).toBe(0);
    expect(blinks).toBe(0);
    expect(drawn.filter(Boolean).length / drawn.length).toBeGreaterThan(0.9);
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
    let widestFrameCoverage = 0;
    const trackedSourceIds = new Set<string>();

    for (const chunk of geometryChunks) {
      for (const frame of chunk.frames) {
        for (const detection of frame.detections) {
          if (!detection.polyline) continue;
          polylineCount += 1;
          trackedSourceIds.add(String(detection.id ?? ""));

          const frameArea =
            (detection.mask?.width ?? 0) * (detection.mask?.height ?? 0);

          if (frameArea > 0 && detection.rect) {
            widestFrameCoverage = Math.max(
              widestFrameCoverage,
              (detection.rect.width * detection.rect.height) / frameArea,
            );
          }

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

    // A whole-scene mask answers the prompt at low confidence, and once the
    // association takes one the trace follows a static blob for the rest of the
    // clip while every other check here still passes.
    expect(widestFrameCoverage).toBeLessThan(0.5);
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

describe("fixture layer availability", () => {
  it("closes a toggle the detections count none of", () => {
    expect(
      resolveDemoFixtureAvailability(undefined, maskDerivedGeometry),
    ).toEqual({ keypointsEnabled: false });
  });

  it("keeps a layer a fixture curates away even when the detections carry it", () => {
    expect(
      resolveDemoFixtureAvailability(
        { polygonsEnabled: false },
        maskDerivedGeometry,
      ),
    ).toEqual({ keypointsEnabled: false, polygonsEnabled: false });
  });

  it("leaves a manifest that counts nothing to its own declaration", () => {
    expect(
      resolveDemoFixtureAvailability({ keypointsEnabled: false }, undefined),
    ).toEqual({ keypointsEnabled: false });
  });

  it("offers no sample a layer its own manifest counts none of", () => {
    const offered = demoFixtures.flatMap((fixture) => {
      const geometry = readJson<{
        readonly geometry?: DemoFixtureGeometrySummary;
      }>(
        join(fixturesRoot, fixture.sampleName, "detections.manifest.json"),
      ).geometry;

      if (!geometry) return [];

      return geometryBackedLayers.flatMap((layer) =>
        geometry[geometryCountKeys[layer]] === 0 &&
        fixture.presentationAvailability?.[layer] !== false
          ? [`${fixture.sampleName}.${layer}`]
          : [],
      );
    });

    expect(offered).toEqual([]);
  });

  it("draws some geometry on every sample the picker opens with", () => {
    const blank = demoFixtures.filter((fixture) => {
      const settings = constrainDemoPresentationSettings(
        { ...defaultDemoPresentationSettings, ...fixture.presentationDefaults },
        fixture.presentationAvailability,
      );

      return geometryBackedLayers.every((layer) => settings[layer] === false);
    });

    expect(blank.map(({ sampleName }) => sampleName)).toEqual([]);
  });
});

describe("fixture playback media", () => {
  it("plays the declared detection-timeline proxy", () => {
    expect(
      resolveDemoFixturePlaybackSrc({
        ...baseDefinition,
        proxyVideoSrc: "/proxy-30fps.webm",
        videoSrc: "/source.mov",
      }),
    ).toBe("/proxy-30fps.webm");
  });

  it("plays the source media when no proxy is declared", () => {
    expect(
      resolveDemoFixturePlaybackSrc({
        ...baseDefinition,
        proxyVideoSrc: null,
        videoSrc: "/source.mov",
      }),
    ).toBe("/source.mov");
  });

  it("declares a proxy on every fixture whose detections were computed on one", () => {
    // A fixture without firstTimestamp pairs detections by index-times-rate
    // against a transcode's frame grid, so it has to play that transcode or
    // every annotation lands on the wrong frame. The reverse does not hold: a
    // fixture that pairs by interval may still declare a proxy, as long as the
    // proxy keeps the source's presentation timestamps and only cheapens
    // decode.
    const unplayable = demoFixtures.filter((fixture) => {
      const meta = readJson<{
        readonly media: { readonly proxyFile?: string };
      }>(join(fixturesRoot, fixture.sampleName, "fixture.meta.json"));
      const manifest = readJson<{
        readonly video: { readonly firstTimestamp?: number };
      }>(join(fixturesRoot, fixture.sampleName, "detections.manifest.json"));

      return (
        manifest.video.firstTimestamp === undefined &&
        meta.media.proxyFile === undefined
      );
    });

    expect(unplayable.map(({ sampleName }) => sampleName)).toEqual([]);
  });

  it("plays the proxy file it declares, and it exists", () => {
    expect(demoFixtures.length).toBeGreaterThan(0);

    for (const fixture of demoFixtures) {
      const meta = readJson<{
        readonly media: { readonly proxyFile?: string };
      }>(join(fixturesRoot, fixture.sampleName, "fixture.meta.json"));

      if (meta.media.proxyFile === undefined) {
        expect(fixture.proxyVideoSrc).toBeNull();
        continue;
      }

      expect(
        existsSync(
          resolve(fixturesRoot, fixture.sampleName, meta.media.proxyFile),
        ),
      ).toBe(true);
      expect(resolveDemoFixturePlaybackSrc(fixture)).toBe(
        fixture.proxyVideoSrc,
      );
    }
  });
});

describe("basketball region fixture", () => {
  it("keeps stabilized, padded head masks with stable short-gap-free tracks", () => {
    let headCount = 0;
    let frameCount = 0;
    const framesByTrack = new Map<string, number[]>();
    const observedFramesByTrack = new Map<string, number[]>();
    const gapFilledFramesByTrack = new Map<string, number[]>();
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
          const observationFrames =
            detection.metadata?.headObservation === "observed"
              ? observedFramesByTrack
              : gapFilledFramesByTrack;
          observationFrames.set(trackId, [
            ...(observationFrames.get(trackId) ?? []),
            frame.frameIndex!,
          ]);
          if (!representativeHeadByTrack.has(trackId)) {
            representativeHeadByTrack.set(trackId, detection);
          }
        }

        expect(frameHeadCount).toBeGreaterThan(0);
      }
    }

    expect(headCount).toBeGreaterThan(0);
    expect(frameCount).toBe(regionsManifest.frameCount);

    expect(gapFilledFramesByTrack.size).toBeGreaterThan(0);

    for (const [trackId, frameIndexes] of gapFilledFramesByTrack) {
      const observed = observedFramesByTrack.get(trackId) ?? [];

      for (const frameIndex of frameIndexes) {
        const previous = Math.max(...observed.filter((at) => at < frameIndex));
        const next = Math.min(...observed.filter((at) => at > frameIndex));

        expect(Number.isFinite(previous)).toBe(true);
        expect(Number.isFinite(next)).toBe(true);
        expect(next - previous - 1).toBeLessThanOrEqual(4);
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
      algorithm: "sam3-head-temporal-mask-v5",
      prompt: "head",
      sourceId: "sam3-head",
    });
    expect(provenance.headRegions.associationPolicy).toContain(
      "internal gaps of at most 4 frames are filled",
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
      committedSourceSha256(resolve(regionsFixturePath, headSource!.input)),
    );
  });
});

const baseDefinition = {
  basePath: "../../fixtures/sample",
  datasetId: "sample_v1",
  detectionsManifestSrc: "/detections.manifest.json",
  displayName: "Sample",
  inferenceLabel: "SAM3",
  mediaLoadingStatusLabel: "opening sample",
  mediaReadyStatusLabel: "sample ready",
  sampleName: "sample",
} as const;

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

/**
 * A fixture's `detections.json` is a git-ignored build intermediate, so a clean
 * checkout holds no bytes to hash. Its digest is pinned where the restore tool
 * reads it, and that tool checks the rebuilt file against the same pin, so the
 * two records cannot drift apart unnoticed.
 */
function committedSourceSha256(inputPath: string) {
  if (existsSync(inputPath)) {
    return sourceSha256(readFileSync(inputPath));
  }

  const pinned = restorableDetections.fixtures.find(
    (fixture) =>
      resolve(fixturesRoot, fixture.sampleName, "detections.json") ===
      inputPath,
  );

  if (!pinned) {
    throw new Error(
      `${inputPath} is neither committed nor restorable, so its provenance digest describes nothing.`,
    );
  }

  return pinned.detectionsSha256;
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
