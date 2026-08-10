import type {
  MediaFrameCapture,
  MediaFrameCaptureOptions,
} from "#types/media-renderer";

/** Encoded image type used when a capture does not request one. */
export const DEFAULT_MEDIA_FRAME_CAPTURE_TYPE = "image/jpeg";

/** Lossy encoder quality used when a capture does not request one. */
export const DEFAULT_MEDIA_FRAME_CAPTURE_QUALITY = 0.92;

export interface CanvasMediaFrameCaptureRequest {
  /** Renderer-owned surface holding the presented media pixels. */
  readonly source: HTMLCanvasElement;
  /** Presentation timestamp of the pixels currently held by `source`. */
  readonly mediaTime: number;
  /** Caller-supplied encoder options. */
  readonly capture: MediaFrameCaptureOptions | undefined;
  /** Creates the detached surface used to snapshot the presented pixels. */
  readonly createCanvas: () => HTMLCanvasElement;
}

/**
 * Encodes media pixels a renderer has already presented.
 *
 * The presented pixels and their timestamp are copied synchronously before the
 * first await, so a frame presented while the encoder runs cannot change the
 * captured image or desynchronize it from `mediaTime`.
 */
export async function captureCanvasMediaFrame(
  request: CanvasMediaFrameCaptureRequest,
): Promise<MediaFrameCapture> {
  const { height, width } = request.source;

  if (width <= 0 || height <= 0) {
    throw new Error("No media frame has been presented yet.");
  }

  const type = request.capture?.type ?? DEFAULT_MEDIA_FRAME_CAPTURE_TYPE;
  const quality =
    request.capture?.quality ?? DEFAULT_MEDIA_FRAME_CAPTURE_QUALITY;

  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError("quality must be a number between 0 and 1.");
  }

  const snapshot = request.createCanvas();
  snapshot.width = width;
  snapshot.height = height;

  const context = snapshot.getContext("2d");

  if (!context) {
    throw new Error("Unable to create a media frame capture context.");
  }

  context.drawImage(request.source, 0, 0);

  const blob = await encodeCanvas(snapshot, type, quality);

  return {
    blob,
    height,
    mediaTime: request.mediaTime,
    type: blob.type || type,
    width,
  };
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(
          new Error(`Unable to encode the presented media frame as ${type}.`),
        );
      },
      type,
      quality,
    );
  });
}
