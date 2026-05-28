import {
  DetectionMaskEncoding,
  createBrowserColdDetectionFrameStore,
  createColdDetectionFrameSource,
  type ColdDetectionFrameStoreWriteSummary,
  type Detection,
  type DetectionFrame,
  type DetectionFrameSource,
} from "supervision-js";

const basketballSam3SampleVideoSrc = new URL(
  "../../fixtures/basketball_sam3/basketball_sample.normalized.webm",
  import.meta.url,
).href;

const basketballSam3SampleDetectionsSrc = new URL(
  "../../fixtures/basketball_sam3/detections.json",
  import.meta.url,
).href;

const basketballSampleColdChunkDurationSeconds = 1;

export interface BasketballSampleFixtureDefinition {
  readonly datasetId: string;
  readonly detectionsSrc: string;
  readonly displayName: string;
  readonly inferenceLabel: string;
  readonly mediaLoadingStatusLabel: string;
  readonly mediaReadyStatusLabel: string;
  readonly videoSrc: string;
}

export const basketballSam3SampleFixture: BasketballSampleFixtureDefinition = {
  datasetId: "basketball_sam3_v1",
  detectionsSrc: basketballSam3SampleDetectionsSrc,
  displayName: "Basketball / deterministic SAM3",
  inferenceLabel: "SAM3",
  mediaLoadingStatusLabel: "loading deterministic SAM3 normalized WebM",
  mediaReadyStatusLabel: "deterministic SAM3 normalized WebM",
  videoSrc: basketballSam3SampleVideoSrc,
};

export const defaultBasketballSampleFixture = basketballSam3SampleFixture;
export const basketballSampleVideoSrc = defaultBasketballSampleFixture.videoSrc;

export interface BasketballSampleFixture {
  readonly schema: string;
  readonly version: number;
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
  readonly frames: readonly BasketballSampleFrame[];
}

export interface BasketballSampleFrame {
  readonly frameIndex: number;
  readonly mediaTime: number;
  readonly endTime: number;
  readonly detections: readonly BasketballSampleDetection[];
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

export interface BasketballSampleColdDetectionSource {
  readonly datasetId: string;
  readonly detectionSource: DetectionFrameSource;
  readonly fixtureSummary: BasketballSampleSummary;
  readonly status: "ready";
  readonly writeSummary: ColdDetectionFrameStoreWriteSummary;
  destroy(): void;
}

export interface BasketballSampleMediaSource {
  readonly src: string;
  readonly error: Error | null;
  readonly statusLabel: string;
}

export async function loadBasketballSampleFixture(
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): Promise<BasketballSampleFixture> {
  const response = await fetch(definition.detectionsSrc);

  if (!response.ok) {
    throw new Error(
      `Unable to load basketball detections fixture: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as BasketballSampleFixture;
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

export async function createBasketballSampleColdDetectionSource(
  fixture: BasketballSampleFixture,
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): Promise<BasketballSampleColdDetectionSource> {
  const frames = toDetectionFrames(fixture);
  const store = createBrowserColdDetectionFrameStore();
  const writeSummary = await store.putFrames({
    chunkDurationSeconds: basketballSampleColdChunkDurationSeconds,
    datasetId: definition.datasetId,
    frames,
  });
  const coldSource = createColdDetectionFrameSource({
    datasetId: definition.datasetId,
    store,
  });
  let destroyed = false;
  const destroy = () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    store.destroy?.();
  };

  return {
    datasetId: definition.datasetId,
    detectionSource: {
      destroy,
      loadFrames: coldSource.loadFrames,
    },
    destroy,
    fixtureSummary: summarizeBasketballSampleFixture(fixture, definition),
    status: "ready",
    writeSummary,
  };
}

export function toDetectionFrames(
  fixture: BasketballSampleFixture,
): DetectionFrame[] {
  return fixture.frames.map((frame) => ({
    detections: frame.detections,
    endTime: frame.endTime,
    frameIndex: frame.frameIndex,
    mediaTime: frame.mediaTime,
  }));
}

export function summarizeBasketballSampleFixture(
  fixture: BasketballSampleFixture,
  definition: BasketballSampleFixtureDefinition = defaultBasketballSampleFixture,
): BasketballSampleSummary {
  return {
    detectionCount: fixture.frames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    ),
    duration: fixture.video.duration,
    frameCount: fixture.frames.length,
    fixtureName: definition.displayName,
    inferenceFrameRate: fixture.inference.frameRate,
    inferenceLabel: definition.inferenceLabel,
    maskHeight: fixture.inference.mask.height,
    maskWidth: fixture.inference.mask.width,
    missingFrameIndexes: fixture.inference.missingFrameIndexes,
  };
}
