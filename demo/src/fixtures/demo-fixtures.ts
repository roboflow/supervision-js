import {
  createChunkedDetectionFrameSource,
  createVideoEngineMediaRendererSource,
  type DetectionCoordinateSpace,
  type DetectionFrameChunkFetch,
  type DetectionFrameChunkManifest,
  type DetectionFrameSource,
  type DetectionFrame,
  type MediaRendererSource,
} from "supervision";
import { SourceKind } from "supervision-js-web-video-engine";
import { delayDetectionFetch } from "../diagnostics/slow-work";
import type { DisplayBoxResolutionOptions } from "supervision-js-web-video-engine";
import type {
  DemoPresentationAvailability,
  DemoPresentationLayerSetting,
} from "../presentation/demo-presentation";
import type { DemoEngineOptions } from "../session/session-options";

const fixtureMetaModules = import.meta.glob(
  "../../fixtures/*/fixture.meta.json",
  {
    eager: true,
    import: "default",
  },
) as Record<string, DemoFixtureMeta>;
const fixtureManifests = import.meta.glob(
  ["../../fixtures/*/detections.manifest.json"],
  {
    eager: true,
    import: "default",
  },
) as Record<string, DemoFixtureDetectionManifest>;
const fixtureManifestUrls = import.meta.glob(
  ["../../fixtures/*/detections.manifest.json"],
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;
const fixtureMediaUrls = import.meta.glob(
  [
    "../../fixtures/**/*.{mp4,MP4,mov,MOV,m4v,M4V,webm,WEBM}",
    "!../../fixtures/**/*.normalized.webm",
  ],
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;
const sampleDetectionChunkUrls = import.meta.glob(
  ["../../fixtures/*/detections/*.json"],
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;

const DEFAULT_FIXTURE_SAMPLE_NAME = "horse_trail";

export const DEMO_FIXTURE_META_SCHEMA = "supervision-js.demo.fixture-meta";
/** Original mask-only metadata schema kept for existing SAM3 fixtures. */
export const LEGACY_SAM3_FIXTURE_META_SCHEMA =
  "supervision-js.demo.sam3-fixture-meta";

interface DemoFixtureMeta {
  readonly schema:
    typeof DEMO_FIXTURE_META_SCHEMA | typeof LEGACY_SAM3_FIXTURE_META_SCHEMA;
  readonly version: 1;
  readonly datasetId: string;
  readonly displayName: string;
  readonly inferenceLabel: string;
  readonly sampleName: string;
  readonly showInDemo?: boolean;
  readonly media: {
    readonly file: string;
    readonly loadingStatusLabel: string;
    /**
     * Forced-CFR 30fps transcode the fixture's detections were computed
     * against. A v1 fixture indexes that timeline rather than the source's own
     * frames, so playing `file` draws every detection against the wrong frame.
     */
    readonly proxyFile?: string;
    readonly readyStatusLabel: string;
  };
  readonly presentation?: DemoFixturePresentationDefaults;
  readonly presentationAvailability?: DemoPresentationAvailability;
}

export interface DemoFixturePresentationDefaults {
  readonly boxesEnabled?: boolean;
  readonly confidenceThreshold?: number;
  readonly focusEnabled?: boolean;
  readonly keypointsEnabled?: boolean;
  readonly labelsEnabled?: boolean;
  readonly masksEnabled?: boolean;
  readonly polygonsEnabled?: boolean;
  readonly polylinesEnabled?: boolean;
}

export interface DemoFixtureDefinition {
  readonly basePath: string;
  readonly datasetId: string;
  readonly detectionsManifestSrc: string;
  readonly displayName: string;
  readonly inferenceLabel: string;
  readonly mediaLoadingStatusLabel: string;
  readonly presentationDefaults?: DemoFixturePresentationDefaults;
  readonly presentationAvailability?: DemoPresentationAvailability;
  readonly sampleName: string;
  readonly mediaReadyStatusLabel: string;
  /** Declared detection-timeline transcode, or null when the fixture has none. */
  readonly proxyVideoSrc: string | null;
  readonly videoSrc: string;
}

/** Layers that draw nothing unless the detections carry the matching geometry. */
const geometryBackedLayers: readonly (readonly [
  DemoPresentationLayerSetting,
  keyof DemoFixtureGeometrySummary,
])[] = [
  ["boxesEnabled", "boxDetectionCount"],
  ["keypointsEnabled", "keypointDetectionCount"],
  ["masksEnabled", "maskDetectionCount"],
  ["polygonsEnabled", "polygonDetectionCount"],
  ["polylinesEnabled", "polylineDetectionCount"],
];

/**
 * The layers a fixture is allowed to offer.
 *
 * A manifest that counts its own geometry settles what the detections hold, and
 * a declared flag may only take a layer away from that, never hand one back: a
 * fixture is regenerated far more often than its metadata is reread, so the
 * count is the side that stays true.
 */
export function resolveDemoFixtureAvailability(
  declared: DemoPresentationAvailability | undefined,
  geometry: DemoFixtureGeometrySummary | undefined,
): DemoPresentationAvailability | undefined {
  if (!geometry) {
    return declared;
  }

  const availability: DemoPresentationAvailability = { ...declared };

  for (const [layer, countKey] of geometryBackedLayers) {
    if (geometry[countKey] === 0) {
      availability[layer] = false;
    }
  }

  return availability;
}

export const demoFixtures = createDemoFixtures();

export const defaultDemoFixture = requireDemoFixture(
  demoFixtures.find(
    (fixture) => fixture.sampleName === DEFAULT_FIXTURE_SAMPLE_NAME,
  ) ?? demoFixtures[0],
);

/** Per-geometry detection counts reported by generated fixture manifests. */
export interface DemoFixtureGeometrySummary {
  readonly boxDetectionCount: number;
  readonly keypointDetectionCount: number;
  readonly maskDetectionCount: number;
  readonly polygonDetectionCount: number;
  readonly polylineDetectionCount: number;
}

export interface DemoFixtureDetectionManifest extends DetectionFrameChunkManifest {
  readonly video: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly duration: number;
    /**
     * Presentation timestamp of source frame index 0. Absent on fixtures
     * extracted from a normalized proxy, whose grid always started at zero.
     */
    readonly firstTimestamp?: number;
    readonly frameCount?: number;
  };
  readonly classNames?: readonly string[];
  readonly geometry?: DemoFixtureGeometrySummary;
  readonly inference?: {
    readonly sourceFile?: string;
    readonly frameRate: number;
    readonly mask?: {
      readonly width: number;
      readonly height: number;
    };
    readonly missingFrameIndexes?: readonly number[];
    readonly modelId?: string;
    readonly prompts?: readonly string[];
  };
  readonly sourceFile?: string;
}

export interface DemoFixtureSummary {
  readonly classNames: readonly string[];
  readonly duration: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly fixtureName: string;
  readonly geometry: DemoFixtureGeometrySummary | null;
  readonly inferenceFrameRate: number;
  readonly inferenceLabel: string;
  readonly maskHeight: number | null;
  readonly maskWidth: number | null;
  readonly missingFrameIndexes: readonly number[];
}

export interface DemoFixtureDetectionSourceSummary {
  readonly datasetId: string;
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

export interface DemoFixtureDetectionSource {
  readonly datasetId: string;
  readonly detectionSource: DetectionFrameSource;
  readonly fixtureSummary: DemoFixtureSummary;
  readonly sourceSummary: DemoFixtureDetectionSourceSummary;
  readonly status: "ready";
  destroy(): void;
}

export type DemoFixtureFrameTransform = (
  frames: readonly DetectionFrame[],
) => readonly DetectionFrame[];

export type DemoFixtureDetectionSourceTransform = (
  source: DetectionFrameSource,
  manifest: DemoFixtureDetectionManifest,
) => DetectionFrameSource;

export async function loadDemoFixtureDetectionManifest(
  definition: DemoFixtureDefinition = defaultDemoFixture,
): Promise<DemoFixtureDetectionManifest> {
  const response = await fetch(definition.detectionsManifestSrc);

  if (!response.ok) {
    throw new Error(
      `Unable to load detections fixture: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as DemoFixtureDetectionManifest;
}

/**
 * Media a fixture session plays. A fixture whose detections were computed on a
 * transcoded timeline has to play that transcode, because its frame indexes
 * describe the transcode's grid and not the source's own frames.
 */
export function resolveDemoFixturePlaybackSrc(
  definition: DemoFixtureDefinition,
): string {
  return definition.proxyVideoSrc ?? definition.videoSrc;
}

export function createDemoFixtureMedia(
  definition: DemoFixtureDefinition = defaultDemoFixture,
  display?: DisplayBoxResolutionOptions,
  engine?: DemoEngineOptions,
): MediaRendererSource {
  return createVideoEngineMediaRendererSource({
    ...engine,
    display,
    source: {
      kind: SourceKind.Url,
      url: resolveDemoFixturePlaybackSrc(definition),
    },
  });
}

export function createDemoFixtureDetectionSource(
  manifest: DemoFixtureDetectionManifest,
  definition: DemoFixtureDefinition = defaultDemoFixture,
  frameTransform?: DemoFixtureFrameTransform,
  sourceTransform?: DemoFixtureDetectionSourceTransform,
): DemoFixtureDetectionSource {
  const detectionSpace = resolveDemoFixtureDetectionSpace(manifest);
  const chunkedDetectionSource = createChunkedDetectionFrameSource({
    baseUrl: definition.detectionsManifestSrc,
    fetchChunk: async (chunk) => {
      const loaded = await fetchDemoFixtureDetectionChunk(
        chunk,
        definition,
        detectionSpace,
      );

      return frameTransform
        ? { frames: frameTransform(loaded.frames) }
        : loaded;
    },
    manifest,
  });
  const baseDetectionSource: DetectionFrameSource = {
    ...chunkedDetectionSource,
    async loadFrames(startTime, endTime, options) {
      const frames = await chunkedDetectionSource.loadFrames(
        startTime,
        endTime,
        options,
      );

      assertDemoFixtureDetectionSpace(
        frames,
        detectionSpace,
        definition,
        options?.coordinateSpace,
      );

      return frames;
    },
  };
  const detectionSource =
    sourceTransform?.(baseDetectionSource, manifest) ?? baseDetectionSource;
  let destroyed = false;
  const destroy = () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    detectionSource.destroy?.();
    if (detectionSource !== baseDetectionSource) {
      baseDetectionSource.destroy?.();
    }
  };

  return {
    datasetId: definition.datasetId,
    detectionSource,
    destroy,
    fixtureSummary: summarizeDemoFixtureManifest(manifest, definition),
    sourceSummary: summarizeDemoFixtureDetectionSource(manifest),
    status: "ready",
  };
}

const fetchDemoFixtureDetectionChunk = async (
  chunk: Parameters<DetectionFrameChunkFetch>[0],
  definition: DemoFixtureDefinition,
  detectionSpace: DetectionCoordinateSpace | null,
) => {
  const chunkUrl =
    sampleDetectionChunkUrls[`${definition.basePath}/${chunk.src}`];

  if (!chunkUrl) {
    throw new Error(`Unknown fixture detection chunk: ${chunk.src}`);
  }

  await delayDetectionFetch();

  const response = await fetch(chunkUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to load fixture detection chunk ${chunk.src}: ${response.status} ${response.statusText}`,
    );
  }

  const chunkData = (await response.json()) as Awaited<
    ReturnType<DetectionFrameChunkFetch>
  >;

  return detectionSpace
    ? {
        frames: chunkData.frames.map((frame) => ({
          ...frame,
          coordinateSpace: detectionSpace,
        })),
      }
    : chunkData;
};

/**
 * Pixel space the fixture's detections were computed in, as its manifest
 * records it.
 *
 * A fixture's chunks hold rectangles, polygons, polylines, and keypoints in the
 * pixels of the media the model saw. The demo may play a smaller delivery
 * proxy of that media instead, so every frame states the space it came from and
 * lets the renderer scale it onto the frame actually presented.
 */
function resolveDemoFixtureDetectionSpace(
  manifest: DemoFixtureDetectionManifest,
): DetectionCoordinateSpace | null {
  const { height, width } = manifest.video;

  return width > 0 && height > 0 ? { height, width } : null;
}

/**
 * Refuses to serve detections the demo cannot place on the media it is playing.
 *
 * Nothing downstream can notice geometry drawn in the wrong pixel space: boxes
 * and labels simply land somewhere plausible, or off the canvas entirely.
 */
function assertDemoFixtureDetectionSpace(
  frames: readonly DetectionFrame[],
  detectionSpace: DetectionCoordinateSpace | null,
  definition: DemoFixtureDefinition,
  presentedSpace: DetectionCoordinateSpace | undefined,
): void {
  if (!presentedSpace) {
    return;
  }

  if (!detectionSpace) {
    throw new Error(
      `Fixture ${definition.sampleName} does not say what size its detections were computed at, so the demo cannot tell whether they fit the ${presentedSpace.width}x${presentedSpace.height} media it is playing. Give video.width and video.height real pixel sizes in demo/fixtures/${definition.sampleName}/detections.manifest.json.`,
    );
  }

  if (
    detectionSpace.width === presentedSpace.width &&
    detectionSpace.height === presentedSpace.height
  ) {
    return;
  }

  if (frames.every((frame) => frame.coordinateSpace)) {
    return;
  }

  throw new Error(
    `Fixture ${definition.sampleName} plays ${presentedSpace.width}x${presentedSpace.height} media while its detections were computed at ${detectionSpace.width}x${detectionSpace.height}, and the loaded frames do not declare which of the two they use. Every frame needs coordinateSpace set to the size the detections were computed at, or every box, label, polygon, polyline, and keypoint is drawn in the wrong place.`,
  );
}

function createDemoFixtures(): readonly DemoFixtureDefinition[] {
  const fixtures = Object.entries(fixtureMetaModules).flatMap(
    ([metaPath, meta]) => {
      if (
        meta.schema !== DEMO_FIXTURE_META_SCHEMA &&
        meta.schema !== LEGACY_SAM3_FIXTURE_META_SCHEMA
      ) {
        console.warn(
          `Skipping fixture metadata with unknown schema at ${metaPath}.`,
        );
        return [];
      }

      if (meta.showInDemo === false) {
        return [];
      }

      const basePath = metaPath.replace(/\/fixture\.meta\.json$/, "");
      const manifestPath = `${basePath}/detections.manifest.json`;
      const mediaPath = normalizeFixturePath(basePath, meta.media.file);
      const proxyPath = meta.media.proxyFile
        ? normalizeFixturePath(basePath, meta.media.proxyFile)
        : null;
      const detectionsManifestSrc = fixtureManifestUrls[manifestPath];
      const videoSrc = fixtureMediaUrls[mediaPath];
      const proxyVideoSrc = proxyPath ? fixtureMediaUrls[proxyPath] : null;

      if (!detectionsManifestSrc || !videoSrc) {
        console.warn(
          `Skipping incomplete demo fixture ${meta.sampleName}. Expected ${manifestPath} and ${mediaPath}.`,
        );
        return [];
      }

      if (proxyPath && !proxyVideoSrc) {
        console.warn(
          `Skipping demo fixture ${meta.sampleName} with a declared but missing proxy. Expected ${proxyPath}.`,
        );
        return [];
      }

      return [
        {
          basePath,
          datasetId: meta.datasetId,
          detectionsManifestSrc,
          displayName: meta.displayName,
          inferenceLabel: meta.inferenceLabel,
          mediaLoadingStatusLabel: meta.media.loadingStatusLabel,
          mediaReadyStatusLabel: meta.media.readyStatusLabel,
          presentationDefaults: meta.presentation,
          presentationAvailability: resolveDemoFixtureAvailability(
            meta.presentationAvailability,
            fixtureManifests[manifestPath]?.geometry,
          ),
          proxyVideoSrc: proxyVideoSrc ?? null,
          sampleName: meta.sampleName,
          videoSrc,
        } satisfies DemoFixtureDefinition,
      ];
    },
  );

  return fixtures.sort((left, right) => {
    if (left.sampleName === DEFAULT_FIXTURE_SAMPLE_NAME) {
      return -1;
    }

    if (right.sampleName === DEFAULT_FIXTURE_SAMPLE_NAME) {
      return 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

function requireDemoFixture(fixture: DemoFixtureDefinition | undefined) {
  if (!fixture) {
    throw new Error("No demo fixture metadata was found.");
  }

  return fixture;
}

function normalizeFixturePath(basePath: string, relativePath: string) {
  const parts = basePath.split("/");

  for (const part of relativePath.split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.join("/");
}

export function summarizeDemoFixtureManifest(
  manifest: DemoFixtureDetectionManifest,
  definition: DemoFixtureDefinition = defaultDemoFixture,
): DemoFixtureSummary {
  return {
    classNames: manifest.classNames ?? manifest.inference?.prompts ?? [],
    detectionCount: manifest.detectionCount ?? 0,
    duration: manifest.video.duration,
    frameCount: manifest.frameCount ?? 0,
    fixtureName: definition.displayName,
    geometry: manifest.geometry ?? null,
    inferenceFrameRate:
      manifest.inference?.frameRate ??
      manifest.frameRate ??
      manifest.video.frameRate,
    inferenceLabel: definition.inferenceLabel,
    maskHeight: manifest.inference?.mask?.height ?? null,
    maskWidth: manifest.inference?.mask?.width ?? null,
    missingFrameIndexes: manifest.inference?.missingFrameIndexes ?? [],
  };
}

function summarizeDemoFixtureDetectionSource(
  manifest: DemoFixtureDetectionManifest,
): DemoFixtureDetectionSourceSummary {
  const firstChunk = manifest.chunks[0];
  const lastChunk = manifest.chunks.at(-1);

  return {
    chunkCount: manifest.chunks.length,
    chunkDurationSeconds: manifest.chunkDurationSeconds,
    datasetId: manifest.datasetId,
    detectionCount: manifest.detectionCount ?? 0,
    endTime: lastChunk?.endTime ?? null,
    frameCount: manifest.frameCount ?? 0,
    startTime: firstChunk?.startTime ?? null,
  };
}
