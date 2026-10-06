/**
 * A reference grayscale PNG writer for tests: big-endian samples, a chosen
 * filter per row, the platform's zlib. It shares no code with the decoder it
 * checks.
 */
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

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;

  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

export async function deflate(bytes: Uint8Array) {
  const stream = new Blob([bytes as BufferSource])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export interface PngOptions {
  readonly width: number;
  readonly height: number;
  readonly samples: ArrayLike<number>;
  readonly bitDepth?: 8 | 16;
  readonly colorType?: number;
  readonly interlace?: number;
  /** Filter for row `y`; every PNG filter by default, in turn. */
  readonly filterFor?: (y: number) => number;
  readonly idatChunks?: number;
}

/** A reference encoder: big-endian samples, per-row filters, zlib stream. */
export async function encodePng(options: PngOptions) {
  const bitDepth = options.bitDepth ?? 16;
  const bytesPerSample = bitDepth / 8;
  const stride = options.width * bytesPerSample;
  const raw = new Uint8Array(options.height * (stride + 1));
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < options.height; y += 1) {
    for (let x = 0; x < options.width; x += 1) {
      const value = options.samples[y * options.width + x];

      if (bytesPerSample === 2) {
        current[x * 2] = value >> 8;
        current[x * 2 + 1] = value & 0xff;
      } else {
        current[x] = value;
      }
    }

    const filter = options.filterFor?.(y) ?? y % 5;
    const row = y * (stride + 1);

    raw[row] = filter;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bytesPerSample ? current[i - bytesPerSample] : 0;
      const b = previous[i];
      const c = i >= bytesPerSample ? previous[i - bytesPerSample] : 0;
      const prediction = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];

      raw[row + 1 + i] = (current[i] - prediction) & 0xff;
    }
    previous.set(current);
  }

  const zlib = await deflate(raw);
  const idatChunks = options.idatChunks ?? 1;
  const idatSize = Math.ceil(zlib.length / idatChunks);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);

  headerView.setUint32(0, options.width);
  headerView.setUint32(4, options.height);
  header[8] = bitDepth;
  header[9] = options.colorType ?? 0;
  header[12] = options.interlace ?? 0;

  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", new TextEncoder().encode("Software\0test")),
  ];

  for (let start = 0; start < zlib.length; start += idatSize) {
    parts.push(chunk("IDAT", zlib.subarray(start, start + idatSize)));
  }
  parts.push(chunk("IEND", new Uint8Array(0)));

  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }

  return png;
}

function chunk(type: string, body: Uint8Array) {
  const bytes = new Uint8Array(12 + body.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(body, 8);
  view.setUint32(8 + body.length, crc32(bytes.subarray(4, 8 + body.length)));

  return bytes;
}
