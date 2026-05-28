import {
  DetectionMaskEncoding,
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  createBrowserColdDetectionFrameStore,
  createColdDetectionFrameSource,
  normalizeMedia,
  type ColdDetectionFrameStoreWriteSummary,
  type Detection,
  type DetectionFrame,
  type DetectionFrameSource,
  type MediaNormalizationProgress,
  type NormalizedMedia,
} from "supervision-js";

export const basketballSampleVideoSrc = new URL(
  "../../fixtures/basketball_sample/basketball_sample.mp4",
  import.meta.url,
).href;

const basketballSampleDetectionsSrc = new URL(
  "../../fixtures/basketball_sample/detections.json",
  import.meta.url,
).href;

const basketballSampleColdDatasetId = "basketball_sample_v1";
const basketballSampleColdChunkDurationSeconds = 1;

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

export interface BasketballSampleMediaOptions {
  readonly onProgress?: (progress: MediaNormalizationProgress) => void;
  readonly timeoutMs?: number;
}

export interface BasketballSampleMediaSource {
  readonly src: string;
  readonly revoke?: () => void;
  readonly normalized: NormalizedMedia | null;
  readonly error: Error | null;
}

export async function loadBasketballSampleFixture(): Promise<BasketballSampleFixture> {
  const response = await fetch(basketballSampleDetectionsSrc);

  if (!response.ok) {
    throw new Error(
      `Unable to load basketball detections fixture: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as BasketballSampleFixture;
}

export async function loadNormalizedBasketballSampleMedia(
  options: BasketballSampleMediaOptions = {},
): Promise<BasketballSampleMediaSource> {
  try {
    const response = await fetch(basketballSampleVideoSrc);

    if (!response.ok) {
      throw new Error(
        `Unable to load basketball video fixture: ${response.status} ${response.statusText}`,
      );
    }

    const sourceBlob = await response.blob();
    const normalized = await normalizeWithTimeout(
      sourceBlob,
      {
        audio: { discard: true },
        container: MediaNormalizationContainer.WebM,
        onProgress: options.onProgress,
        video: {
          codec: MediaNormalizationVideoCodec.Vp9,
          forceTranscode: true,
          frameRate: 30,
          keyFrameInterval: 1,
        },
      },
      options.timeoutMs ?? 12_000,
    );
    const src = URL.createObjectURL(normalized.blob);

    return {
      error: null,
      normalized,
      revoke: () => {
        URL.revokeObjectURL(src);
      },
      src,
    };
  } catch (error: unknown) {
    return {
      error: normalizeError(error),
      normalized: null,
      src: basketballSampleVideoSrc,
    };
  }
}

export async function createBasketballSampleColdDetectionSource(
  fixture: BasketballSampleFixture,
): Promise<BasketballSampleColdDetectionSource> {
  const frames = toDetectionFrames(fixture);
  const store = createBrowserColdDetectionFrameStore();
  const writeSummary = await store.putFrames({
    chunkDurationSeconds: basketballSampleColdChunkDurationSeconds,
    datasetId: basketballSampleColdDatasetId,
    frames,
  });
  const coldSource = createColdDetectionFrameSource({
    datasetId: basketballSampleColdDatasetId,
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
    datasetId: basketballSampleColdDatasetId,
    detectionSource: {
      destroy,
      loadFrames: coldSource.loadFrames,
    },
    destroy,
    fixtureSummary: summarizeBasketballSampleFixture(fixture),
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
): BasketballSampleSummary {
  return {
    detectionCount: fixture.frames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    ),
    duration: fixture.video.duration,
    frameCount: fixture.frames.length,
    missingFrameIndexes: fixture.inference.missingFrameIndexes,
  };
}

async function normalizeWithTimeout(
  sourceBlob: Blob,
  options: Parameters<typeof normalizeMedia>[1],
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      normalizeMedia(sourceBlob, { ...options, signal: controller.signal }),
      new Promise<NormalizedMedia>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `Media normalization did not finish within ${formatInteger(
                timeoutMs,
              )}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error("Unable to normalize basketball media fixture.");
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
