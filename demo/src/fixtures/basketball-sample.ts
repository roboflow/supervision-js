import {
  DetectionMaskEncoding,
  createChunkedDetectionFrameSource,
  type Detection,
  type DetectionFrameChunkFetch,
  type DetectionFrameChunkManifest,
  type DetectionFrameSource,
} from "supervision-js";

const basketballSam3SampleVideoSrc = new URL(
  "../../fixtures/basketball_sam3/basketball_sample.normalized.webm",
  import.meta.url,
).href;

const basketballSam3SampleDetectionsManifestSrc = new URL(
  "../../fixtures/basketball_sam3/detections.manifest.json",
  import.meta.url,
).href;
const basketballSam3SampleDetectionChunkUrls = import.meta.glob(
  "../../fixtures/basketball_sam3/detections/*.json",
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;

export interface BasketballSampleFixtureDefinition {
  readonly datasetId: string;
  readonly detectionsManifestSrc: string;
  readonly displayName: string;
  readonly inferenceLabel: string;
  readonly mediaLoadingStatusLabel: string;
  readonly mediaReadyStatusLabel: string;
  readonly videoSrc: string;
}

export const basketballSam3SampleFixture: BasketballSampleFixtureDefinition = {
  datasetId: "basketball_sam3_v1",
  detectionsManifestSrc: basketballSam3SampleDetectionsManifestSrc,
  displayName: "Basketball / deterministic SAM3",
  inferenceLabel: "SAM3",
  mediaLoadingStatusLabel: "loading deterministic SAM3 normalized WebM",
  mediaReadyStatusLabel: "deterministic SAM3 normalized WebM",
  videoSrc: basketballSam3SampleVideoSrc,
};

export const defaultBasketballSampleFixture = basketballSam3SampleFixture;
export const basketballSampleVideoSrc = defaultBasketballSampleFixture.videoSrc;

export interface BasketballSampleDetectionManifest extends DetectionFrameChunkManifest {
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

export interface BasketballSampleDetection extends Detection {
  readonly mask: {
    readonly encoding: DetectionMaskEncoding.CompressedRle;
    readonly width: number;
    readonly height: number;
    readonly counts: string;
  };
}

export interface BasketballSampleSummary {
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

export interface BasketballSampleDetectionSourceSummary {
  readonly datasetId: string;
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

export interface BasketballSampleDetectionSource {
  readonly datasetId: string;
  readonly detectionSource: DetectionFrameSource;
  readonly fixtureSummary: BasketballSampleSummary;
  readonly sourceSummary: BasketballSampleDetectionSourceSummary;
  readonly status: "ready";
  destroy(): void;
}

export interface BasketballSampleMediaSource {
  readonly src: string;
  readonly error: Error | null;
  readonly statusLabel: string;
}

export async function loadBasketballSampleDetectionManifest(
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): Promise<BasketballSampleDetectionManifest> {
  const response = await fetch(definition.detectionsManifestSrc);

  if (!response.ok) {
    throw new Error(
      `Unable to load basketball detections fixture: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as BasketballSampleDetectionManifest;
}

export async function loadBasketballSampleMedia(
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): Promise<BasketballSampleMediaSource> {
  return {
    error: null,
    src: definition.videoSrc,
    statusLabel: definition.mediaReadyStatusLabel,
  };
}

export function createBasketballSampleDetectionSource(
  manifest: BasketballSampleDetectionManifest,
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): BasketballSampleDetectionSource {
  const detectionSource = createChunkedDetectionFrameSource({
    baseUrl: definition.detectionsManifestSrc,
    fetchChunk: fetchBasketballSampleDetectionChunk,
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
    fixtureSummary: summarizeBasketballSampleManifest(manifest, definition),
    sourceSummary: summarizeBasketballSampleDetectionSource(manifest),
    status: "ready",
  };
}

const fetchBasketballSampleDetectionChunk: DetectionFrameChunkFetch = async (
  chunk,
) => {
  const chunkUrl =
    basketballSam3SampleDetectionChunkUrls[
      `../../fixtures/basketball_sam3/${chunk.src}`
    ];

  if (!chunkUrl) {
    throw new Error(`Unknown basketball detection chunk: ${chunk.src}`);
  }

  const response = await fetch(chunkUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to load basketball detection chunk ${chunk.src}: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as Awaited<
    ReturnType<DetectionFrameChunkFetch>
  >;
};

export function summarizeBasketballSampleManifest(
  manifest: BasketballSampleDetectionManifest,
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): BasketballSampleSummary {
  return {
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

function summarizeBasketballSampleDetectionSource(
  manifest: BasketballSampleDetectionManifest,
): BasketballSampleDetectionSourceSummary {
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
