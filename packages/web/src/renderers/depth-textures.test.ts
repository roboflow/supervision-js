import { describe, expect, it, vi } from "vitest";

import type { DepthMap } from "supervision-js-core";
import {
  createDepthLutCache,
  createDepthTextureRing,
  createPackedDepthUpload,
  createPreviewUpload,
} from "#renderers/depth-textures";

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

  it("reallocates a slot when the size changes", () => {
    const { ring, sources } = createRing(1);

    ring.acquire(scaledMap(4, 2));
    ring.acquire(scaledMap(8, 4));

    expect(sources).toHaveLength(2);
    expect(sources[0].destroy).toHaveBeenCalledOnce();
    expect(sources[1].options.width).toBe(8);
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
