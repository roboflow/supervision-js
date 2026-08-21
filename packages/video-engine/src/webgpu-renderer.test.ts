import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  CanvasScrubFrame,
  ScrubFrame,
  VideoSampleLike,
} from "./scrub-cursor";
import { asSec } from "./types";
import { WebGpuRenderer } from "./webgpu-renderer";

interface GpuSurfaces {
  configure: Mock;
  importExternalTexture: Mock;
  copyExternalImageToTexture: Mock;
  conversions: FakeCanvas[];
}

/** The renderer's own 2D surfaces: the conversion canvas it paints through and
 *  the reference canvas the comparison renders. */
class FakeCanvas {
  readonly drawImage = vi.fn();
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): { drawImage: Mock; canvas: FakeCanvas } {
    return { drawImage: this.drawImage, canvas: this };
  }
}

function canvasFrame(): CanvasScrubFrame {
  return {
    kind: "canvas",
    source: {} as OffscreenCanvas,
    timestampS: asSec(0),
    width: 320,
    height: 180,
    isKeyFrame: false,
    quality: "exact",
  };
}

const VIDEO_FRAME = {
  displayWidth: 320,
  displayHeight: 180,
  close: () => undefined,
} as VideoFrame;

function sampleFrame(): ScrubFrame {
  const sample = {
    timestamp: 0,
    duration: 0,
    toVideoFrame: () => VIDEO_FRAME,
    draw: () => undefined,
    close: () => undefined,
  } as unknown as VideoSampleLike;
  return {
    kind: "sample",
    sample,
    timestampS: asSec(0),
    width: 320,
    height: 180,
    isKeyFrame: false,
    quality: "exact",
  };
}

/** Lets the measurement's GPU round-trip resolve. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * canImportExternal false drops importExternalTexture from the fake device, which
 * is how the renderer rules the direct import out up front. importedMean and
 * convertedMean are the readback the comparison sees: equal values stand for two
 * routes that agree on the frame, unequal for two that do not.
 */
async function createOverFakeGpu(opts: {
  canImportExternal: boolean;
  importedMean?: number;
  convertedMean?: number;
}): Promise<{ renderer: WebGpuRenderer; surfaces: GpuSurfaces }> {
  const conversions: FakeCanvas[] = [];
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
    constructor(width: number, height: number) {
      const canvas = new FakeCanvas(width, height);
      conversions.push(canvas);
      return canvas as unknown as OffscreenCanvas;
    }
  };
  const surfaces: GpuSurfaces = {
    configure: vi.fn(),
    importExternalTexture: vi.fn(() => ({}) as GPUExternalTexture),
    copyExternalImageToTexture: vi.fn(),
    conversions,
  };
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  // Halves of the readback the comparison maps: the direct import first, the
  // canvas conversion second.
  const readback = new Uint8Array(64 * 4 * 64 * 2);
  readback.fill(opts.importedMean ?? 0, 0, readback.length / 2);
  readback.fill(opts.convertedMean ?? 0, readback.length / 2);
  const device = {
    importExternalTexture: opts.canImportExternal
      ? surfaces.importExternalTexture
      : undefined,
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    // The fake texture carries the usage it was created with, so a copy's
    // destination can be checked against what the real API demands of one.
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
      usage: descriptor.usage,
      destroy: vi.fn(),
      createView: vi.fn(() => ({})),
    })),
    createBuffer: vi.fn(() => ({
      mapAsync: vi.fn(async () => undefined),
      getMappedRange: vi.fn(() => readback.buffer),
      unmap: vi.fn(),
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => pass),
      copyTextureToBuffer: vi.fn(),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      copyExternalImageToTexture: surfaces.copyExternalImageToTexture,
      submit: vi.fn(),
    },
    destroy: vi.fn(),
  };
  const context = {
    configure: surfaces.configure,
    getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      gpu: {
        requestAdapter: vi.fn(async () => ({
          requestDevice: vi.fn(async () => device),
        })),
        getPreferredCanvasFormat: vi.fn(() => "bgra8unorm"),
      },
    },
  });
  // The copy path ORs these bitflags when it allocates the sampled texture.
  Object.defineProperty(globalThis, "GPUTextureUsage", {
    configurable: true,
    writable: true,
    value: {
      TEXTURE_BINDING: 4,
      COPY_DST: 8,
      RENDER_ATTACHMENT: 16,
      COPY_SRC: 1,
    },
  });
  Object.defineProperty(globalThis, "GPUBufferUsage", {
    configurable: true,
    writable: true,
    value: { COPY_DST: 8, MAP_READ: 1 },
  });
  Object.defineProperty(globalThis, "GPUMapMode", {
    configurable: true,
    writable: true,
    value: { READ: 1 },
  });
  const canvas = {
    width: 320,
    height: 180,
    getContext: vi.fn(() => context),
  } as unknown as OffscreenCanvas;
  return { renderer: await WebGpuRenderer.create(canvas), surfaces };
}

/** Sources a texture was uploaded from, oldest first. */
const uploadSources = (surfaces: GpuSurfaces): unknown[] =>
  surfaces.copyExternalImageToTexture.mock.calls.map((call) => call[0].source);

/** Picks the display-sized 2D surface out of `conversions`, which also holds the
 *  small square one the comparison renders its reference into. */
const conversionCanvas = (surfaces: GpuSurfaces): FakeCanvas | undefined =>
  surfaces.conversions.find(
    (canvas) => canvas.width === 320 && canvas.height === 180,
  );

describe("WebGpuRenderer colour space", () => {
  it("configures the display canvas with a declared colour space", async () => {
    const { surfaces } = await createOverFakeGpu({ canImportExternal: true });

    expect(surfaces.configure).toHaveBeenCalledWith(
      expect.objectContaining({ colorSpace: "srgb" }),
    );
  });

  it("encodes a canvas upload into the declared colour space", async () => {
    const { renderer, surfaces } = await createOverFakeGpu({
      canImportExternal: true,
    });
    renderer.draw(canvasFrame());

    expect(surfaces.copyExternalImageToTexture.mock.calls[0][1]).toEqual(
      expect.objectContaining({ colorSpace: "srgb" }),
    );
  });

  it("converts a decoded frame through a canvas where import is unavailable", async () => {
    const { renderer, surfaces } = await createOverFakeGpu({
      canImportExternal: false,
    });
    renderer.draw(sampleFrame());

    const conversion = conversionCanvas(surfaces);
    expect(conversion?.drawImage).toHaveBeenCalledWith(
      VIDEO_FRAME,
      0,
      0,
      320,
      180,
    );
    expect(uploadSources(surfaces)).toEqual([conversion]);
    expect(surfaces.copyExternalImageToTexture.mock.calls[0][1]).toEqual(
      expect.objectContaining({ colorSpace: "srgb" }),
    );
  });
});

describe("WebGpuRenderer direct import", () => {
  it("converts through a canvas until the routes are shown to agree", async () => {
    const { renderer, surfaces } = await createOverFakeGpu({
      canImportExternal: true,
      importedMean: 100,
      convertedMean: 100,
    });

    renderer.draw(sampleFrame());
    const conversion = conversionCanvas(surfaces);
    expect(conversion?.drawImage).toHaveBeenCalledWith(
      VIDEO_FRAME,
      0,
      0,
      320,
      180,
    );
    expect(uploadSources(surfaces).at(-1)).toBe(conversion);

    await settle();
    const uploadsBefore = surfaces.copyExternalImageToTexture.mock.calls.length;
    renderer.draw(sampleFrame());

    expect(surfaces.copyExternalImageToTexture.mock.calls.length).toBe(
      uploadsBefore,
    );
    expect(surfaces.importExternalTexture).toHaveBeenCalledWith(
      expect.objectContaining({ source: VIDEO_FRAME, colorSpace: "srgb" }),
    );
  });

  it("keeps converting through a canvas when the routes disagree", async () => {
    const { renderer, surfaces } = await createOverFakeGpu({
      canImportExternal: true,
      importedMean: 111,
      convertedMean: 100,
    });

    renderer.draw(sampleFrame());
    await settle();
    const uploadsBefore = surfaces.copyExternalImageToTexture.mock.calls.length;
    renderer.draw(sampleFrame());

    expect(surfaces.copyExternalImageToTexture.mock.calls.length).toBe(
      uploadsBefore + 1,
    );
    expect(uploadSources(surfaces).at(-1)).toBe(conversionCanvas(surfaces));
  });

  it("uploads only into textures a copy is allowed to target", async () => {
    const { renderer, surfaces } = await createOverFakeGpu({
      canImportExternal: true,
      importedMean: 100,
      convertedMean: 100,
    });

    renderer.draw(sampleFrame());
    await settle();

    // A destination without RENDER_ATTACHMENT has its copy rejected and stays
    // black, which the comparison would read as two routes disagreeing.
    const destinations = surfaces.copyExternalImageToTexture.mock.calls.map(
      (call) => call[1].texture.usage & GPUTextureUsage.RENDER_ATTACHMENT,
    );
    expect(destinations.length).toBeGreaterThan(0);
    expect(destinations).not.toContain(0);
  });

  it("measures once, however many frames are drawn while it is in flight", async () => {
    const { renderer, surfaces } = await createOverFakeGpu({
      canImportExternal: true,
      importedMean: 100,
      convertedMean: 100,
    });

    renderer.draw(sampleFrame());
    renderer.draw(sampleFrame());
    renderer.draw(sampleFrame());
    await settle();

    expect(surfaces.importExternalTexture).toHaveBeenCalledTimes(1);
  });
});
