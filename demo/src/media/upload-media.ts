import type {
  DecodedVideoSample,
  DecodedVideoSampleSink,
  MediaRenderer,
} from "supervision";

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
    const timestamps = Array.from(
      { length: count },
      (_, offset) => (startFrameIndex + offset + 0.5) / options.media.frameRate,
    );
    const frames: ExtractedInferenceFrame[] = [];
    let offset = 0;

    for await (const sample of readBatchSamples(
      options.sampleSink,
      timestamps,
    )) {
      const frameIndex = startFrameIndex + offset;

      offset += 1;

      if (!sample) {
        throwIfAborted(options.signal);
        throw new Error(`Unable to decode uploaded frame #${frameIndex}.`);
      }

      const { duration, timestamp } = sample;

      try {
        throwIfAborted(options.signal);
        sample.draw(context, 0, 0, canvas.width, canvas.height);
      } finally {
        sample.close();
      }

      throwIfAborted(options.signal);

      frames.push({
        duration: sampledFrameCoverage(
          timestamp,
          duration,
          frameIndex,
          options.media,
        ),
        frameIndex,
        imageBase64: await canvasToJpegBase64(canvas, quality),
        mediaTime: timestamp,
      });
    }

    if (frames.length > 0) {
      yield frames;
    }
  }
}

/**
 * How long a sampled frame's detections stand.
 *
 * A frame is decoded at its own display time but stands in for the whole grid
 * step the sample was asked for, and the two differ: a clip faster than the
 * grid displays each frame for less than a step, so coverage taken from the
 * display duration stops short of the next sample and the track a viewer sees
 * as continuous is recorded as a comb of slivers with a hole between every
 * pair. Reaching the next sample's request time closes them at any frame rate,
 * and a slower clip keeps its own longer duration.
 */
function sampledFrameCoverage(
  mediaTime: number,
  sampleDuration: number,
  frameIndex: number,
  media: PreparedUploadMedia,
) {
  const nextSampleTime = Math.min(
    (frameIndex + 1.5) / media.frameRate,
    media.duration,
  );

  return Math.max(sampleDuration, nextSampleTime - mediaTime);
}

function readBatchSamples(
  sampleSink: DecodedVideoSampleSink,
  timestamps: readonly number[],
): AsyncGenerator<DecodedVideoSample | null, void, unknown> {
  return (
    sampleSink.samplesAtTimestamps?.(timestamps, { skipLiveWait: true }) ??
    readSamplesOneAtATime(sampleSink, timestamps)
  );
}

async function* readSamplesOneAtATime(
  sampleSink: DecodedVideoSampleSink,
  timestamps: readonly number[],
): AsyncGenerator<DecodedVideoSample | null, void, unknown> {
  for (const timestamp of timestamps) {
    yield await sampleSink.getSample(timestamp, { skipLiveWait: true });
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
