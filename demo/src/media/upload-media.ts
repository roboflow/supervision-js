import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  normalizeMedia,
  type MediaNormalizationProgress,
} from "supervision-js";
import type { WrappedCanvas } from "mediabunny";

const TARGET_FRAME_RATE = 30;
const NORMALIZED_VIDEO_BITRATE = 8_000_000;
const IMAGE_MEDIA_DURATION_SECONDS = 1;
const IMAGE_MEDIA_BITRATE = 8_000_000;
const DEFAULT_JPEG_QUALITY = 0.9;
const DEFAULT_FRAME_BATCH_SIZE = 30;

export enum UploadedMediaKind {
  Image = "image",
  Video = "video",
}

export interface PreparedUploadMedia {
  readonly blob: Blob;
  readonly duration: number;
  readonly frameCount: number;
  readonly frameRate: number;
  readonly height: number;
  readonly kind: UploadedMediaKind;
  readonly objectUrl: string;
  readonly statusLabel: string;
  readonly width: number;
}

export interface ExtractedInferenceFrame {
  readonly frameIndex: number;
  readonly mediaTime: number;
  readonly duration: number;
  readonly imageBase64: string;
}

export async function prepareUploadedMedia(options: {
  readonly file: File;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MediaNormalizationProgress) => void;
}): Promise<PreparedUploadMedia> {
  if (options.file.type.startsWith("image/")) {
    return prepareUploadedImage(options);
  }

  return prepareUploadedVideo(options);
}

export async function* extractInferenceFrameBatches(options: {
  readonly media: PreparedUploadMedia;
  readonly batchSize?: number;
  readonly quality?: number;
  readonly signal?: AbortSignal;
}): AsyncGenerator<readonly ExtractedInferenceFrame[], void, unknown> {
  const { BlobSource, CanvasSink, Input, WEBM } = await import("mediabunny");
  const input = new Input({
    formats: [WEBM],
    source: new BlobSource(options.media.blob),
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();

    if (!videoTrack) {
      throw new Error("Prepared upload media has no video track.");
    }

    const sink = new CanvasSink(videoTrack, { poolSize: 4 });
    const batchSize = options.batchSize ?? DEFAULT_FRAME_BATCH_SIZE;
    const quality = options.quality ?? DEFAULT_JPEG_QUALITY;

    for (
      let startFrameIndex = 0;
      startFrameIndex < options.media.frameCount;
      startFrameIndex += batchSize
    ) {
      throwIfAborted(options.signal);
      const count = Math.min(
        batchSize,
        options.media.frameCount - startFrameIndex,
      );
      const frameIndexes = Array.from(
        { length: count },
        (_, offset) => startFrameIndex + offset,
      );
      const sampleQueryTimes = frameIndexes.map(
        (frameIndex) => (frameIndex + 0.5) / options.media.frameRate,
      );
      const frames: ExtractedInferenceFrame[] = [];
      let frameOffset = 0;

      for await (const wrappedCanvas of sink.canvasesAtTimestamps(
        sampleQueryTimes,
        { skipLiveWait: true },
      )) {
        throwIfAborted(options.signal);
        const frameIndex = frameIndexes[frameOffset];

        frameOffset += 1;

        if (frameIndex === undefined) {
          break;
        }

        if (!wrappedCanvas) {
          throw new Error(`Unable to decode uploaded frame #${frameIndex}.`);
        }

        frames.push(
          await createExtractedInferenceFrame({
            frameIndex,
            quality,
            wrappedCanvas,
          }),
        );
      }

      if (frames.length > 0) {
        yield frames;
      }
    }
  } finally {
    input.dispose();
  }
}

async function prepareUploadedVideo(options: {
  readonly file: File;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MediaNormalizationProgress) => void;
}): Promise<PreparedUploadMedia> {
  const normalizedMedia = await normalizeMedia(options.file, {
    audio: { discard: true },
    container: MediaNormalizationContainer.WebM,
    onProgress: options.onProgress,
    signal: options.signal,
    video: {
      bitrate: NORMALIZED_VIDEO_BITRATE,
      codec: MediaNormalizationVideoCodec.Vp9,
      forceTranscode: true,
      frameRate: TARGET_FRAME_RATE,
      keyFrameInterval: 1,
    },
  });
  const metadata = normalizedMedia.inputMetadata;
  const duration = metadata.duration ?? 0;
  const width = metadata.primaryVideoWidth ?? 0;
  const height = metadata.primaryVideoHeight ?? 0;

  return {
    blob: normalizedMedia.blob,
    duration,
    frameCount: Math.max(1, Math.ceil(duration * TARGET_FRAME_RATE)),
    frameRate: TARGET_FRAME_RATE,
    height,
    kind: UploadedMediaKind.Video,
    objectUrl: URL.createObjectURL(normalizedMedia.blob),
    statusLabel: `upload normalized WebM ${TARGET_FRAME_RATE}fps | ${formatMbps(
      NORMALIZED_VIDEO_BITRATE,
    )}`,
    width,
  };
}

async function prepareUploadedImage(options: {
  readonly file: File;
  readonly signal?: AbortSignal;
}): Promise<PreparedUploadMedia> {
  throwIfAborted(options.signal);
  const bitmap = await createImageBitmap(options.file);

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create image upload canvas.");
    }

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    context.drawImage(bitmap, 0, 0);

    const blob = await encodeCanvasAsWebM(canvas, options.signal);

    return {
      blob,
      duration: IMAGE_MEDIA_DURATION_SECONDS,
      frameCount: 1,
      frameRate: TARGET_FRAME_RATE,
      height: canvas.height,
      kind: UploadedMediaKind.Image,
      objectUrl: URL.createObjectURL(blob),
      statusLabel: "image upload encoded as one-frame WebM",
      width: canvas.width,
    };
  } finally {
    bitmap.close();
  }
}

async function encodeCanvasAsWebM(
  canvas: HTMLCanvasElement,
  signal: AbortSignal | undefined,
) {
  throwIfAborted(signal);
  const { BufferTarget, CanvasSource, Output, WebMOutputFormat } =
    await import("mediabunny");
  const target = new BufferTarget();
  const output = new Output({
    format: new WebMOutputFormat(),
    target,
  });
  const source = new CanvasSource(canvas, {
    bitrate: IMAGE_MEDIA_BITRATE,
    codec: "vp9",
    keyFrameInterval: 1,
  });

  output.addVideoTrack(source);
  await output.start();
  throwIfAborted(signal);
  await source.add(0, IMAGE_MEDIA_DURATION_SECONDS, { keyFrame: true });
  await output.finalize();

  if (!target.buffer) {
    throw new Error("Mediabunny image encoding completed without output data.");
  }

  return new Blob([target.buffer], { type: "video/webm" });
}

async function createExtractedInferenceFrame(options: {
  readonly frameIndex: number;
  readonly quality: number;
  readonly wrappedCanvas: WrappedCanvas;
}): Promise<ExtractedInferenceFrame> {
  return {
    duration: options.wrappedCanvas.duration,
    frameIndex: options.frameIndex,
    imageBase64: await canvasToJpegBase64(
      options.wrappedCanvas.canvas,
      options.quality,
    ),
    mediaTime: options.wrappedCanvas.timestamp,
  };
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
          reject(new Error("Unable to encode upload frame as JPEG."));
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
        reject(new Error("Unable to read encoded upload frame."));
        return;
      }

      resolve(reader.result);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Unable to read encoded upload frame."));
    });
    reader.readAsDataURL(blob);
  });
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new Error("Upload media processing was aborted.");
  }
}

function formatMbps(bitrate: number) {
  return `${bitrate / 1_000_000}Mbps`;
}
