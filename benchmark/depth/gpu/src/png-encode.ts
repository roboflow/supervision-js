/**
 * A 16-bit grayscale PNG writer on the browser's own zlib
 * (`CompressionStream`), for the depth benchmark. Every row can use one fixed
 * PNG filter, or the per-row choice libpng makes by default ("adaptive": the
 * filter whose output has the smallest sum of absolute signed bytes), which
 * is what Pillow and most writers produce.
 */

export const PngFilter = {
  None: "none",
  Sub: "sub",
  Up: "up",
  Average: "average",
  Paeth: "paeth",
  /**
   * libpng's default heuristic: per row, the filter whose output has the
   * smallest sum of absolute signed bytes.
   */
  Adaptive: "adaptive",
  /**
   * Two Paeth rows to one Up row, the mix Pillow wrote for the research
   * scene's 720p frame (475 Paeth, 238 Up and 7 Sub rows of 720).
   */
  PaethUpMix: "paeth-up-mix",
} as const;

export type PngFilter = (typeof PngFilter)[keyof typeof PngFilter];

export interface EncodedPng {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** How many rows used None, Sub, Up, Average and Paeth. */
  readonly filterCounts: readonly [number, number, number, number, number];
}

const FILTER_CODES: Record<
  Exclude<PngFilter, "adaptive" | "paeth-up-mix">,
  number
> = {
  average: 3,
  none: 0,
  paeth: 4,
  sub: 1,
  up: 2,
};

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Writes 16-bit samples, `0` meaning no depth, as a grayscale PNG. */
export function encodePng16(
  width: number,
  height: number,
  values: Uint16Array,
  filter: PngFilter = PngFilter.Up,
): Promise<EncodedPng> {
  const row = new Uint8Array(width * 2);

  return encodeGray(width, height, 16, filter, (y) => {
    const offset = y * width;

    for (let x = 0; x < width; x += 1) {
      const value = values[offset + x];

      row[x * 2] = value >> 8;
      row[x * 2 + 1] = value & 0xff;
    }

    return row;
  });
}

async function encodeGray(
  width: number,
  height: number,
  bitDepth: 8 | 16,
  filter: PngFilter,
  readRow: (y: number) => Uint8Array,
): Promise<EncodedPng> {
  const bytesPerPixel = bitDepth / 8;
  const stride = width * bytesPerPixel;
  const raw = new Uint8Array(height * (stride + 1));
  const previous = new Uint8Array(stride);
  const candidate = new Uint8Array(stride);
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];

  for (let y = 0; y < height; y += 1) {
    const current = readRow(y);
    const target = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    let code: number;

    if (filter === PngFilter.Adaptive) {
      let best = Infinity;

      code = 0;
      for (let f = 0; f <= 4; f += 1) {
        filterRow(f, current, previous, candidate, bytesPerPixel);
        const cost = signedSum(candidate, best);

        if (cost < best) {
          best = cost;
          code = f;
        }
      }
    } else if (filter === PngFilter.PaethUpMix) {
      code = y % 3 === 2 ? 2 : 4;
    } else {
      code = FILTER_CODES[filter];
    }

    filterRow(code, current, previous, target, bytesPerPixel);
    raw[y * (stride + 1)] = code;
    counts[code] += 1;
    previous.set(current);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);

  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = 0;

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return { bytes, filterCounts: counts };
}

function filterRow(
  code: number,
  current: Uint8Array,
  previous: Uint8Array,
  out: Uint8Array,
  bpp: number,
) {
  const length = current.length;

  for (let i = 0; i < length; i += 1) {
    const a = i >= bpp ? current[i - bpp] : 0;
    const b = previous[i];
    let prediction = 0;

    if (code === 1) prediction = a;
    else if (code === 2) prediction = b;
    else if (code === 3) prediction = (a + b) >> 1;
    else if (code === 4) {
      const c = i >= bpp ? previous[i - bpp] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - c - c);

      prediction = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = (current[i] - prediction) & 0xff;
  }
}

/** libpng's cost: bytes read as signed, summed by magnitude. */
function signedSum(bytes: Uint8Array, stopAbove: number) {
  let sum = 0;

  for (let i = 0; i < bytes.length && sum < stopAbove; i += 1) {
    const value = bytes[i];

    sum += value < 128 ? value : 256 - value;
  }

  return sum;
}

async function deflate(bytes: Uint8Array) {
  const stream = new Blob([bytes as BufferSource])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }

  return table;
})();

function chunk(type: string, body: Uint8Array) {
  const bytes = new Uint8Array(12 + body.byteLength);
  const view = new DataView(bytes.buffer);
  let crc = 0xffffffff;

  view.setUint32(0, body.byteLength);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(body, 8);
  for (let i = 4; i < 8 + body.byteLength; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  view.setUint32(8 + body.byteLength, (crc ^ 0xffffffff) >>> 0);

  return bytes;
}
