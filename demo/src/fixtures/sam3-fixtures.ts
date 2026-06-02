import {
  DetectionMaskEncoding,
  createChunkedDetectionFrameSource,
  type Detection,
  type DetectionFrameChunkFetch,
  type DetectionFrameChunkManifest,
  type DetectionFrameSource,
  type MediaSessionMedia,
} from "supervision-js";

const fixtureMetaModules = import.meta.glob(
  "../../fixtures/*/fixture.meta.json",
  {
    eager: true,
    import: "default",
  },
) as Record<string, Sam3FixtureMeta>;
const fixtureManifestUrls = import.meta.glob(
  "../../fixtures/*/detections.manifest.json",
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
  "../../fixtures/*/detections/*.json",
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;

const DEFAULT_SAM3_FIXTURE_SAMPLE_NAME = "horse_trail";

interface Sam3FixtureMeta {
  readonly schema: "supervision-js.demo.sam3-fixture-meta";
  readonly version: 1;
  readonly datasetId: string;
  readonly displayName: string;
  readonly inferenceLabel: string;
  readonly sampleName: string;
  readonly media: {
    readonly file: string;
    readonly loadingStatusLabel: string;
    readonly normalizeInBrowser: boolean;
    readonly readyStatusLabel: string;
  };
}

export interface Sam3FixtureDefinition {
  readonly basePath: string;
  readonly datasetId: string;
  readonly detectionsManifestSrc: string;
  readonly displayName: string;
  readonly inferenceLabel: string;
  readonly mediaLoadingStatusLabel: string;
  readonly normalizeInBrowser: boolean;
  readonly sampleName: string;
  readonly mediaReadyStatusLabel: string;
  readonly videoSrc: string;
}

export const sam3Fixtures = createSam3Fixtures();

export const defaultSam3Fixture = requireSam3Fixture(
  sam3Fixtures.find(
    (fixture) => fixture.sampleName === DEFAULT_SAM3_FIXTURE_SAMPLE_NAME,
  ) ?? sam3Fixtures[0],
);
export const defaultSam3VideoSrc = defaultSam3Fixture?.videoSrc ?? "";

export interface Sam3FixtureDetectionManifest extends DetectionFrameChunkManifest {
  readonly video: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly duration: number;
  };
  readonly inference: {
    readonly sourceFile: string;
    readonly frameRate: number;
    readonly mask: {
      readonly width: number;
      readonly height: number;
    };
    readonly missingFrameIndexes: readonly number[];
    readonly modelId?: string;
    readonly prompts?: readonly string[];
  };
  readonly sourceFile?: string;
}

export interface Sam3FixtureDetection extends Detection {
  readonly mask: {
    readonly encoding: DetectionMaskEncoding.CompressedRle;
    readonly width: number;
    readonly height: number;
    readonly counts: string;
  };
}

export interface Sam3FixtureSummary {
  readonly classNames: readonly string[];
  readonly duration: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly fixtureName: string;
  readonly inferenceFrameRate: number;
  readonly inferenceLabel: string;
  readonly maskHeight: number;
  readonly maskWidth: number;
  readonly missingFrameIndexes: readonly number[];
}

export interface Sam3FixtureDetectionSourceSummary {
  readonly datasetId: string;
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

export interface Sam3FixtureDetectionSource {
  readonly datasetId: string;
  readonly detectionSource: DetectionFrameSource;
  readonly fixtureSummary: Sam3FixtureSummary;
  readonly sourceSummary: Sam3FixtureDetectionSourceSummary;
  readonly status: "ready";
  destroy(): void;
}

export interface Sam3FixtureMediaSource {
  readonly error: Error | null;
  readonly media: MediaSessionMedia;
  readonly normalizeInBrowser: boolean;
  readonly statusLabel: string;
}

export async function loadSam3FixtureDetectionManifest(
  definition: Sam3FixtureDefinition = defaultSam3Fixture,
): Promise<Sam3FixtureDetectionManifest> {
  const response = await fetch(definition.detectionsManifestSrc);

  if (!response.ok) {
    throw new Error(
      `Unable to load SAM3 detections fixture: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as Sam3FixtureDetectionManifest;
}

export async function loadSam3FixtureMedia(
  definition: Sam3FixtureDefinition = defaultSam3Fixture,
): Promise<Sam3FixtureMediaSource> {
  if (!definition.normalizeInBrowser) {
    return {
      error: null,
      media: definition.videoSrc,
      normalizeInBrowser: false,
      statusLabel: definition.mediaReadyStatusLabel,
    };
  }

  const response = await fetch(definition.videoSrc);

  if (!response.ok) {
    throw new Error(
      `Unable to load sample source media: ${response.status} ${response.statusText}`,
    );
  }

  return {
    error: null,
    media: await response.blob(),
    normalizeInBrowser: true,
    statusLabel: definition.mediaReadyStatusLabel,
  };
}

export function createSam3FixtureDetectionSource(
  manifest: Sam3FixtureDetectionManifest,
  definition: Sam3FixtureDefinition = defaultSam3Fixture,
): Sam3FixtureDetectionSource {
  const detectionSource = createChunkedDetectionFrameSource({
    baseUrl: definition.detectionsManifestSrc,
    fetchChunk: (chunk) => fetchSam3FixtureDetectionChunk(chunk, definition),
    manifest,
  });
  let destroyed = false;
  const destroy = () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    detectionSource.destroy?.();
  };

  return {
    datasetId: definition.datasetId,
    detectionSource,
    destroy,
    fixtureSummary: summarizeSam3FixtureManifest(manifest, definition),
    sourceSummary: summarizeSam3FixtureDetectionSource(manifest),
    status: "ready",
  };
}

const fetchSam3FixtureDetectionChunk = async (
  chunk: Parameters<DetectionFrameChunkFetch>[0],
  definition: Sam3FixtureDefinition,
) => {
  const chunkUrl =
    sampleDetectionChunkUrls[`${definition.basePath}/${chunk.src}`];

  if (!chunkUrl) {
    throw new Error(`Unknown SAM3 fixture detection chunk: ${chunk.src}`);
  }

  const response = await fetch(chunkUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to load SAM3 fixture detection chunk ${chunk.src}: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as Awaited<
    ReturnType<DetectionFrameChunkFetch>
  >;
};

function createSam3Fixtures(): readonly Sam3FixtureDefinition[] {
  const fixtures = Object.entries(fixtureMetaModules).flatMap(
    ([metaPath, meta]) => {
      const basePath = metaPath.replace(/\/fixture\.meta\.json$/, "");
      const manifestPath = `${basePath}/detections.manifest.json`;
      const mediaPath = normalizeFixturePath(basePath, meta.media.file);
      const detectionsManifestSrc = fixtureManifestUrls[manifestPath];
      const videoSrc = fixtureMediaUrls[mediaPath];

      if (!detectionsManifestSrc || !videoSrc) {
        console.warn(
          `Skipping incomplete SAM3 fixture ${meta.sampleName}. Expected ${manifestPath} and ${mediaPath}.`,
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
          normalizeInBrowser: meta.media.normalizeInBrowser,
          sampleName: meta.sampleName,
          videoSrc,
        } satisfies Sam3FixtureDefinition,
      ];
    },
  );

  return fixtures.sort((left, right) => {
    if (left.sampleName === DEFAULT_SAM3_FIXTURE_SAMPLE_NAME) {
      return -1;
    }

    if (right.sampleName === DEFAULT_SAM3_FIXTURE_SAMPLE_NAME) {
      return 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

function requireSam3Fixture(fixture: Sam3FixtureDefinition | undefined) {
  if (!fixture) {
    throw new Error("No SAM3 demo fixture metadata was found.");
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

export function summarizeSam3FixtureManifest(
  manifest: Sam3FixtureDetectionManifest,
  definition: Sam3FixtureDefinition = defaultSam3Fixture,
): Sam3FixtureSummary {
  return {
    classNames: manifest.inference.prompts ?? [],
    detectionCount: manifest.detectionCount ?? 0,
    duration: manifest.video.duration,
    frameCount: manifest.frameCount ?? 0,
    fixtureName: definition.displayName,
    inferenceFrameRate: manifest.inference.frameRate,
    inferenceLabel: definition.inferenceLabel,
    maskHeight: manifest.inference.mask.height,
    maskWidth: manifest.inference.mask.width,
    missingFrameIndexes: manifest.inference.missingFrameIndexes,
  };
}

function summarizeSam3FixtureDetectionSource(
  manifest: Sam3FixtureDetectionManifest,
): Sam3FixtureDetectionSourceSummary {
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
