/*
 * Grayscale PNG decoding for depth maps and their confidence planes.
 *
 * Every image path a browser offers (<img>, createImageBitmap, ImageDecoder,
 * canvas) hands back 8 bits per channel, so a 16-bit depth PNG is decoded
 * here: the browser's own zlib inflates the IDAT stream, and the row filters
 * are undone in JavaScript.
 *
 * This module imports nothing, so the render-preparation worker, the main
 * thread and the depth benchmark all run the same code.
 */

/** A decoded 16-bit grayscale PNG, samples in host byte order. */
export interface DecodedPng16 {
  readonly width: number;
  readonly height: number;
  readonly values: Uint16Array<ArrayBuffer>;
  /**
   * The samples as `rg8` texture bytes with every row padded to a multiple of
   * four bytes, present only when padding was asked for and the width is odd.
   */
  readonly paddedUpload?: {
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly textureWidth: number;
  };
}

/** A decoded 8-bit grayscale PNG, such as a confidence plane. */
export interface DecodedPng8 {
  readonly width: number;
  readonly height: number;
  readonly values: Uint8Array<ArrayBuffer>;
}

/**
 * Inflates a zlib stream split over `chunks` into exactly `byteLength` bytes.
 * A PNG's IDAT chunks, joined, are one zlib stream.
 */
export type PngInflate = (
  chunks: readonly Uint8Array[],
  byteLength: number,
) => Promise<Uint8Array>;

export interface DecodePng16Options {
  readonly inflate?: PngInflate;
  /** Also return WebGL-aligned upload bytes when the width is odd. */
  readonly padRowsForWebGl?: boolean;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOR_TYPE_GRAY = 0;
/** 16384 x 16384, beyond any GPU texture; a header claiming more is refused. */
const MAX_PNG_PIXELS = 16_384 * 16_384;
const HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const FilterType = {
  None: 0,
  Sub: 1,
  Up: 2,
  Average: 3,
  Paeth: 4,
} as const;

/** Decodes a 16-bit grayscale PNG, as a depth producer writes one. */
export async function decodePng16(
  bytes: ArrayBuffer | Uint8Array,
  options: DecodePng16Options = {},
): Promise<DecodedPng16> {
  const header = readPngHeader(bytes, 16);
  const rowBytes = header.width * 2 + 1;
  const raw = await (options.inflate ?? inflateWithDecompressionStream)(
    header.idat,
    rowBytes * header.height,
  );
  const values = new Uint16Array(header.width * header.height);

  checkInflatedLength(raw, rowBytes * header.height);
  unfilterGray16(raw, header.width, header.height, values);

  return {
    height: header.height,
    paddedUpload:
      options.padRowsForWebGl && header.width % 2 === 1 && HOST_IS_LITTLE_ENDIAN
        ? padRows(values, header.width, header.height)
        : undefined,
    values,
    width: header.width,
  };
}

/** Decodes an 8-bit grayscale PNG, as a confidence plane is written. */
export async function decodePng8Gray(
  bytes: ArrayBuffer | Uint8Array,
  options: { readonly inflate?: PngInflate } = {},
): Promise<DecodedPng8> {
  const header = readPngHeader(bytes, 8);
  const rowBytes = header.width + 1;
  const raw = await (options.inflate ?? inflateWithDecompressionStream)(
    header.idat,
    rowBytes * header.height,
  );
  const values = new Uint8Array(header.width * header.height);

  checkInflatedLength(raw, rowBytes * header.height);
  unfilterGray8(raw, header.width, header.height, values);

  return { height: header.height, values, width: header.width };
}

/**
 * Inflates with the platform's `DecompressionStream("deflate")` (zlib
 * framing, which is what PNG uses) straight into one buffer of the expected
 * size, so no second copy joins the output chunks.
 */
export async function inflateWithDecompressionStream(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Writers split IDAT into many small chunks (libpng's default is 8 KiB).
  // One write of the joined stream costs a copy of the compressed bytes and
  // saves a stream round trip per chunk.
  const zlib = chunks.length === 1 ? chunks[0] : joinChunks(chunks);
  const writing = (async () => {
    await writer.write(zlib as BufferSource);
    await writer.close();
  })();
  const output = new Uint8Array(byteLength);
  let offset = 0;

  // A corrupt stream rejects both sides; the reader's error is the one thrown.
  writing.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      if (offset + value.byteLength > byteLength) {
        throw new RangeError("PNG image data is longer than its header says.");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    await writing;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof RangeError
      ? error
      : new RangeError(
          `PNG image data does not inflate: ${error instanceof Error ? error.message : String(error)}`,
        );
  }

  return offset === byteLength ? output : output.subarray(0, offset);
}

function joinChunks(chunks: readonly Uint8Array[]) {
  const joined = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return joined;
}

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly idat: readonly Uint8Array[];
}

function readPngHeader(
  input: ArrayBuffer | Uint8Array,
  bitDepth: 8 | 16,
): PngHeader {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    bytes.byteLength < 8 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    throw new RangeError("Not a PNG file.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Uint8Array[] = [];

  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > bytes.byteLength) {
      throw new RangeError("PNG file is truncated.");
    }

    if (type === 0x49484452) {
      // IHDR
      if (length !== 13) throw new RangeError("PNG header is malformed.");
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const depth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];

      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0) {
        throw new RangeError("PNG uses an unknown compression or filter.");
      }
      if (bytes[dataStart + 12] !== 0) {
        throw new RangeError("Interlaced PNGs are not supported.");
      }
      if (colorType !== COLOR_TYPE_GRAY || depth !== bitDepth) {
        throw new RangeError(
          `Expected a ${bitDepth}-bit grayscale PNG, got bit depth ${depth} with colour type ${colorType}.`,
        );
      }
      sawHeader = true;
    } else if (type === 0x49444154) {
      // IDAT
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 0x49454e44) {
      // IEND
      sawEnd = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!sawHeader) throw new RangeError("PNG has no header.");
  if (!sawEnd) throw new RangeError("PNG file is truncated.");
  if (width === 0 || height === 0 || width * height > MAX_PNG_PIXELS) {
    throw new RangeError(`PNG size ${width}x${height} is not supported.`);
  }
  if (idat.length === 0) throw new RangeError("PNG has no image data.");

  return { height, idat, width };
}

function checkInflatedLength(raw: Uint8Array, expected: number) {
  if (raw.byteLength !== expected) {
    throw new RangeError("PNG image data is shorter than its header says.");
  }
}

/*
 * Undoes the row filters of a 16-bit grayscale image and writes host-order
 * samples, in one pass. Each filter runs on bytes, and the two bytes of a
 * sample never carry into each other, so the loops keep a sample's high and
 * low bytes apart and join them only for the store. The previous row is read
 * back from the output, which already holds it unfiltered; the first row reads
 * a row of zeros, which is what PNG defines above the image.
 *
 * One loop per filter keeps the per-pixel work free of a filter switch.
 */
function unfilterGray16(
  raw: Uint8Array,
  width: number,
  height: number,
  out: Uint16Array,
) {
  const rowBytes = width * 2 + 1;
  const zeroRow = new Uint16Array(width);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * rowBytes];
    let s = y * rowBytes + 1;
    const o = y * width;
    const end = o + width;
    const prev = y === 0 ? zeroRow : out;
    let p = y === 0 ? 0 : o - width;

    switch (filter) {
      case FilterType.None:
        for (let i = o; i < end; i += 1, s += 2) {
          out[i] = (raw[s] << 8) | raw[s + 1];
        }
        break;

      case FilterType.Sub: {
        let hi = 0;
        let lo = 0;

        for (let i = o; i < end; i += 1, s += 2) {
          hi = (raw[s] + hi) & 0xff;
          lo = (raw[s + 1] + lo) & 0xff;
          out[i] = (hi << 8) | lo;
        }
        break;
      }

      case FilterType.Up:
        for (let i = o; i < end; i += 1, s += 2, p += 1) {
          const up = prev[p];

          out[i] =
            (((raw[s] + (up >> 8)) & 0xff) << 8) | ((raw[s + 1] + up) & 0xff);
        }
        break;

      case FilterType.Average: {
        let hi = 0;
        let lo = 0;

        for (let i = o; i < end; i += 1, s += 2, p += 1) {
          const up = prev[p];

          hi = (raw[s] + ((hi + (up >> 8)) >> 1)) & 0xff;
          lo = (raw[s + 1] + ((lo + (up & 0xff)) >> 1)) & 0xff;
          out[i] = (hi << 8) | lo;
        }
        break;
      }

      case FilterType.Paeth: {
        let hi = 0;
        let lo = 0;
        let upLeft = 0;

        for (let i = o; i < end; i += 1, s += 2, p += 1) {
          const up = prev[p];

          hi = (raw[s] + paeth(hi, up >> 8, upLeft >> 8)) & 0xff;
          lo = (raw[s + 1] + paeth(lo, up & 0xff, upLeft & 0xff)) & 0xff;
          out[i] = (hi << 8) | lo;
          upLeft = up;
        }
        break;
      }

      default:
        throw new RangeError(`PNG row ${y} has unknown filter ${filter}.`);
    }
  }
}

function unfilterGray8(
  raw: Uint8Array,
  width: number,
  height: number,
  out: Uint8Array,
) {
  const rowBytes = width + 1;
  const zeroRow = new Uint8Array(width);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * rowBytes];
    let s = y * rowBytes + 1;
    const o = y * width;
    const end = o + width;
    const prev = y === 0 ? zeroRow : out;
    let p = y === 0 ? 0 : o - width;

    switch (filter) {
      case FilterType.None:
        out.set(raw.subarray(s, s + width), o);
        break;

      case FilterType.Sub: {
        let left = 0;

        for (let i = o; i < end; i += 1, s += 1) {
          left = (raw[s] + left) & 0xff;
          out[i] = left;
        }
        break;
      }

      case FilterType.Up:
        for (let i = o; i < end; i += 1, s += 1, p += 1) {
          out[i] = (raw[s] + prev[p]) & 0xff;
        }
        break;

      case FilterType.Average: {
        let left = 0;

        for (let i = o; i < end; i += 1, s += 1, p += 1) {
          left = (raw[s] + ((left + prev[p]) >> 1)) & 0xff;
          out[i] = left;
        }
        break;
      }

      case FilterType.Paeth: {
        let left = 0;
        let upLeft = 0;

        for (let i = o; i < end; i += 1, s += 1, p += 1) {
          const up = prev[p];

          left = (raw[s] + paeth(left, up, upLeft)) & 0xff;
          out[i] = left;
          upLeft = up;
        }
        break;
      }

      default:
        throw new RangeError(`PNG row ${y} has unknown filter ${filter}.`);
    }
  }
}

/** The PNG Paeth predictor for one byte: whichever of a, b, c is closest to a + b - c. */
function paeth(a: number, b: number, c: number): number {
  const pa = Math.abs(b - c);
  const pb = Math.abs(a - c);
  const pc = Math.abs(a + b - c - c);

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * WebGL unpacks rows on four-byte boundaries, so an odd width of two-byte
 * texels needs one padding texel per row. Rows are copied whole, with no
 * per-sample work.
 */
function padRows(values: Uint16Array, width: number, height: number) {
  const textureWidth = width + 1;
  const padded = new Uint16Array(textureWidth * height);

  for (let y = 0; y < height; y += 1) {
    padded.set(values.subarray(y * width, (y + 1) * width), y * textureWidth);
  }

  return { bytes: new Uint8Array(padded.buffer), textureWidth };
}
