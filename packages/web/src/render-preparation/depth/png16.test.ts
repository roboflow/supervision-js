import { describe, expect, it } from "vitest";

import { deflate, encodePng } from "../../../../../test/depth-png";
import {
  decodePng16,
  decodePng8Gray,
  inflateWithDecompressionStream,
} from "./png16";

/** Every 16-bit code once, shuffled so neighbouring bytes differ. */
function everyCode() {
  const samples = new Uint16Array(65_536);

  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = (i * 40_503) & 0xffff;
  }

  return samples;
}

describe("depth PNG decoding", () => {
  it.each([0, 1, 2, 3, 4, undefined])(
    "round-trips all 65,536 codes under row filter %s (undefined mixes them, split over IDAT chunks)",
    async (filter) => {
      const samples = everyCode();
      const png = await encodePng({
        filterFor: filter === undefined ? undefined : () => filter,
        height: 256,
        idatChunks: filter === undefined ? 7 : 1,
        samples,
        width: 256,
      });

      expect((await decodePng16(png.slice().buffer)).values).toEqual(samples);
    },
  );

  it("round-trips a confidence plane", async () => {
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

    expect((await decodePng8Gray(png)).values).toEqual(samples);
  });

  it("pads odd-width rows for WebGL when asked, and only then", async () => {
    const samples = Uint16Array.from({ length: 5 * 3 }, (_, i) => i * 1000 + 1);
    const png = await encodePng({ height: 3, samples, width: 5 });
    const padded = await decodePng16(png, { padRowsForWebGl: true });
    const texels = new Uint16Array(padded.paddedUpload!.bytes.buffer);

    expect((await decodePng16(png)).paddedUpload).toBeUndefined();
    expect(padded.paddedUpload?.textureWidth).toBe(6);
    for (let y = 0; y < 3; y += 1) {
      expect(Array.from(texels.subarray(y * 6, y * 6 + 5))).toEqual(
        Array.from(samples.subarray(y * 5, y * 5 + 5)),
      );
    }
  });

  it("refuses what it cannot decode, saying why", async () => {
    const gray = (options: Partial<Parameters<typeof encodePng>[0]>) =>
      encodePng({ height: 2, samples: [1, 2, 3, 4], width: 2, ...options });
    const full = await encodePng({
      height: 16,
      samples: everyCode(),
      width: 16,
    });

    await expect(decodePng16(new Uint8Array(32))).rejects.toThrow(
      new RangeError("Not a PNG file."),
    );
    await expect(decodePng16(await gray({ interlace: 1 }))).rejects.toThrow(
      "Interlaced PNGs are not supported.",
    );
    await expect(decodePng16(await gray({ bitDepth: 8 }))).rejects.toThrow(
      "Expected a 16-bit grayscale PNG, got bit depth 8 with colour type 0.",
    );
    await expect(decodePng8Gray(await gray({}))).rejects.toThrow(
      "Expected a 8-bit grayscale PNG, got bit depth 16 with colour type 0.",
    );
    await expect(
      decodePng16(
        await encodePng({ colorType: 2, height: 1, samples: [1], width: 1 }),
      ),
    ).rejects.toThrow(
      "Expected a 16-bit grayscale PNG, got bit depth 16 with colour type 2.",
    );
    await expect(
      decodePng16(full.subarray(0, full.length - 20)),
    ).rejects.toThrow("PNG file is truncated.");
    await expect(
      decodePng16(full, {
        inflate: async (_, byteLength) => new Uint8Array(byteLength - 1),
      }),
    ).rejects.toThrow("PNG image data is shorter than its header says.");
    await expect(
      decodePng16(await gray({}), {
        inflate: async (_, byteLength) => new Uint8Array(byteLength).fill(9),
      }),
    ).rejects.toThrow("PNG row 0 has unknown filter 9.");
  });

  it("inflates a zlib stream fed in pieces, and refuses one too long or corrupt", async () => {
    const data = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 0xff);
    const zlib = await deflate(data);

    expect(
      await inflateWithDecompressionStream(
        [zlib.subarray(0, 10), zlib.subarray(10)],
        data.length,
      ),
    ).toEqual(data);
    await expect(
      inflateWithDecompressionStream([zlib], data.length - 1),
    ).rejects.toThrow("PNG image data is longer than its header says.");
    await expect(
      inflateWithDecompressionStream([new Uint8Array([1, 2, 3, 4])], 10),
    ).rejects.toThrow(RangeError);
  });
});
