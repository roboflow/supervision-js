/** Formats whose first plane is 8-bit luma, which is the code as written. */
const PLANAR_8_BIT_FORMATS = new Set<string>([
  "I420",
  "I420A",
  "I422",
  "I422A",
  "I444",
  "I444A",
  "NV12",
]);
const RGB_FORMATS = new Set<string>(["RGBA", "RGBX", "BGRA", "BGRX"]);

/** How the decoded pixels reached the luma codes. */
export type DepthPreviewLumaPath =
  /** The decoder's own luma plane: the codes exactly as decoded. */
  | "plane"
  /**
   * The browser converted the frame to RGB first, and the green channel
   * stands in for luma. A range or matrix conversion can move codes.
   */
  | "rgb";

/** One decoded preview frame's luma, one byte per map pixel. */
export interface DepthPreviewLuma {
  readonly luma: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly path: DepthPreviewLumaPath;
  /** Time this thread spent on the copy, outside the browser's own awaits. */
  readonly busyMs: number;
}

/** A buffer reused from one copy to the next, grown as needed. */
export interface DepthPreviewLumaScratch {
  buffer: ArrayBuffer;
}

/**
 * Copies a decoded preview frame's luma codes out of it, mapped through
 * `correction` when one is given. The frame stays open; its owner closes
 * it.
 */
export async function readVideoFrameLuma(
  frame: VideoFrame,
  scratch: DepthPreviewLumaScratch,
  correction: Uint8Array | null = null,
): Promise<DepthPreviewLuma> {
  const rect = frame.visibleRect ?? {
    height: frame.codedHeight,
    width: frame.codedWidth,
    x: 0,
    y: 0,
  };
  const { width, height } = rect;
  const format = frame.format;
  const planar = format !== null && PLANAR_8_BIT_FORMATS.has(format);
  let started = performance.now();
  let busyMs = 0;
  let bytes: Uint8Array;
  let plane: PlaneLayout | undefined;

  if (planar || (format !== null && RGB_FORMATS.has(format))) {
    const size = frame.allocationSize({ rect });

    if (scratch.buffer.byteLength < size)
      scratch.buffer = new ArrayBuffer(size);

    const copied = frame.copyTo(scratch.buffer, { rect });

    busyMs += performance.now() - started;
    [plane] = await copied;
    started = performance.now();
    bytes = new Uint8Array(scratch.buffer);
  } else {
    // A frame in a layout no copy can read is drawn to a canvas, which
    // converts it to RGB as the browser sees fit.
    bytes = drawFrameRgba(frame, width, height);
  }

  const luma = new Uint8Array(width * height);
  const stride = plane?.stride ?? (planar ? width : width * 4);
  const offset = plane?.offset ?? 0;

  if (!planar) {
    // Every RGB layout keeps green second, and luma with neutral chroma
    // converts to three equal channels.
    for (let y = 0; y < height; y += 1) {
      const row = offset + y * stride + 1;
      const target = y * width;

      for (let x = 0; x < width; x += 1) {
        luma[target + x] = bytes[row + x * 4];
      }
    }
  } else if (stride === width) {
    luma.set(bytes.subarray(offset, offset + width * height));
  } else {
    for (let y = 0; y < height; y += 1) {
      luma.set(
        bytes.subarray(offset + y * stride, offset + y * stride + width),
        y * width,
      );
    }
  }

  if (correction) {
    for (let index = 0; index < luma.length; index += 1) {
      luma[index] = correction[luma[index]];
    }
  }

  busyMs += performance.now() - started;

  return { busyMs, height, luma, path: planar ? "plane" : "rgb", width };
}

/** Copies decoded preview frames' luma out, wherever that costs least. */
export interface DepthPreviewLumaCopier {
  /**
   * Takes the frame and closes it once its luma is out; the promise answers
   * null when the frame was lost on the way, handed to a worker that then
   * failed. Answers null itself, synchronously and leaving the frame
   * untouched, when it cannot take the frame: the page copies it instead.
   */
  copy(
    frame: VideoFrame,
    correction: Uint8Array | null,
  ): Promise<DepthPreviewLuma | null> | null;
  readonly offMainThread: boolean;
  destroy(): void;
}

/** A copier that never declines: the page always takes the frame. */
export interface MainThreadLumaCopier extends DepthPreviewLumaCopier {
  copy(
    frame: VideoFrame,
    correction: Uint8Array | null,
  ): Promise<DepthPreviewLuma>;
}

/**
 * Copies on the page, one frame at a time through one scratch buffer. Each
 * copy reports the main-thread time it took.
 */
export function createMainThreadLumaCopier(): MainThreadLumaCopier {
  const scratch: DepthPreviewLumaScratch = { buffer: new ArrayBuffer(0) };
  let queue: Promise<unknown> = Promise.resolve();

  return {
    copy(frame, correction) {
      const copied = queue.then(async () => {
        try {
          return await readVideoFrameLuma(frame, scratch, correction);
        } finally {
          frame.close();
        }
      });

      queue = copied.catch(() => undefined);
      return copied;
    },
    destroy: () => undefined,
    offMainThread: false,
  };
}

function drawFrameRgba(
  frame: VideoFrame,
  width: number,
  height: number,
): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("The depth preview needs a 2D canvas to read this frame.");
  }
  context.drawImage(frame, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
