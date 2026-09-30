import type { DepthMap } from "supervision-js-core";
import { createDepthDraw, createLut } from "./depth-draw";
import type { BenchBackend } from "./pixi-backend";
import { summarize, type TimingSummary } from "./timing";

export interface Resolution {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export interface UploadRenderCase {
  readonly backend: string;
  readonly resolution: string;
  readonly encoding: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly bytesPerFrame: number;
  /** Upload in the present: upload, draw, render, wait. */
  readonly uploadAndRenderMs: TimingSummary;
  /** Uploaded ahead: the map is resident, so the present binds and renders. */
  readonly renderOnlyMs: TimingSummary;
  /**
   * What the upload adds to a present: the difference of the two medians.
   * Timing an upload on its own is not possible on WebGL, where Chrome's
   * `finish()` returns before a texture upload has landed.
   */
  readonly uploadShareMs: number;
}

const WARMUP = 5;
const SAMPLES = 30;

/**
 * Upload and render cost per frame, waiting for the GPU after every present
 * (a one-pixel readback of the render texture on WebGL,
 * `queue.onSubmittedWorkDone()` on WebGPU), so each number is the work itself
 * and not how much of it the driver deferred. Both waits add a fixed round
 * trip, which the upload share cancels out.
 *
 * Every row draws the library's depth shader over a render texture the size
 * of the media, one fragment per media pixel.
 */
export async function runUploadRender(
  backend: BenchBackend,
  resolution: Resolution,
  frames: readonly DepthMap[],
  onProgress: (message: string) => void,
): Promise<UploadRenderCase[]> {
  const lut = createLut((index) => [index, 255 - index, 128]);
  const cases: UploadRenderCase[] = [];
  const media = { height: resolution.height, width: resolution.width };
  const variants: readonly [string, readonly DepthMap[]][] = [
    ["exact rg8", frames],
    ["preview r8", frames.map(toPreview)],
    ["exact rg8, half-size map (edge-aware)", frames.map(halfSize)],
  ];

  try {
    for (const [encoding, maps] of variants) {
      onProgress(
        `${backend.description.rendererName} ${resolution.label}: ${encoding}`,
      );
      cases.push(
        await measure(backend, resolution, media, lut, encoding, maps),
      );
    }
  } finally {
    lut.destroy();
  }

  return cases;
}

async function measure(
  backend: BenchBackend,
  resolution: Resolution,
  media: { readonly width: number; readonly height: number },
  lut: ReturnType<typeof createLut>,
  encoding: string,
  maps: readonly DepthMap[],
): Promise<UploadRenderCase> {
  const range = { max: 200, min: 1 };
  const map = maps[0];
  const bytesPerFrame =
    map.width * map.height * (map.samples.encoding === "scaled16" ? 2 : 1);

  // One slot fewer than there are maps: every acquire uploads into the
  // stalest slot, in place, the way the layer's ring reuses textures.
  const uploading = createDepthDraw(backend, media, maps.length - 1);
  const uploadAndRender: number[] = [];

  try {
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      // Maps cycle through one more than the ring holds, so each is the
      // least recently used when it comes back and uploads again.
      const start = performance.now();

      uploading.draw(maps[i % maps.length], lut, { range });
      await backend.finish(uploading.target);
      if (i >= WARMUP) uploadAndRender.push(performance.now() - start);
    }
  } finally {
    uploading.destroy();
  }

  // Enough slots for every map: after the first round all stay resident.
  const resident = createDepthDraw(backend, media, maps.length);
  const renderOnly: number[] = [];

  try {
    for (const each of maps) resident.ring.acquire(each);
    await backend.finish();
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const start = performance.now();

      resident.draw(maps[i % maps.length], lut, { range });
      await backend.finish(resident.target);
      if (i >= WARMUP) renderOnly.push(performance.now() - start);
    }
  } finally {
    resident.destroy();
  }

  return {
    backend: backend.description.rendererName,
    bytesPerFrame,
    encoding,
    mapHeight: map.height,
    mapWidth: map.width,
    renderOnlyMs: summarize(renderOnly),
    resolution: resolution.label,
    uploadAndRenderMs: summarize(uploadAndRender),
    uploadShareMs: Math.max(
      0,
      summarize(uploadAndRender).median - summarize(renderOnly).median,
    ),
  };
}

/** The 8-bit preview a producer would encode: T = 15, range 0..255 px. */
function toPreview(map: DepthMap): DepthMap {
  if (map.samples.encoding !== "scaled16") return map;

  const reservedMax = 15;
  const span = 254 - reservedMax;
  const { scale, values } = map.samples;
  const codes = new Uint8Array(values.length);
  const hi = 255;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];

    codes[i] =
      value === 0
        ? 0
        : Math.min(
            255,
            reservedMax + 1 + Math.round((value / scale / hi) * span),
          );
  }

  return {
    ...map,
    samples: {
      encoding: "preview8",
      range: { max: hi, min: 0 },
      reservedMax,
      values: codes,
    },
  };
}

/** Every other sample of every other row, as a lower-resolution model gives. */
function halfSize(map: DepthMap): DepthMap {
  if (map.samples.encoding !== "scaled16") return map;

  const width = map.width >> 1;
  const height = map.height >> 1;
  const values = new Uint16Array(width * height);
  const source = map.samples.values;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[y * width + x] = source[y * 2 * map.width + x * 2];
    }
  }

  return {
    ...map,
    height,
    samples: { ...map.samples, values },
    width,
  };
}
