import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  EncodedPacketSink,
  Input,
  type InputVideoTrack,
} from "mediabunny";

import {
  assertDecodedFrameTimestamp,
  buildFrameTimeTable,
  mapFrameBatch,
  type FramePacketTiming,
  type FrameTimeTable,
} from "./frame-time-table";
import "./style.css";

const DEFAULT_SOURCE_URL = new URL(
  "../../../demo/fixtures/basketball_sample/basketball_sample.mp4",
  import.meta.url,
).href;
const DEFAULT_SAMPLE_NAME = "basketball_sam3";
const DEFAULT_SOURCE_FILE = "basketball_sample.mp4";
const DEFAULT_JPEG_QUALITY = 0.92;

interface Sam3FixturePrepareOptions {
  readonly sampleName?: string;
  readonly sourceFile?: string;
  readonly sourceUrl?: string;
}

interface Sam3FixtureConfig {
  readonly sampleName: string;
  readonly sourceFile: string;
  readonly sourceUrl: string;
}

interface Sam3FixtureManifest {
  readonly schema: "supervision-js.tools.sam3-fixture.manifest";
  readonly version: 2;
  readonly sampleName: string;
  readonly source: {
    readonly url: string;
    readonly file: string;
    readonly size: number;
    readonly mimeType: string | null;
  };
  readonly video: {
    readonly width: number;
    readonly height: number;
    readonly duration: number;
    readonly firstTimestamp: number;
    readonly frameCount: number;
    readonly frameRate: number;
    readonly averagePacketRate: number;
    readonly frameIndexRoundTripError: number;
    /** Version 1 name for `frameCount`, kept for readers of older manifests. */
    readonly estimatedFrameCount: number;
  };
}

interface Sam3FrameBatchOptions {
  readonly startFrameIndex: number;
  readonly count: number;
  readonly processedFrameCount?: number;
  readonly quality?: number;
  readonly totalFrameCount?: number;
}

interface Sam3ExtractedFrame {
  readonly schema: "supervision-js.tools.sam3-fixture.extracted-frame";
  readonly version: 2;
  readonly frameIndex: number;
  readonly mediaTime: number;
  readonly endTime: number;
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

interface Sam3FrameBatch {
  readonly schema: "supervision-js.tools.sam3-fixture.frame-batch";
  readonly version: 2;
  readonly startFrameIndex: number;
  readonly count: number;
  readonly quality: number;
  readonly frames: readonly Sam3ExtractedFrame[];
}

declare global {
  interface Window {
    prepareSam3Fixture: (
      options?: Sam3FixturePrepareOptions,
    ) => Promise<Sam3FixtureManifest>;
    getSam3FrameBatch: (
      options: Sam3FrameBatchOptions,
    ) => Promise<Sam3FrameBatch>;
    getSam3FixtureManifest: () => Sam3FixtureManifest | null;
    prepareBasketballSam3Fixture: () => Promise<Sam3FixtureManifest>;
    getBasketballSam3FrameBatch: (
      options: Sam3FrameBatchOptions,
    ) => Promise<Sam3FrameBatch>;
    getBasketballSam3FixtureManifest: () => Sam3FixtureManifest | null;
  }
}

let preparePromise: Promise<Sam3FixtureManifest> | undefined;
let preparedConfigKey: string | undefined;
let sourceInput: Input | undefined;
let canvasSink: CanvasSink | undefined;
let frameTimeTable: FrameTimeTable | undefined;
let manifest: Sam3FixtureManifest | null = null;

const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const outputElement = document.querySelector<HTMLPreElement>("#output");
const prepareButton = document.querySelector<HTMLButtonElement>("#prepare");
const sampleButton = document.querySelector<HTMLButtonElement>("#sample");

function setStatus(message: string) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function setProgressStatus(label: string, progress: number) {
  setStatus(`${label} ${formatProgressPercent(progress)}`);
}

function formatProgressPercent(progress: number) {
  const clampedProgress = Math.min(1, Math.max(0, progress));

  return `${Math.round(clampedProgress * 100)}%`;
}

function setOutput(value: unknown) {
  if (outputElement) {
    outputElement.textContent = JSON.stringify(value, null, 2);
  }
}

async function prepareSam3Fixture(
  options: Sam3FixturePrepareOptions = {},
): Promise<Sam3FixtureManifest> {
  const config = createFixtureConfig(options);
  const configKey = createFixtureConfigKey(config);

  if (preparedConfigKey !== configKey) {
    disposeSourceInput();
    preparePromise = undefined;
    preparedConfigKey = configKey;
  }

  preparePromise ??= prepareFixture(config);

  return preparePromise;
}

async function prepareFixture(
  config: Sam3FixtureConfig,
): Promise<Sam3FixtureManifest> {
  setProgressStatus("Loading source media", 0);

  const sourceResponse = await fetch(config.sourceUrl);

  if (!sourceResponse.ok) {
    throw new Error(
      `Unable to fetch ${config.sourceFile}: ${sourceResponse.status} ${sourceResponse.statusText}`,
    );
  }

  const sourceBlob = await sourceResponse.blob();

  setProgressStatus("Reading source frames", 0);
  sourceInput = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(sourceBlob),
  });

  const videoTrack = await sourceInput.getPrimaryVideoTrack();

  if (!videoTrack) {
    throw new Error(`${config.sourceFile} has no video track.`);
  }

  canvasSink = new CanvasSink(videoTrack);
  frameTimeTable = await buildFrameTimeTable(iteratePacketTimings(videoTrack));

  const [width, height] = await Promise.all([
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
  ]);

  manifest = {
    sampleName: config.sampleName,
    schema: "supervision-js.tools.sam3-fixture.manifest",
    source: {
      file: config.sourceFile,
      mimeType: sourceBlob.type || null,
      size: sourceBlob.size,
      url: config.sourceUrl,
    },
    version: 2,
    video: {
      averagePacketRate: frameTimeTable.averagePacketRate,
      duration: frameTimeTable.duration,
      estimatedFrameCount: frameTimeTable.frameCount,
      firstTimestamp: frameTimeTable.firstTimestamp,
      frameCount: frameTimeTable.frameCount,
      frameIndexRoundTripError: frameTimeTable.frameIndexRoundTripError,
      frameRate: frameTimeTable.frameRate,
      height,
      width,
    },
  };

  setProgressStatus("Ready", 1);
  setOutput(manifest);

  return manifest;
}

async function* iteratePacketTimings(
  videoTrack: InputVideoTrack,
): AsyncGenerator<FramePacketTiming> {
  const packetSink = new EncodedPacketSink(videoTrack);
  let packet = await packetSink.getFirstPacket({ metadataOnly: true });

  while (packet) {
    yield { duration: packet.duration, timestamp: packet.timestamp };
    packet = await packetSink.getNextPacket(packet, { metadataOnly: true });
  }
}

async function getSam3FrameBatch(
  options: Sam3FrameBatchOptions,
): Promise<Sam3FrameBatch> {
  manifest ??= await prepareSam3Fixture();

  const activeSink = canvasSink;
  const activeTable = frameTimeTable;

  if (!activeSink || !activeTable) {
    throw new Error("SAM3 fixture extraction is not prepared.");
  }

  const quality = validateQuality(options.quality ?? DEFAULT_JPEG_QUALITY);
  const batchEntries = mapFrameBatch(
    activeTable,
    options.startFrameIndex,
    options.count,
  );
  const frames: Sam3ExtractedFrame[] = [];
  const setExtractionProgress = (extractedFrameCount: number) => {
    setProgressStatus(
      "Extracting frames",
      calculateExtractionProgress(extractedFrameCount, options),
    );
  };

  setExtractionProgress(0);

  let entryOffset = 0;

  for await (const wrappedCanvas of activeSink.canvasesAtTimestamps(
    batchEntries.map((entry) => entry.sampleQueryTime),
    { skipLiveWait: true },
  )) {
    const entry = batchEntries[entryOffset];

    entryOffset += 1;

    if (!entry) {
      break;
    }

    if (!wrappedCanvas) {
      throw new Error(
        `Unable to decode source frame: frameIndex=${entry.frameIndex}, timestamp=${entry.timestamp}.`,
      );
    }

    assertDecodedFrameTimestamp(entry, wrappedCanvas.timestamp);

    const jpegBase64 = await canvasToJpegBase64(wrappedCanvas.canvas, quality);

    frames.push({
      decodedDuration: wrappedCanvas.duration,
      decodedTimestamp: wrappedCanvas.timestamp,
      endTime: entry.endTime,
      frameIndex: entry.frameIndex,
      height: wrappedCanvas.canvas.height,
      image: {
        mimeType: "image/jpeg",
        type: "base64",
        value: jpegBase64,
      },
      jpegBase64,
      mediaTime: entry.timestamp,
      requestedMediaTime: entry.timestamp,
      sampleQueryTime: entry.sampleQueryTime,
      schema: "supervision-js.tools.sam3-fixture.extracted-frame",
      version: 2,
      width: wrappedCanvas.canvas.width,
    });
    setExtractionProgress(frames.length);

    if (frames.length >= batchEntries.length) {
      break;
    }
  }

  if (frames.length < batchEntries.length) {
    throw new Error(
      `Unable to decode requested SAM3 frame batch: startFrameIndex=${options.startFrameIndex}, count=${options.count}, collected=${frames.length}.`,
    );
  }

  const batch = {
    count: batchEntries.length,
    frames,
    quality,
    schema: "supervision-js.tools.sam3-fixture.frame-batch",
    startFrameIndex: options.startFrameIndex,
    version: 2,
  } satisfies Sam3FrameBatch;

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

function calculateExtractionProgress(
  extractedFrameCount: number,
  options: Sam3FrameBatchOptions,
) {
  if (
    options.totalFrameCount !== undefined &&
    options.totalFrameCount > 0 &&
    options.processedFrameCount !== undefined
  ) {
    return (
      (options.processedFrameCount + extractedFrameCount) /
      options.totalFrameCount
    );
  }

  return extractedFrameCount / options.count;
}

function getSam3FixtureManifest() {
  return manifest;
}

function createFixtureConfig(
  options: Sam3FixturePrepareOptions,
): Sam3FixtureConfig {
  return {
    sampleName: options.sampleName?.trim() || DEFAULT_SAMPLE_NAME,
    sourceFile: options.sourceFile?.trim() || DEFAULT_SOURCE_FILE,
    sourceUrl: options.sourceUrl?.trim() || DEFAULT_SOURCE_URL,
  };
}

function createFixtureConfigKey(config: Sam3FixtureConfig) {
  return JSON.stringify(config);
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

function disposeSourceInput() {
  sourceInput?.dispose();
  sourceInput = undefined;
  canvasSink = undefined;
  frameTimeTable = undefined;
  manifest = null;
}

window.prepareSam3Fixture = prepareSam3Fixture;
window.getSam3FrameBatch = getSam3FrameBatch;
window.getSam3FixtureManifest = getSam3FixtureManifest;

window.prepareBasketballSam3Fixture = () => prepareSam3Fixture();
window.getBasketballSam3FrameBatch = getSam3FrameBatch;
window.getBasketballSam3FixtureManifest = getSam3FixtureManifest;

prepareButton?.addEventListener("click", () => {
  prepareButton.disabled = true;
  prepareSam3Fixture()
    .catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Preparation failed.");
    })
    .finally(() => {
      prepareButton.disabled = false;
    });
});

sampleButton?.addEventListener("click", () => {
  sampleButton.disabled = true;
  getSam3FrameBatch({ count: 3, startFrameIndex: 0 })
    .catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Extraction failed.");
    })
    .finally(() => {
      sampleButton.disabled = false;
    });
});
