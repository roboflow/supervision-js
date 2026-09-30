import { describe, expect, it } from "vitest";

import {
  decodePng16,
  decodePng8Gray,
  inflateWithDecompressionStream,
} from "./depth-png16";

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

async function deflate(bytes: Uint8Array) {
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

interface PngOptions {
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
async function encodePng(options: PngOptions) {
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

/** Every 16-bit code once, shuffled so neighbouring bytes differ. */
function everyCode() {
  const samples = new Uint16Array(65_536);

  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = (i * 40_503) & 0xffff;
  }

  return samples;
}

describe("decodePng16", () => {
  it.each([
    ["None", 0],
    ["Sub", 1],
    ["Up", 2],
    ["Average", 3],
    ["Paeth", 4],
  ])("round-trips all 65,536 codes under the %s filter", async (_, filter) => {
    const samples = everyCode();
    const png = await encodePng({
      filterFor: () => filter,
      height: 256,
      samples,
      width: 256,
    });

    const decoded = await decodePng16(png);

    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(256);
    expect(decoded.values).toEqual(samples);
  });

  it("round-trips rows that mix every filter, from an ArrayBuffer", async () => {
    const samples = everyCode();
    const png = await encodePng({ height: 256, samples, width: 256 });

    const decoded = await decodePng16(png.slice().buffer);

    expect(decoded.values).toEqual(samples);
  });

  it("writes samples in host byte order", async () => {
    const png = await encodePng({
      height: 1,
      samples: [0x0102, 0xfffe],
      width: 2,
    });

    const decoded = await decodePng16(png);

    expect(Array.from(decoded.values)).toEqual([0x0102, 0xfffe]);
    expect(Array.from(new Uint8Array(decoded.values.buffer))).toEqual([
      0x02, 0x01, 0xfe, 0xff,
    ]);
  });

  it("joins image data split over several IDAT chunks", async () => {
    const samples = everyCode();
    const png = await encodePng({
      height: 256,
      idatChunks: 7,
      samples,
      width: 256,
    });

    expect((await decodePng16(png)).values).toEqual(samples);
  });

  it("pads odd-width rows for WebGL when asked, and only then", async () => {
    const samples = Uint16Array.from({ length: 5 * 3 }, (_, i) => i * 1000 + 1);
    const png = await encodePng({ height: 3, samples, width: 5 });

    const plain = await decodePng16(png);
    const padded = await decodePng16(png, { padRowsForWebGl: true });

    expect(plain.paddedUpload).toBeUndefined();
    expect(padded.values).toEqual(samples);
    expect(padded.paddedUpload?.textureWidth).toBe(6);
    expect(padded.paddedUpload?.bytes.byteLength).toBe(6 * 3 * 2);
    const texels = new Uint16Array(padded.paddedUpload!.bytes.buffer);
    for (let y = 0; y < 3; y += 1) {
      expect(Array.from(texels.subarray(y * 6, y * 6 + 5))).toEqual(
        Array.from(samples.subarray(y * 5, y * 5 + 5)),
      );
    }

    const even = await decodePng16(
      await encodePng({ height: 1, samples: [1, 2], width: 2 }),
      { padRowsForWebGl: true },
    );
    expect(even.paddedUpload).toBeUndefined();
  });

  it("rejects a file that is not a PNG", async () => {
    await expect(decodePng16(new Uint8Array(32))).rejects.toThrow(
      new RangeError("Not a PNG file."),
    );
  });

  it("rejects interlaced images", async () => {
    const png = await encodePng({
      height: 2,
      interlace: 1,
      samples: [1, 2, 3, 4],
      width: 2,
    });

    await expect(decodePng16(png)).rejects.toThrow(
      "Interlaced PNGs are not supported.",
    );
  });

  it("rejects an 8-bit image where 16 bits are required", async () => {
    const png = await encodePng({
      bitDepth: 8,
      height: 2,
      samples: [1, 2, 3, 4],
      width: 2,
    });

    await expect(decodePng16(png)).rejects.toThrow(
      "Expected a 16-bit grayscale PNG, got bit depth 8 with colour type 0.",
    );
  });

  it("rejects colour images", async () => {
    const png = await encodePng({
      colorType: 2,
      height: 1,
      samples: [1],
      width: 1,
    });

    await expect(decodePng16(png)).rejects.toThrow(
      "Expected a 16-bit grayscale PNG, got bit depth 16 with colour type 2.",
    );
  });

  it("rejects truncated files and image data", async () => {
    const png = await encodePng({
      height: 16,
      samples: everyCode(),
      width: 16,
    });

    await expect(decodePng16(png.subarray(0, png.length - 20))).rejects.toThrow(
      "PNG file is truncated.",
    );

    await expect(
      decodePng16(png, {
        inflate: async (_, byteLength) => new Uint8Array(byteLength - 1),
      }),
    ).rejects.toThrow("PNG image data is shorter than its header says.");
  });

  it("rejects an unknown row filter", async () => {
    const png = await encodePng({ height: 2, samples: [1, 2, 3, 4], width: 2 });

    await expect(
      decodePng16(png, {
        inflate: async (_, byteLength) => new Uint8Array(byteLength).fill(9),
      }),
    ).rejects.toThrow("PNG row 0 has unknown filter 9.");
  });
});

describe("decodePng8Gray", () => {
  it("round-trips a confidence plane under every filter", async () => {
    const samples = Uint8Array.from(
      { length: 37 * 11 },
      (_, i) => (i * 97) & 0xff,
    );
    const png = await encodePng({
      bitDepth: 8,
      height: 11,
      samples,
      width: 37,
    });

    const decoded = await decodePng8Gray(png);

    expect(decoded.width).toBe(37);
    expect(decoded.height).toBe(11);
    expect(decoded.values).toEqual(samples);
  });

  it("rejects a 16-bit image where 8 bits are required", async () => {
    const png = await encodePng({ height: 1, samples: [1], width: 1 });

    await expect(decodePng8Gray(png)).rejects.toThrow(
      "Expected a 8-bit grayscale PNG, got bit depth 16 with colour type 0.",
    );
  });
});

describe("inflateWithDecompressionStream", () => {
  it("inflates a zlib stream fed in pieces into one buffer", async () => {
    const data = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 0xff);
    const zlib = await deflate(data);

    const inflated = await inflateWithDecompressionStream(
      [zlib.subarray(0, 10), zlib.subarray(10)],
      data.length,
    );

    expect(inflated).toEqual(data);
  });

  it("refuses more data than the header allows", async () => {
    const zlib = await deflate(new Uint8Array(1000));

    await expect(inflateWithDecompressionStream([zlib], 999)).rejects.toThrow(
      "PNG image data is longer than its header says.",
    );
  });

  it("reports a corrupt stream as a RangeError", async () => {
    await expect(
      inflateWithDecompressionStream([new Uint8Array([1, 2, 3, 4])], 10),
    ).rejects.toThrow(RangeError);
  });
});
