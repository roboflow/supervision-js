import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  normalizeMedia,
  type MediaNormalizationProgress,
  type NormalizedMedia,
} from "supervision-js";
import { BlobSource, CanvasSink, Input, WEBM } from "mediabunny";

import "./style.css";

const BASKETBALL_SAMPLE_VIDEO_URL = new URL(
  "../../../demo/fixtures/basketball_sample/basketball_sample.mp4",
  import.meta.url,
).href;
const TARGET_FRAME_RATE = 30;
const DEFAULT_JPEG_QUALITY = 0.92;
const FRAME_SLOT_TOLERANCE_SECONDS = 0.005;

interface BasketballSam3FixtureManifest {
  readonly schema: "supervision-js.tools.sam3-fixture.manifest";
  readonly version: 1;
  readonly source: {
    readonly url: string;
    readonly file: "basketball_sample.mp4";
    readonly size: number;
    readonly mimeType: string | null;
  };
  readonly normalized: {
    readonly container: MediaNormalizationContainer.WebM;
    readonly codec: MediaNormalizationVideoCodec.Vp9;
    readonly frameRate: 30;
    readonly keyFrameInterval: 1;
    readonly audio: "discarded";
    readonly mimeType: string;
    readonly size: number;
  };
  readonly video: {
    readonly width: number;
    readonly height: number;
    readonly duration: number | null;
    readonly estimatedFrameCount: number | null;
  };
}

interface BasketballSam3FrameBatchOptions {
  readonly startFrameIndex: number;
  readonly count: number;
  readonly quality?: number;
}

interface BasketballSam3ExtractedFrame {
  readonly schema: "supervision-js.tools.sam3-fixture.extracted-frame";
  readonly version: 1;
  readonly frameIndex: number;
  readonly mediaTime: number;
  readonly requestedMediaTime: number;
  readonly sampleQueryTime: number;
  readonly decodedTimestamp: number;
  readonly decodedDuration: number;
  readonly width: number;
  readonly height: number;
  readonly image: {
    readonly type: "base64";
    readonly mimeType: "image/jpeg";
    readonly value: string;
  };
  readonly jpegBase64: string;
}

interface BasketballSam3FrameBatch {
  readonly schema: "supervision-js.tools.sam3-fixture.frame-batch";
  readonly version: 1;
  readonly startFrameIndex: number;
  readonly count: number;
  readonly quality: number;
  readonly frames: readonly BasketballSam3ExtractedFrame[];
}

interface BasketballSam3NormalizedMedia {
  readonly schema: "supervision-js.tools.sam3-fixture.normalized-media";
  readonly version: 1;
  readonly mimeType: string;
  readonly extension: "webm";
  readonly size: number;
  readonly base64: string;
}

declare global {
  interface Window {
    prepareBasketballSam3Fixture: () => Promise<BasketballSam3FixtureManifest>;
    getBasketballSam3NormalizedMedia: () => Promise<BasketballSam3NormalizedMedia>;
    getBasketballSam3FrameBatch: (
      options: BasketballSam3FrameBatchOptions,
    ) => Promise<BasketballSam3FrameBatch>;
    getBasketballSam3FixtureManifest: () => BasketballSam3FixtureManifest | null;
  }
}

let preparePromise: Promise<BasketballSam3FixtureManifest> | undefined;
let normalizedInput: Input | undefined;
let normalizedBlob: Blob | undefined;
let canvasSink: CanvasSink | undefined;
let manifest: BasketballSam3FixtureManifest | null = null;

const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const outputElement = document.querySelector<HTMLPreElement>("#output");
const prepareButton = document.querySelector<HTMLButtonElement>("#prepare");
const sampleButton = document.querySelector<HTMLButtonElement>("#sample");

function setStatus(message: string) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function setOutput(value: unknown) {
  if (outputElement) {
    outputElement.textContent = JSON.stringify(value, null, 2);
  }
}

async function prepareBasketballSam3Fixture() {
  preparePromise ??= prepareFixture();
  return preparePromise;
}

async function prepareFixture(): Promise<BasketballSam3FixtureManifest> {
  disposeNormalizedInput();
  setStatus("Fetching basketball_sample.mp4...");

  const sourceResponse = await fetch(BASKETBALL_SAMPLE_VIDEO_URL);

  if (!sourceResponse.ok) {
    throw new Error(
      `Unable to fetch basketball_sample.mp4: ${sourceResponse.status} ${sourceResponse.statusText}`,
    );
  }

  const sourceBlob = await sourceResponse.blob();
  setStatus("Normalizing to WebM VP9 at 30fps...");

  const normalized = await normalizeBasketballSource(sourceBlob, (progress) => {
    setStatus(
      `Normalizing to WebM VP9 at 30fps... ${Math.round(
        progress.progress * 100,
      )}%`,
    );
  });
  normalizedBlob = normalized.blob;

  setStatus("Opening normalized WebM...");
  normalizedInput = new Input({
    formats: [WEBM],
    source: new BlobSource(normalizedBlob),
  });

  const videoTrack = await normalizedInput.getPrimaryVideoTrack();

  if (!videoTrack) {
    throw new Error("The normalized basketball sample has no video track.");
  }

  canvasSink = new CanvasSink(videoTrack);

  const [width, height, metadataDuration, computedDuration] = await Promise.all(
    [
      videoTrack.getDisplayWidth(),
      videoTrack.getDisplayHeight(),
      normalizedInput.getDurationFromMetadata(undefined, {
        skipLiveWait: true,
      }),
      videoTrack.computeDuration({ skipLiveWait: true }),
    ],
  );
  const duration = computedDuration || metadataDuration;

  manifest = {
    normalized: {
      audio: "discarded",
      codec: MediaNormalizationVideoCodec.Vp9,
      container: MediaNormalizationContainer.WebM,
      frameRate: TARGET_FRAME_RATE,
      keyFrameInterval: 1,
      mimeType: normalized.mimeType,
      size: normalized.size,
    },
    schema: "supervision-js.tools.sam3-fixture.manifest",
    source: {
      file: "basketball_sample.mp4",
      mimeType: sourceBlob.type || null,
      size: sourceBlob.size,
      url: BASKETBALL_SAMPLE_VIDEO_URL,
    },
    version: 1,
    video: {
      duration,
      estimatedFrameCount:
        duration === null ? null : Math.ceil(duration * TARGET_FRAME_RATE),
      height,
      width,
    },
  };

  setStatus("Ready");
  setOutput(manifest);

  return manifest;
}

async function getBasketballSam3NormalizedMedia(): Promise<BasketballSam3NormalizedMedia> {
  await prepareBasketballSam3Fixture();

  if (!normalizedBlob) {
    throw new Error("Basketball SAM3 normalized media is not prepared.");
  }

  const dataUrl = await blobToDataUrl(normalizedBlob);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const normalizedMedia = {
    base64,
    extension: "webm",
    mimeType:
      normalizedBlob.type || manifest?.normalized.mimeType || "video/webm",
    schema: "supervision-js.tools.sam3-fixture.normalized-media",
    size: normalizedBlob.size,
    version: 1,
  } satisfies BasketballSam3NormalizedMedia;

  setStatus(
    `Ready: normalized ${normalizedMedia.extension.toUpperCase()} media (${normalizedMedia.size} bytes).`,
  );
  setOutput({
    ...normalizedMedia,
    base64: `${normalizedMedia.base64.slice(0, 48)}...`,
  });

  return normalizedMedia;
}

async function normalizeBasketballSource(
  sourceBlob: Blob,
  onProgress: (progress: MediaNormalizationProgress) => void,
): Promise<NormalizedMedia> {
  return normalizeMedia(sourceBlob, {
    audio: { discard: true },
    container: MediaNormalizationContainer.WebM,
    onProgress,
    video: {
      codec: MediaNormalizationVideoCodec.Vp9,
      forceTranscode: true,
      frameRate: TARGET_FRAME_RATE,
      keyFrameInterval: 1,
    },
  });
}

async function getBasketballSam3FrameBatch(
  options: BasketballSam3FrameBatchOptions,
): Promise<BasketballSam3FrameBatch> {
  const preparedManifest = await prepareBasketballSam3Fixture();
  const activeSink = canvasSink;

  if (!activeSink) {
    throw new Error("Basketball SAM3 fixture extraction is not prepared.");
  }

  const startFrameIndex = validateFrameIndex(options.startFrameIndex);
  const count = validateCount(options.count);
  const quality = validateQuality(options.quality ?? DEFAULT_JPEG_QUALITY);
  const frameIndexes = Array.from(
    { length: count },
    (_, offset) => startFrameIndex + offset,
  );
  const sampleQueryTimes = frameIndexes.map(
    (frameIndex) => (frameIndex + 0.5) / TARGET_FRAME_RATE,
  );
  const frames: BasketballSam3ExtractedFrame[] = [];

  setStatus(
    `Extracting ${count} frame${count === 1 ? "" : "s"} from index ${startFrameIndex}...`,
  );

  let frameOffset = 0;

  for await (const wrappedCanvas of activeSink.canvasesAtTimestamps(
    sampleQueryTimes,
    { skipLiveWait: true },
  )) {
    const frameIndex = frameIndexes[frameOffset];
    const sampleQueryTime = sampleQueryTimes[frameOffset];

    frameOffset += 1;

    if (frameIndex === undefined || sampleQueryTime === undefined) {
      break;
    }

    if (!wrappedCanvas) {
      throw new Error(
        `Unable to decode requested basketball SAM3 frame: frameIndex=${frameIndex}, sampleQueryTime=${sampleQueryTime}.`,
      );
    }

    const requestedMediaTime = frameIndex / TARGET_FRAME_RATE;
    const decodedTimestampOffset = Math.abs(
      wrappedCanvas.timestamp - requestedMediaTime,
    );

    if (decodedTimestampOffset > FRAME_SLOT_TOLERANCE_SECONDS) {
      throw new Error(
        `Decoded frame timestamp drifted from the requested slot: frameIndex=${frameIndex}, requested=${requestedMediaTime}, decoded=${wrappedCanvas.timestamp}.`,
      );
    }

    const jpegBase64 = await canvasToJpegBase64(wrappedCanvas.canvas, quality);

    frames.push({
      decodedDuration: wrappedCanvas.duration,
      decodedTimestamp: wrappedCanvas.timestamp,
      frameIndex,
      height: wrappedCanvas.canvas.height,
      image: {
        mimeType: "image/jpeg",
        type: "base64",
        value: jpegBase64,
      },
      jpegBase64,
      mediaTime: wrappedCanvas.timestamp,
      requestedMediaTime,
      sampleQueryTime,
      schema: "supervision-js.tools.sam3-fixture.extracted-frame",
      version: 1,
      width: wrappedCanvas.canvas.width,
    });

    if (frames.length >= count) {
      break;
    }
  }

  if (frames.length < count) {
    throw new Error(
      `Unable to decode requested basketball SAM3 frame batch: startFrameIndex=${startFrameIndex}, count=${count}, collected=${frames.length}.`,
    );
  }

  const batch = {
    count,
    frames,
    quality,
    schema: "supervision-js.tools.sam3-fixture.frame-batch",
    startFrameIndex,
    version: 1,
  } satisfies BasketballSam3FrameBatch;

  setStatus(
    `Ready: extracted ${frames.length} frame${frames.length === 1 ? "" : "s"} from ${preparedManifest.video.width}x${preparedManifest.video.height} normalized media.`,
  );
  setOutput({
    ...batch,
    frames: batch.frames.map((frame) => ({
      ...frame,
      image: { ...frame.image, value: `${frame.image.value.slice(0, 48)}...` },
      jpegBase64: `${frame.jpegBase64.slice(0, 48)}...`,
    })),
  });

  return batch;
}

function getBasketballSam3FixtureManifest() {
  return manifest;
}

function validateFrameIndex(value: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("startFrameIndex must be a non-negative integer.");
  }

  return value;
}

function validateCount(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("count must be a positive integer.");
  }

  return value;
}

function validateQuality(value: number) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      "quality must be greater than 0 and less than or equal to 1.",
    );
  }

  return value;
}

async function canvasToJpegBase64(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
) {
  const blob =
    canvas instanceof HTMLCanvasElement
      ? await htmlCanvasToBlob(canvas, quality)
      : await canvas.convertToBlob({ quality, type: "image/jpeg" });
  const dataUrl = await blobToDataUrl(blob);

  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function htmlCanvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Unable to encode canvas as JPEG."));
          return;
        }

        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to read blob as a data URL."));
        return;
      }

      resolve(reader.result);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Unable to read blob."));
    });
    reader.readAsDataURL(blob);
  });
}

function disposeNormalizedInput() {
  normalizedInput?.dispose();
  normalizedInput = undefined;
  normalizedBlob = undefined;
  canvasSink = undefined;
  manifest = null;
}

window.prepareBasketballSam3Fixture = prepareBasketballSam3Fixture;
window.getBasketballSam3NormalizedMedia = getBasketballSam3NormalizedMedia;
window.getBasketballSam3FrameBatch = getBasketballSam3FrameBatch;
window.getBasketballSam3FixtureManifest = getBasketballSam3FixtureManifest;

prepareButton?.addEventListener("click", () => {
  prepareButton.disabled = true;
  prepareBasketballSam3Fixture()
    .catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Preparation failed.");
    })
    .finally(() => {
      prepareButton.disabled = false;
    });
});

sampleButton?.addEventListener("click", () => {
  sampleButton.disabled = true;
  getBasketballSam3FrameBatch({ count: 3, startFrameIndex: 0 })
    .catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Extraction failed.");
    })
    .finally(() => {
      sampleButton.disabled = false;
    });
});
