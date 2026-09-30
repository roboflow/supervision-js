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

const HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Exact samples go up as two unorm bytes per texel, low byte in red, and the
 * shader rebuilds `red + 256 * green`. Pixi cannot upload a 16-bit integer
 * texture on WebGL, and a half float cannot hold every 1/256 step.
 *
 * On a little-endian host a `Uint16Array` already is those bytes, so the view
 * goes up without a copy. Only a row that WebGL would misread, or a
 * big-endian host, pays for one.
 */
export function createPackedDepthUpload(
  values: Uint16Array,
  width: number,
  height: number,
  acceptsUnalignedRows: boolean,
  littleEndian = HOST_IS_LITTLE_ENDIAN,
): DepthTextureUpload {
  const textureWidth = alignedWidth(width, 2, acceptsUnalignedRows);

  if (littleEndian && textureWidth === width) {
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

  for (let y = 0; y < height; y += 1) {
    const source = y * width;
    const target = y * textureWidth * 2;

    for (let x = 0; x < width; x += 1) {
      const value = values[source + x];

      bytes[target + x * 2] = value & 0xff;
      bytes[target + x * 2 + 1] = value >> 8;
    }
  }

  return { bytes, format: "rg8unorm", textureWidth };
}

/** Preview codes go up one byte per texel, padded the same way on WebGL. */
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

export function createDepthMapUpload(
  map: DepthMap,
  acceptsUnalignedRows: boolean,
): DepthTextureUpload {
  const { samples } = map;

  return samples.encoding === "scaled16"
    ? createPackedDepthUpload(
        samples.values,
        map.width,
        map.height,
        acceptsUnalignedRows,
      )
    : createPreviewUpload(
        samples.values,
        map.width,
        map.height,
        acceptsUnalignedRows,
      );
}

export interface DepthTextureSlot {
  readonly source: PixiBufferImageSource;
  readonly textureWidth: number;
}

export interface DepthTextureRing {
  /** The texture holding `map`, uploading it into the stalest slot if needed. */
  acquire(map: DepthMap): DepthTextureSlot;
  has(map: DepthMap): boolean;
  destroy(): void;
}

interface RingSlot {
  map: DepthMap | null;
  source: PixiBufferImageSource | null;
  format: DepthTextureFormat | null;
  textureWidth: number;
  height: number;
  lastUsed: number;
}

/**
 * A few textures reused across maps. A map already resident is never
 * uploaded again, and a slot that gets a map of the same size keeps its GPU
 * texture and takes the new bytes in place.
 */
export function createDepthTextureRing(options: {
  readonly BufferImageSource: DepthBufferImageSourceConstructor;
  readonly acceptsUnalignedTextureRows: () => boolean;
  readonly size?: number;
}): DepthTextureRing {
  const slots: RingSlot[] = Array.from(
    { length: Math.max(1, options.size ?? 3) },
    () => ({
      format: null,
      height: 0,
      lastUsed: -1,
      map: null,
      source: null,
      textureWidth: 0,
    }),
  );
  let clock = 0;

  const find = (map: DepthMap) => slots.find((slot) => slot.map === map);

  return {
    acquire(map) {
      clock += 1;
      const resident = find(map);

      if (resident?.source) {
        resident.lastUsed = clock;
        return resident as DepthTextureSlot;
      }

      const slot = slots.reduce((stalest, candidate) =>
        candidate.lastUsed < stalest.lastUsed ? candidate : stalest,
      );
      const upload = createDepthMapUpload(
        map,
        options.acceptsUnalignedTextureRows(),
      );

      if (
        slot.source &&
        slot.format === upload.format &&
        slot.textureWidth === upload.textureWidth &&
        slot.height === map.height
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
          height: map.height,
          resource: upload.bytes,
          scaleMode: "nearest",
          width: upload.textureWidth,
        });
      }

      slot.format = upload.format;
      slot.height = map.height;
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

/**
 * One 256x1 RGBA texture per colour table, filtered linearly so a colour
 * coordinate between two entries blends them.
 */
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
