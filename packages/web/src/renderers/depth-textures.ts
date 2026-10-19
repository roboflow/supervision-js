import { createDepthColormapLut } from "supervision-js-core";
import type { DepthColormap, DepthMap } from "supervision-js-core";
import type { BufferImageSource as PixiBufferImageSource } from "pixi.js";

/**
 * WebGL unpacks rows on four-byte boundaries and Pixi never changes that, so a
 * row of a two-byte texture needs an even width and a one-byte row a width
 * that is a multiple of four. WebGPU takes rows of any length.
 */
const WEBGL_ROW_ALIGNMENT_BYTES = 4;
const LUT_ENTRIES = 256;

export type DepthTextureFormat = "rg8unorm" | "r8unorm";

export type DepthBufferImageSourceConstructor = new (options: {
  alphaMode?: "no-premultiply-alpha";
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  format: DepthTextureFormat | "rgba8unorm";
  height: number;
  resource: Uint8Array;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiBufferImageSource;

export interface DepthTextureUpload {
  readonly bytes: Uint8Array;
  readonly format: DepthTextureFormat;
  /** Texels per row, which can exceed the map width by row padding. */
  readonly textureWidth: number;
}

export interface DepthDisplaySize {
  readonly width: number;
  readonly height: number;
}

export interface DepthMapUpload extends DepthTextureUpload {
  readonly displaySize: DepthDisplaySize;
}

const preparedUploads = new WeakMap<
  DepthMap,
  DepthTextureUpload & { readonly displaySize?: DepthDisplaySize }
>();

/**
 * With a `displaySize` smaller than the map, the bytes are a decimated copy;
 * the map keeps its full samples for readouts.
 */
export function rememberPreparedDepthUpload(
  map: DepthMap,
  upload: DepthTextureUpload & { readonly displaySize?: DepthDisplaySize },
): void {
  preparedUploads.set(map, upload);
}

/**
 * Exact samples go up as two unorm bytes per texel, low byte in red, and the
 * shader rebuilds `red + 256 * green`. Pixi cannot upload a 16-bit integer
 * texture on WebGL, and a half float cannot hold every 1/256 step.
 * Every supported browser runs little-endian, where a `Uint16Array` already
 * is those bytes, so aligned rows go up without a copy.
 */
export function createPackedDepthUpload(
  values: Uint16Array,
  width: number,
  height: number,
  acceptsUnalignedRows: boolean,
): DepthTextureUpload {
  const textureWidth = alignedWidth(width, 2, acceptsUnalignedRows);

  if (textureWidth === width) {
    return {
      bytes: new Uint8Array(
        values.buffer,
        values.byteOffset,
        width * height * 2,
      ),
      format: "rg8unorm",
      textureWidth,
    };
  }

  const bytes = new Uint8Array(textureWidth * height * 2);
  const texels = new Uint16Array(bytes.buffer);

  for (let y = 0; y < height; y += 1) {
    texels.set(values.subarray(y * width, (y + 1) * width), y * textureWidth);
  }

  return { bytes, format: "rg8unorm", textureWidth };
}

export function createPreviewUpload(
  codes: Uint8Array,
  width: number,
  height: number,
  acceptsUnalignedRows: boolean,
): DepthTextureUpload {
  const textureWidth = alignedWidth(width, 1, acceptsUnalignedRows);

  if (textureWidth === width) {
    return { bytes: codes, format: "r8unorm", textureWidth };
  }

  const bytes = new Uint8Array(textureWidth * height);

  for (let y = 0; y < height; y += 1) {
    bytes.set(codes.subarray(y * width, (y + 1) * width), y * textureWidth);
  }

  return { bytes, format: "r8unorm", textureWidth };
}

/**
 * A map larger than `maxTextureSize` on either side goes up as a
 * nearest-decimated copy that fits; the full-resolution samples stay on the
 * map for readouts.
 */
export function createDepthMapUpload(
  map: DepthMap,
  acceptsUnalignedRows: boolean,
  maxTextureSize = Number.POSITIVE_INFINITY,
): DepthMapUpload {
  const prepared = preparedUploads.get(map);
  const preparedSize = prepared?.displaySize ?? {
    height: map.height,
    width: map.width,
  };

  if (
    prepared &&
    preparedSize.width <= maxTextureSize &&
    preparedSize.height <= maxTextureSize &&
    prepared.textureWidth ===
      alignedWidth(
        preparedSize.width,
        prepared.format === "rg8unorm" ? 2 : 1,
        acceptsUnalignedRows,
      )
  ) {
    return {
      bytes: prepared.bytes,
      displaySize: preparedSize,
      format: prepared.format,
      textureWidth: prepared.textureWidth,
    };
  }
  if (map.width <= maxTextureSize && map.height <= maxTextureSize) {
    const displaySize = { height: map.height, width: map.width };

    return {
      ...uploadSamples(map, map.width, map.height, acceptsUnalignedRows),
      displaySize,
    };
  }

  const factor = Math.ceil(
    Math.max(map.width, map.height) / Math.max(1, maxTextureSize),
  );
  const displaySize = {
    height: Math.ceil(map.height / factor),
    width: Math.ceil(map.width / factor),
  };
  const decimated = decimateSamples(map, displaySize);

  return {
    ...uploadSamples(
      { ...map, ...displaySize, samples: decimated } as DepthMap,
      displaySize.width,
      displaySize.height,
      acceptsUnalignedRows,
    ),
    displaySize,
  };
}

function uploadSamples(
  map: DepthMap,
  width: number,
  height: number,
  acceptsUnalignedRows: boolean,
): DepthTextureUpload {
  const { samples } = map;

  return samples.encoding === "scaled16"
    ? createPackedDepthUpload(
        samples.values,
        width,
        height,
        acceptsUnalignedRows,
      )
    : createPreviewUpload(samples.values, width, height, acceptsUnalignedRows);
}

/** Nearest sampling, so "no depth" never blends into its neighbours. */
function decimateSamples(
  map: DepthMap,
  size: DepthDisplaySize,
): DepthMap["samples"] {
  const source = map.samples.values;
  const values =
    map.samples.encoding === "scaled16"
      ? new Uint16Array(size.width * size.height)
      : new Uint8Array(size.width * size.height);
  const columns = new Uint32Array(size.width);

  for (let x = 0; x < size.width; x += 1) {
    columns[x] = Math.min(
      map.width - 1,
      Math.floor(((x + 0.5) * map.width) / size.width),
    );
  }
  for (let y = 0; y < size.height; y += 1) {
    const row =
      Math.min(
        map.height - 1,
        Math.floor(((y + 0.5) * map.height) / size.height),
      ) * map.width;
    const target = y * size.width;

    for (let x = 0; x < size.width; x += 1) {
      values[target + x] = source[row + columns[x]];
    }
  }

  return { ...map.samples, values } as DepthMap["samples"];
}

export interface DepthTextureSlot {
  readonly source: PixiBufferImageSource;
  readonly textureWidth: number;
  /** The map size the texture holds, smaller than the map's when decimated. */
  readonly displaySize: DepthDisplaySize;
}

export interface DepthTextureRing {
  /**
   * The texture holding `map`, uploading it into the stalest slot if needed.
   * A slot holding a map in `keep` is reused only when every slot does.
   */
  acquire(map: DepthMap, keep?: ReadonlySet<DepthMap>): DepthTextureSlot;
  has(map: DepthMap): boolean;
  destroy(): void;
}

interface RingSlot {
  map: DepthMap | null;
  source: PixiBufferImageSource | null;
  format: DepthTextureFormat | null;
  textureWidth: number;
  displaySize: DepthDisplaySize;
  lastUsed: number;
}

export function createDepthTextureRing(options: {
  readonly BufferImageSource: DepthBufferImageSourceConstructor;
  readonly acceptsUnalignedTextureRows: () => boolean;
  readonly maxTextureSize?: () => number;
  readonly size?: number;
}): DepthTextureRing {
  const slots: RingSlot[] = Array.from(
    { length: Math.max(1, options.size ?? 3) },
    () => ({
      displaySize: { height: 0, width: 0 },
      format: null,
      lastUsed: -1,
      map: null,
      source: null,
      textureWidth: 0,
    }),
  );
  let clock = 0;

  const find = (map: DepthMap) => slots.find((slot) => slot.map === map);

  return {
    acquire(map, keep) {
      clock += 1;
      const resident = find(map);

      if (resident?.source) {
        resident.lastUsed = clock;
        return resident as DepthTextureSlot;
      }

      const spare = keep
        ? slots.filter((slot) => slot.map === null || !keep.has(slot.map))
        : slots;
      const slot = (spare.length > 0 ? spare : slots).reduce(
        (stalest, candidate) =>
          candidate.lastUsed < stalest.lastUsed ? candidate : stalest,
      );
      const upload = createDepthMapUpload(
        map,
        options.acceptsUnalignedTextureRows(),
        options.maxTextureSize?.(),
      );
      const { height } = upload.displaySize;

      if (
        slot.source &&
        slot.format === upload.format &&
        slot.textureWidth === upload.textureWidth &&
        slot.displaySize.height === height
      ) {
        slot.source.resource = upload.bytes;
        slot.source.update();
      } else {
        slot.source?.destroy();
        slot.source = new options.BufferImageSource({
          alphaMode: "no-premultiply-alpha",
          autoGenerateMipmaps: false,
          dynamic: false,
          format: upload.format,
          height,
          resource: upload.bytes,
          scaleMode: "nearest",
          width: upload.textureWidth,
        });
      }

      slot.displaySize = upload.displaySize;
      slot.format = upload.format;
      slot.lastUsed = clock;
      slot.map = map;
      slot.textureWidth = upload.textureWidth;

      return slot as DepthTextureSlot;
    },

    has(map) {
      return find(map) !== undefined;
    },

    destroy() {
      for (const slot of slots) {
        slot.source?.destroy();
        slot.source = null;
        slot.map = null;
      }
    },
  };
}

export function createDepthLutCache(
  BufferImageSource: DepthBufferImageSourceConstructor,
): {
  get(name: DepthColormap): PixiBufferImageSource;
  destroy(): void;
} {
  const sources = new Map<DepthColormap, PixiBufferImageSource>();

  return {
    get(name) {
      let source = sources.get(name);

      if (!source) {
        source = new BufferImageSource({
          alphaMode: "no-premultiply-alpha",
          autoGenerateMipmaps: false,
          dynamic: false,
          format: "rgba8unorm",
          height: 1,
          resource: createDepthColormapLut(name),
          scaleMode: "linear",
          width: LUT_ENTRIES,
        });
        sources.set(name, source);
      }

      return source;
    },

    destroy() {
      for (const source of sources.values()) source.destroy();
      sources.clear();
    },
  };
}

function alignedWidth(
  width: number,
  bytesPerTexel: number,
  acceptsUnalignedRows: boolean,
): number {
  if (acceptsUnalignedRows) {
    return width;
  }

  const texelsPerAlignment = WEBGL_ROW_ALIGNMENT_BYTES / bytesPerTexel;

  return Math.ceil(width / texelsPerAlignment) * texelsPerAlignment;
}

/**
 * An unreadable limit falls back to the minimum each backend guarantees:
 * 2048 on WebGL 2, 8192 on WebGPU.
 */
export function queryMaxTextureSize(renderer: unknown): number {
  const backend = renderer as {
    readonly gl?: WebGL2RenderingContext;
    readonly gpu?: { readonly device?: GPUDevice };
    readonly name?: string;
  } | null;
  const gpuLimit = backend?.gpu?.device?.limits?.maxTextureDimension2D;

  if (typeof gpuLimit === "number" && gpuLimit > 0) return gpuLimit;

  const gl = backend?.gl;
  const glLimit =
    gl && typeof gl.getParameter === "function"
      ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))
      : Number.NaN;

  if (Number.isFinite(glLimit) && glLimit > 0) return glLimit;

  return backend?.name === "webgpu" ? 8192 : 2048;
}
