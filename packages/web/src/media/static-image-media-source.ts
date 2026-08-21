import type {
  DecodedMediaSource,
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";
import type { MediaRendererSource } from "#types/media-renderer";
import { MediaSourceError, toMediaSourceError } from "#media/media-errors";
import { MediaErrorKind } from "supervision-js-core";

export type StaticImageSource =
  | HTMLImageElement
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | VideoFrame;

export interface HostFrameSource {
  readonly width: number;
  readonly height: number;
  draw(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
}

/** Creates an image-first renderer source without routing through Mediabunny. */
export function createStaticImageMediaSource(
  source: StaticImageSource | HostFrameSource,
): MediaRendererSource {
  return {
    async open() {
      try {
        if (
          typeof HTMLImageElement !== "undefined" &&
          source instanceof HTMLImageElement
        ) {
          await waitForImage(source);
        }

        const dimensions = getDimensions(source);
        return createSingleFrameSource(
          source,
          dimensions.width,
          dimensions.height,
        );
      } catch (error) {
        // Decode and dimension failures leave through a public source, so they
        // carry a stable kind and preserve the original cause.
        throw toMediaSourceError(error, "Unable to open image media source.");
      }
    },
  };
}

export function createImageUrlMediaSource(
  src: string,
  options: { readonly crossOrigin?: string } = {},
): MediaRendererSource {
  const image = new Image();
  if (options.crossOrigin !== undefined)
    image.crossOrigin = options.crossOrigin;
  image.src = src;
  return createStaticImageMediaSource(image);
}

function createSingleFrameSource(
  source: StaticImageSource | HostFrameSource,
  width: number,
  height: number,
): DecodedMediaSource {
  const sample = createSample(source, width, height);
  const sampleSink: DecodedVideoSampleSink = {
    async getSample() {
      return sample;
    },
    async *samples() {
      yield sample;
    },
  };

  return {
    input: { dispose() {} },
    metadata: {
      audioTrackCount: 0,
      canRead: true,
      duration: 0,
      firstTimestamp: 0,
      formatMimeType: null,
      formatName: "static-image",
      mimeType: null,
      primaryVideoHeight: height,
      primaryVideoWidth: width,
      trackCount: 1,
      videoTrackCount: 1,
    },
    sampleSink,
  };
}

function createSample(
  source: StaticImageSource | HostFrameSource,
  width: number,
  height: number,
): DecodedVideoSample {
  return {
    close() {},
    draw(context, dx, dy, dWidth = width, dHeight = height) {
      if ("draw" in source && typeof source.draw === "function") {
        source.draw(context, dx, dy, dWidth, dHeight);
      } else {
        context.drawImage(source as CanvasImageSource, dx, dy, dWidth, dHeight);
      }
    },
    duration: 0,
    timestamp: 0,
  };
}

function getDimensions(source: StaticImageSource | HostFrameSource) {
  if ("width" in source && "height" in source) {
    const width = Number(source.width);
    const height = Number(source.height);
    if (width > 0 && height > 0) return { width, height };
  }

  if (
    typeof HTMLImageElement !== "undefined" &&
    source instanceof HTMLImageElement
  ) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }

  throw new MediaSourceError(
    MediaErrorKind.Unreadable,
    "Static image source dimensions must be greater than zero.",
  );
}

async function waitForImage(image: HTMLImageElement) {
  if (image.complete && image.naturalWidth > 0) return;

  if (typeof image.decode === "function") {
    await image.decode();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () =>
        reject(
          new MediaSourceError(MediaErrorKind.Network, "Unable to load image."),
        ),
      { once: true },
    );
  });
}
