import { describe, expect, it } from "vitest";

import { deflate, encodePng } from "../../../../test/depth-png";
import {
  decodePng16,
  decodePng8Gray,
  inflateWithDecompressionStream,
} from "./depth-png16";

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
