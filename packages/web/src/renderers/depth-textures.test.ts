import { describe, expect, it, vi } from "vitest";

import type { DepthMap } from "supervision-js-core";
import {
  createDepthLutCache,
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
  it("uploads exact samples as their own bytes on a little-endian host", () => {
    const values = Uint16Array.from([0x0102, 0xfffe, 0x8000, 0x0001]);
    const upload = createPackedDepthUpload(values, 2, 2, false, true);

    expect(upload.bytes.buffer).toBe(values.buffer);
    expect(upload.textureWidth).toBe(2);
    expect(upload.format).toBe("rg8unorm");
    expect(Array.from(upload.bytes)).toEqual([2, 1, 254, 255, 0, 128, 1, 0]);
  });

  it("writes low then high bytes itself on a big-endian host", () => {
    const values = Uint16Array.from([0x0102, 0xfffe]);
    const upload = createPackedDepthUpload(values, 2, 1, false, false);

    expect(upload.bytes.buffer).not.toBe(values.buffer);
    expect(Array.from(upload.bytes)).toEqual([2, 1, 254, 255]);
  });

  it("pads odd rows for WebGL and never for WebGPU", () => {
    const values = Uint16Array.from([
      0x0102, 0x0304, 0x0506, 0x0708, 0x090a, 0x0b0c,
    ]);
    const webgl = createPackedDepthUpload(values, 3, 2, false, true);
    const webgpu = createPackedDepthUpload(values, 3, 2, true, true);

    expect(webgl.textureWidth).toBe(4);
    expect(Array.from(webgl.bytes)).toEqual([
      2, 1, 4, 3, 6, 5, 0, 0, 8, 7, 10, 9, 12, 11, 0, 0,
    ]);
    expect(webgpu.textureWidth).toBe(3);
    expect(webgpu.bytes.buffer).toBe(values.buffer);
  });

  it("pads preview rows to four bytes for WebGL", () => {
    const codes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const webgl = createPreviewUpload(codes, 5, 2, false);
    const aligned = createPreviewUpload(codes.subarray(0, 8), 4, 2, false);

    expect(webgl).toMatchObject({ format: "r8unorm", textureWidth: 8 });
    expect(Array.from(webgl.bytes)).toEqual([
      1, 2, 3, 4, 5, 0, 0, 0, 6, 7, 8, 9, 10, 0, 0, 0,
    ]);
    expect(aligned.textureWidth).toBe(4);
    expect(createPreviewUpload(codes, 5, 2, true).bytes).toBe(codes);
  });
});

describe("maps larger than the GPU's largest texture", () => {
  it("go up nearest-decimated to fit, keeping real samples", () => {
    const width = 8193;
    const height = 4;
    const map = scaledMap(width, height);
    const values = map.samples.values as Uint16Array;

    const upload = createDepthMapUpload(map, true, 8192);

    expect(upload.displaySize).toEqual({ height: 2, width: 4097 });
    expect(upload.textureWidth).toBe(4097);
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
    // The map itself keeps every sample for readouts.
    expect(values).toHaveLength(width * height);
  });

  it("pad a decimated copy whose width WebGL cannot take as it is", () => {
    const upload = createDepthMapUpload(scaledMap(8193, 2), false, 8192);

    expect(upload.displaySize).toEqual({ height: 1, width: 4097 });
    expect(upload.textureWidth).toBe(4098);
  });

  it("decimate preview codes the same way", () => {
    const map: DepthMap = {
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

    const upload = createDepthMapUpload(map, true, 4096);

    expect(upload).toMatchObject({
      displaySize: { height: 1, width: 3000 },
      format: "r8unorm",
    });
    expect(upload.bytes[1]).toBe(map.samples.values[4]);
  });

  it("leave a map that fits untouched", () => {
    const map = scaledMap(8192, 1);

    const upload = createDepthMapUpload(map, true, 8192);

    expect(upload.displaySize).toEqual({ height: 1, width: 8192 });
    expect(upload.bytes.buffer).toBe(
      (map.samples.values as Uint16Array).buffer,
    );
  });
});

describe("queryMaxTextureSize", () => {
  it("reads WebGPU's device limit", () => {
    expect(
      queryMaxTextureSize({
        gpu: { device: { limits: { maxTextureDimension2D: 16_384 } } },
        name: "webgpu",
      }),
    ).toBe(16_384);
  });

  it("reads WebGL's MAX_TEXTURE_SIZE", () => {
    const getParameter = vi.fn((name: number) => (name === 3379 ? 8192 : 0));

    expect(
      queryMaxTextureSize({
        gl: { MAX_TEXTURE_SIZE: 3379, getParameter },
        name: "webgl",
      }),
    ).toBe(8192);
  });

  it("falls back to what each API guarantees", () => {
    expect(queryMaxTextureSize({ name: "webgpu" })).toBe(8192);
    expect(queryMaxTextureSize({ name: "webgl" })).toBe(2048);
    expect(queryMaxTextureSize(null)).toBe(2048);
  });
});

describe("uploads prepared off the main thread", () => {
  it("are used when they fit the backend's row alignment", () => {
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
  });

  it("go up decimated for the box they are shown in, the map kept whole", () => {
    const map = scaledMap(8, 4);
    const decimated = decimateDepthUpload(
      map.samples.values as Uint16Array,
      8,
      4,
      2,
      true,
    )!;

    rememberPreparedDepthUpload(map, {
      bytes: decimated.bytes,
      displaySize: { height: decimated.height, width: decimated.width },
      format: "rg8unorm",
      textureWidth: decimated.textureWidth,
    });

    const upload = createDepthMapUpload(map, false);

    expect(upload.displaySize).toEqual({ height: 2, width: 4 });
    expect(upload.bytes).toBe(decimated.bytes);
    expect(map.samples.values).toHaveLength(32);
  });
});

describe("depth decimated for display while decoding", () => {
  it("keeps each block's centre sample, low byte first", () => {
    const values = Uint16Array.from({ length: 6 * 4 }, (_, index) => index);
    const upload = decimateDepthUpload(values, 6, 4, 2, false)!;

    expect(upload).toMatchObject({ height: 2, textureWidth: 3, width: 3 });
    expect(Array.from(new Uint16Array(upload.bytes.buffer))).toEqual([
      7, 9, 11, 19, 21, 23,
    ]);
  });

  it("pads an odd decimated row for WebGL", () => {
    const upload = decimateDepthUpload(new Uint16Array(6 * 2), 6, 2, 2, true)!;

    expect(upload).toMatchObject({ textureWidth: 4, width: 3 });
    expect(upload.bytes.byteLength).toBe(4 * 1 * 2);
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
  function createRing(size = 2) {
    const sources: FakeBufferImageSource[] = [];
    class FakeBufferImageSource {
      resource: Uint8Array;
      readonly destroy = vi.fn();
      readonly update = vi.fn();

      constructor(readonly options: { resource: Uint8Array; width: number }) {
        this.resource = options.resource;
        sources.push(this);
      }
    }
    const ring = createDepthTextureRing({
      BufferImageSource: FakeBufferImageSource as never,
      acceptsUnalignedTextureRows: () => true,
      size,
    });

    return { ring, sources };
  }

  it("never uploads a resident map again", () => {
    const { ring, sources } = createRing();
    const map = scaledMap(4, 2);

    const first = ring.acquire(map);
    const second = ring.acquire(map);

    expect(second).toBe(first);
    expect(sources).toHaveLength(1);
    expect(sources[0].update).not.toHaveBeenCalled();
  });

  it("reuses the stalest slot's texture in place for a map of the same size", () => {
    const { ring, sources } = createRing(2);
    const a = scaledMap(4, 2, 1);
    const b = scaledMap(4, 2, 2);
    const c = scaledMap(4, 2, 3);

    ring.acquire(a);
    ring.acquire(b);
    ring.acquire(b);
    const slot = ring.acquire(c);

    expect(sources).toHaveLength(2);
    expect(slot.source).toBe(sources[0]);
    expect(sources[0].update).toHaveBeenCalledOnce();
    expect(sources[0].resource.buffer).toBe(
      (c.samples.values as Uint16Array).buffer,
    );
    expect(ring.has(a)).toBe(false);
    expect(ring.has(b)).toBe(true);
  });

  it("spares the maps it is told to keep, however stale", () => {
    const { ring } = createRing(3);
    const [now, next, after, later] = [1, 2, 3, 4].map((first) =>
      scaledMap(4, 2, first),
    );

    ring.acquire(next);
    ring.acquire(after);
    ring.acquire(now);
    ring.acquire(now);
    ring.acquire(later, new Set([now, next, after]));

    // Every slot was kept, so the stalest of them went: `next`.
    expect(ring.has(next)).toBe(false);

    ring.acquire(next, new Set([now, next, later]));
    expect(ring.has(after)).toBe(false);
    expect(ring.has(later)).toBe(true);
  });

  it("reallocates a slot when the size changes", () => {
    const { ring, sources } = createRing(1);

    ring.acquire(scaledMap(4, 2));
    ring.acquire(scaledMap(8, 4));

    expect(sources).toHaveLength(2);
    expect(sources[0].destroy).toHaveBeenCalledOnce();
    expect(sources[1].options.width).toBe(8);
  });

  it("reports the decimated size of a map too large for the GPU", () => {
    const sources: { options: { width: number; height: number } }[] = [];
    const ring = createDepthTextureRing({
      BufferImageSource: class {
        readonly destroy = vi.fn();
        constructor(readonly options: { width: number; height: number }) {
          sources.push(this);
        }
      } as never,
      acceptsUnalignedTextureRows: () => true,
      maxTextureSize: () => 8192,
    });

    const slot = ring.acquire(scaledMap(16_384, 2));

    expect(slot.displaySize).toEqual({ height: 1, width: 8192 });
    expect(sources[0]!.options).toMatchObject({ height: 1, width: 8192 });
  });

  it("releases every texture on destroy", () => {
    const { ring, sources } = createRing(2);

    ring.acquire(scaledMap(4, 2, 1));
    ring.acquire(scaledMap(4, 2, 2));
    ring.destroy();

    expect(
      sources.every((source) => source.destroy.mock.calls.length === 1),
    ).toBe(true);
  });
});

describe("depth colour table textures", () => {
  it("builds one linear 256x1 texture per table and reuses it", () => {
    const options: unknown[] = [];
    class FakeBufferImageSource {
      readonly destroy = vi.fn();
      constructor(value: unknown) {
        options.push(value);
      }
    }
    const luts = createDepthLutCache(FakeBufferImageSource as never);

    expect(luts.get("turbo")).toBe(luts.get("turbo"));
    luts.get("viridis");

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      format: "rgba8unorm",
      height: 1,
      scaleMode: "linear",
      width: 256,
    });
  });
});
