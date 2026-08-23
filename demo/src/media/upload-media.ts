import type { DecodedVideoSampleSink, MediaRenderer } from "supervision";

export const TARGET_UPLOAD_FRAME_RATE = 30;
const IMAGE_MEDIA_DURATION_SECONDS = 1;
const IMAGE_MEDIA_BITRATE = 8_000_000;
const DEFAULT_JPEG_QUALITY = 0.9;
const DEFAULT_FRAME_BATCH_SIZE = 30;

export enum UploadedMediaKind {
  Image = "image",
  Video = "video",
}

export interface PreparedUploadMedia {
  readonly blob: Blob | null;
  readonly duration: number;
  readonly frameCount: number;
  readonly frameRate: number;
  readonly height: number;
  readonly kind: UploadedMediaKind;
  readonly sourceFile: File | null;
  readonly statusLabel: string;
  readonly width: number;
}

export interface ExtractedInferenceFrame {
  readonly frameIndex: number;
  readonly mediaTime: number;
  readonly duration: number;
  readonly imageBase64: string;
}

export function createPreparedUploadedVideoMedia(options: {
  readonly file: File;
  readonly renderer: MediaRenderer;
}): PreparedUploadMedia {
  const state = options.renderer.getState();
  const duration = state.duration ?? 0;

  return {
    blob: null,
    duration,
    frameCount: Math.max(1, Math.ceil(duration * TARGET_UPLOAD_FRAME_RATE)),
    frameRate: TARGET_UPLOAD_FRAME_RATE,
    height: state.mediaHeight,
    kind: UploadedMediaKind.Video,
    sourceFile: options.file,
    statusLabel: `upload played from source ${options.file.type || "video"}`,
    width: state.mediaWidth,
  };
}

export async function prepareUploadedImageMedia(options: {
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
      frameRate: TARGET_UPLOAD_FRAME_RATE,
      height: canvas.height,
      kind: UploadedMediaKind.Image,
      sourceFile: null,
      statusLabel: "image upload encoded as one-frame WebM",
      width: canvas.width,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Frames are queried on a synthetic `frameRate` grid rather than the media's
 * own, because that grid is what the session pairs detections against.
 */
export async function* extractInferenceFrameBatches(options: {
  readonly media: PreparedUploadMedia;
  readonly sampleSink: DecodedVideoSampleSink;
  readonly batchSize?: number;
  readonly quality?: number;
  readonly signal?: AbortSignal;
}): AsyncGenerator<readonly ExtractedInferenceFrame[], void, unknown> {
  const batchSize = options.batchSize ?? DEFAULT_FRAME_BATCH_SIZE;
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
  const canvas = new OffscreenCanvas(options.media.width, options.media.height);
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new Error("Unable to create upload inference canvas.");
  }

  let frames: ExtractedInferenceFrame[] = [];

  for (
    let frameIndex = 0;
    frameIndex < options.media.frameCount;
    frameIndex += 1
  ) {
    throwIfAborted(options.signal);

    const sample = await options.sampleSink.getSample(
      (frameIndex + 0.5) / options.media.frameRate,
      { skipLiveWait: true },
    );

    if (!sample) {
      throw new Error(`Unable to decode uploaded frame #${frameIndex}.`);
    }

    try {
      sample.draw(context, 0, 0, canvas.width, canvas.height);
    } finally {
      sample.close();
    }

    frames.push({
      duration: sample.duration,
      frameIndex,
      imageBase64: await canvasToJpegBase64(canvas, quality),
      mediaTime: sample.timestamp,
    });

    if (frames.length === batchSize) {
      yield frames;
      frames = [];
    }
  }

  if (frames.length > 0) {
    yield frames;
  }
}

async function encodeCanvasAsWebM(
  canvas: HTMLCanvasElement,
  signal: AbortSignal | undefined,
) {
  throwIfAborted(signal);
  const { BufferTarget, CanvasSource, Output, Quality, WebMOutputFormat } =
    await import("mediabunny");
  const target = new BufferTarget();
  const output = new Output({
    format: new WebMOutputFormat(),
    target,
  });
  const source = new CanvasSource(canvas, {
    codec: "vp9",
    keyFrameInterval: 1,
    quality: new Quality({ bitrate: IMAGE_MEDIA_BITRATE }),
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

async function canvasToJpegBase64(canvas: OffscreenCanvas, quality: number) {
  const blob = await canvas.convertToBlob({ quality, type: "image/jpeg" });
  const dataUrl = await blobToDataUrl(blob);

  return dataUrl.slice(dataUrl.indexOf(",") + 1);
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
