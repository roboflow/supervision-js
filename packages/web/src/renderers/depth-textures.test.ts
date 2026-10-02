import { describe, expect, it, vi } from "vitest";

import type { DepthMap } from "supervision-js-core";
import {
  createDepthMapUpload,
  createDepthTextureRing,
  createPackedDepthUpload,
  createPreviewUpload,
  queryMaxTextureSize,
  rememberPreparedDepthUpload,
} from "#renderers/depth-textures";
import { decimateDepthUpload } from "#render-preparation/depth/frame-decode";
import { displayDecimation } from "#render-preparation/depth/files";

function scaledMap(width: number, height: number, first = 1): DepthMap {
  return {
    height,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 256,
      values: Uint16Array.from(
        { length: width * height },
        (_, index) => first + index * 257,
      ),
    },
    width,
  };
}

describe("depth texture uploads", () => {
  it("send samples low byte first, padding rows only where WebGL needs it", () => {
    const values = Uint16Array.from([
      0x0102, 0x0304, 0x0506, 0x0708, 0x090a, 0x0b0c,
    ]);
    const webgl = createPackedDepthUpload(values, 3, 2, false);
    const webgpu = createPackedDepthUpload(values, 3, 2, true);

    expect(webgl).toMatchObject({ format: "rg8unorm", textureWidth: 4 });
    expect(Array.from(webgl.bytes)).toEqual([
      2, 1, 4, 3, 6, 5, 0, 0, 8, 7, 10, 9, 12, 11, 0, 0,
    ]);
    expect(webgpu.textureWidth).toBe(3);
    expect(webgpu.bytes.buffer).toBe(values.buffer);

    const codes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const preview = createPreviewUpload(codes, 5, 2, false);

    expect(preview).toMatchObject({ format: "r8unorm", textureWidth: 8 });
    expect(Array.from(preview.bytes)).toEqual([
      1, 2, 3, 4, 5, 0, 0, 0, 6, 7, 8, 9, 10, 0, 0, 0,
    ]);
    expect(createPreviewUpload(codes, 5, 2, true).bytes).toBe(codes);
  });

  it("decimate a map larger than the GPU's largest texture to real samples", () => {
    const width = 8193;
    const height = 4;
    const map = scaledMap(width, height);
    const values = map.samples.values as Uint16Array;

    const upload = createDepthMapUpload(map, true, 8192);

    expect(upload.displaySize).toEqual({ height: 2, width: 4097 });
    const texels = new Uint16Array(
      upload.bytes.buffer,
      upload.bytes.byteOffset,
      4097 * 2,
    );
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [2048, 1],
      [4096, 1],
    ]) {
      const column = Math.min(
        width - 1,
        Math.floor(((x + 0.5) * width) / 4097),
      );
      const row = Math.floor(((y + 0.5) * height) / 2);

      expect(texels[y * 4097 + x]).toBe(values[row * width + column]);
    }
    expect(values).toHaveLength(width * height);

    expect(
      createDepthMapUpload(scaledMap(8193, 2), false, 8192).textureWidth,
    ).toBe(4098);

    const fits = scaledMap(8192, 1);

    expect(createDepthMapUpload(fits, true, 8192).bytes.buffer).toBe(
      (fits.samples.values as Uint16Array).buffer,
    );

    const preview: DepthMap = {
      height: 1,
      kind: "disparity_px",
      samples: {
        encoding: "preview8",
        range: { max: 100, min: 0 },
        reservedMax: 15,
        values: Uint8Array.from({ length: 9000 }, (_, i) => i % 251),
      },
      width: 9000,
    };
    const previewUpload = createDepthMapUpload(preview, true, 4096);

    expect(previewUpload.displaySize).toEqual({ height: 1, width: 3000 });
    expect(previewUpload.bytes[1]).toBe(preview.samples.values[4]);
  });

  it("read the largest texture each backend takes, or what it guarantees", () => {
    const getParameter = vi.fn((name: number) => (name === 3379 ? 8192 : 0));

    expect(
      queryMaxTextureSize({
        gpu: { device: { limits: { maxTextureDimension2D: 16_384 } } },
        name: "webgpu",
      }),
    ).toBe(16_384);
    expect(
      queryMaxTextureSize({
        gl: { MAX_TEXTURE_SIZE: 3379, getParameter },
        name: "webgl",
      }),
    ).toBe(8192);
    expect(queryMaxTextureSize({ name: "webgpu" })).toBe(8192);
    expect(queryMaxTextureSize(null)).toBe(2048);
  });

  it("use an upload prepared off the main thread only when its rows fit the backend", () => {
    const map = scaledMap(3, 2);
    const prepared = createPackedDepthUpload(
      map.samples.values as Uint16Array,
      3,
      2,
      false,
    );

    rememberPreparedDepthUpload(map, prepared);

    expect(createDepthMapUpload(map, false).bytes).toBe(prepared.bytes);
    // WebGPU takes the rows unpadded, so the padded copy does not fit.
    expect(createDepthMapUpload(map, true).bytes.buffer).toBe(
      (map.samples.values as Uint16Array).buffer,
    );

    const large = scaledMap(8, 4);
    const decimated = decimateDepthUpload(
      large.samples.values as Uint16Array,
      8,
      4,
      2,
      true,
    )!;

    rememberPreparedDepthUpload(large, {
      bytes: decimated.bytes,
      displaySize: { height: decimated.height, width: decimated.width },
      format: "rg8unorm",
      textureWidth: decimated.textureWidth,
    });

    expect(createDepthMapUpload(large, false)).toMatchObject({
      bytes: decimated.bytes,
      displaySize: { height: 2, width: 4 },
    });
    expect(large.samples.values).toHaveLength(32);
  });
});

describe("depth decimated for display while decoding", () => {
  it("keeps each block's centre sample, padding an odd row for WebGL", () => {
    const values = Uint16Array.from({ length: 6 * 4 }, (_, index) => index);
    const upload = decimateDepthUpload(values, 6, 4, 2, false)!;

    expect(upload).toMatchObject({ height: 2, textureWidth: 3, width: 3 });
    expect(Array.from(new Uint16Array(upload.bytes.buffer))).toEqual([
      7, 9, 11, 19, 21, 23,
    ]);
    expect(decimateDepthUpload(values, 6, 4, 2, true)).toMatchObject({
      textureWidth: 4,
      width: 3,
    });
  });

  it("shrinks only by a whole factor the box cannot show", () => {
    const media = { height: 2160, width: 3840 };
    const map = { height: 2160, width: 3840 };
    const box = (boxWidth: number, devicePixelRatio: number) =>
      displayDecimation(map, {
        display: { boxHeight: 2160, boxWidth, devicePixelRatio },
        media,
      });

    expect(displayDecimation(map, { media })).toBe(1);
    expect(box(1280, 1)).toBe(3);
    expect(box(1280, 2)).toBe(1);
    expect(box(1920, 1)).toBe(2);
    // The ceiling on the pixel ratio applies, as it does to masks.
    expect(box(640, 3)).toBe(3);
  });
});

describe("depth texture ring", () => {
  it("evicts the stalest map it was not told to keep, and reallocates on a new size", () => {
    const sources: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const ring = createDepthTextureRing({
      BufferImageSource: class {
        readonly destroy = vi.fn();
        readonly update = vi.fn();
        constructor() {
          sources.push(this);
        }
      } as never,
      acceptsUnalignedTextureRows: () => true,
      size: 3,
    });
    const [now, next, after, later] = [1, 2, 3, 4].map((first) =>
      scaledMap(4, 2, first),
    );

    ring.acquire(next);
    ring.acquire(after);
    ring.acquire(now);
    expect(ring.acquire(now)).toBe(ring.acquire(now));
    ring.acquire(later, new Set([now, next, after]));

    // Every slot was kept, so the stalest of them went: `next`.
    expect(ring.has(next)).toBe(false);

    ring.acquire(next, new Set([now, next, later]));
    expect(ring.has(after)).toBe(false);
    expect([now, next, later].every((map) => ring.has(map))).toBe(true);
    expect(sources).toHaveLength(3);

    ring.acquire(scaledMap(8, 4));
    expect(sources).toHaveLength(4);
    expect(
      sources.filter((source) => source.destroy.mock.calls.length),
    ).toHaveLength(1);
  });
});
