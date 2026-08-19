import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMediaCompositor,
  type MediaGpuTextureSource,
} from "./pixi-media-scene";

interface FakeTexture {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly height: number;
  readonly width: number;
}

interface FakeDevice {
  readonly copies: { texture: FakeTexture }[];
  readonly created: FakeTexture[];
  readonly device: GPUDevice;
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", {
    COPY_DST: 1,
    RENDER_ATTACHMENT: 2,
    TEXTURE_BINDING: 4,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media compositor", () => {
  it("copies a frame of the media's own size into the texture it started with", () => {
    const gpu = createFakeDevice();
    const source = createTextureSource();
    const compositor = createMediaCompositor({
      attach: () => source,
      device: gpu.device,
      height: 240,
      onTextureReplaced: vi.fn(),
      width: 320,
    });

    compositor.upload(frame(320, 240));

    expect(gpu.created).toHaveLength(1);
    expect(gpu.copies).toStrictEqual([{ texture: gpu.created[0] }]);
  });

  it("takes a decode of another size on a texture sized by the frame", () => {
    const gpu = createFakeDevice();
    const source = createTextureSource();
    const onTextureReplaced = vi.fn();
    const compositor = createMediaCompositor({
      attach: () => source,
      device: gpu.device,
      height: 240,
      onTextureReplaced,
      width: 320,
    });

    compositor.upload(frame(640, 360));

    const [retired, replacement] = gpu.created;
    expect([replacement.width, replacement.height]).toStrictEqual([640, 360]);
    expect(source.updateGPUTexture.mock.calls).toStrictEqual([[replacement]]);
    expect(retired.destroy).toHaveBeenCalledTimes(1);
    expect(onTextureReplaced).toHaveBeenCalledTimes(1);
    expect(gpu.copies).toStrictEqual([{ texture: replacement }]);
  });

  it("leaves no texture behind when the swap is refused", () => {
    const gpu = createFakeDevice();
    const source = createTextureSource();
    source.updateGPUTexture.mockImplementation(() => {
      throw new Error("texture rejected");
    });
    const compositor = createMediaCompositor({
      attach: () => source,
      device: gpu.device,
      height: 240,
      onTextureReplaced: vi.fn(),
      width: 320,
    });

    expect(() => compositor.upload(frame(640, 360))).toThrow(
      "texture rejected",
    );

    const [live, refused] = gpu.created;
    expect(refused.destroy).toHaveBeenCalledTimes(1);
    expect(live.destroy).not.toHaveBeenCalled();

    // The texture that stayed on screen still takes frames, and the destroy
    // below accounts for it, so nothing the compositor made outlives it.
    compositor.upload(frame(320, 240));
    compositor.destroy();

    expect(gpu.copies).toStrictEqual([{ texture: live }]);
    expect(
      gpu.created.map((texture) => texture.destroy.mock.calls.length),
    ).toStrictEqual([1, 1]);
  });

  it("destroys the texture it is holding when it is destroyed", () => {
    const gpu = createFakeDevice();
    const compositor = createMediaCompositor({
      attach: () => createTextureSource(),
      device: gpu.device,
      height: 240,
      onTextureReplaced: vi.fn(),
      width: 320,
    });

    compositor.upload(frame(640, 360));
    compositor.destroy();

    expect(
      gpu.created.map((texture) => texture.destroy.mock.calls.length),
    ).toStrictEqual([1, 1]);
  });
});

function createFakeDevice(): FakeDevice {
  const created: FakeTexture[] = [];
  const copies: { texture: FakeTexture }[] = [];

  const device = {
    createTexture(descriptor: {
      readonly size: { readonly height: number; readonly width: number };
    }): FakeTexture {
      const texture = {
        destroy: vi.fn(),
        height: descriptor.size.height,
        width: descriptor.size.width,
      };

      created.push(texture);
      return texture;
    },
    queue: {
      copyExternalImageToTexture(
        _source: unknown,
        destination: { readonly texture: FakeTexture },
      ) {
        copies.push({ texture: destination.texture });
      },
    },
  };

  return { copies, created, device: device as unknown as GPUDevice };
}

function createTextureSource() {
  return {
    updateGPUTexture: vi.fn<MediaGpuTextureSource["updateGPUTexture"]>(),
  };
}

function frame(displayWidth: number, displayHeight: number): VideoFrame {
  return { displayHeight, displayWidth } as unknown as VideoFrame;
}
