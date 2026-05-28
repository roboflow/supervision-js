import {
  BoxShape,
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  normalizeMedia,
  type BoxDrawInstruction,
  type BoxStyle,
  type Detection,
  type DetectionFrame,
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
  readonly detections: readonly Detection[];
}

export interface BasketballSampleSummary {
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly missingFrameIndexes: readonly number[];
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

const classStyles: Record<
  string,
  {
    readonly fill: number;
    readonly stroke: number;
    readonly strokeWidth: number;
  }
> = {
  basketball: {
    fill: 0xff7a1a,
    stroke: 0xffa23a,
    strokeWidth: 3,
  },
  "white team player": {
    fill: 0xf8fafc,
    stroke: 0xffffff,
    strokeWidth: 4,
  },
  "yellow team player": {
    fill: 0xfacc15,
    stroke: 0xfde047,
    strokeWidth: 4,
  },
};

const fallbackStyle = {
  fill: 0x38bdf8,
  stroke: 0x7dd3fc,
  strokeWidth: 3,
};

export const basketballSampleBoxStyle: BoxStyle = {
  resolve(detection: Detection): BoxDrawInstruction | undefined {
    if (!detection.rect) {
      return undefined;
    }

    const style = detection.className
      ? (classStyles[detection.className] ?? fallbackStyle)
      : fallbackStyle;

    return {
      fill: {
        alpha: detection.className === "basketball" ? 0.16 : 0.08,
        color: style.fill,
      },
      rect: detection.rect,
      shape: BoxShape.RoundedRect,
      stroke: {
        alpha: 0.95,
        color: style.stroke,
        width: style.strokeWidth,
      },
      cornerRadius: detection.className === "basketball" ? 12 : 8,
    };
  },
};

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

export function toDetectionFrames(
  fixture: BasketballSampleFixture,
): DetectionFrame[] {
  return fixture.frames.map((frame) => ({
    detections: frame.detections,
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
