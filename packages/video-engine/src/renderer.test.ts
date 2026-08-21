import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { CanvasRenderer, createRenderer } from "./renderer";
import type {
  CanvasScrubFrame,
  ScrubFrame,
  VideoSampleLike,
} from "./scrub-cursor";
import { asSec } from "./types";
import { WebGpuRenderer } from "./webgpu-renderer";

const SRC = {} as OffscreenCanvas;

function canvasFrame(source: OffscreenCanvas = SRC): CanvasScrubFrame {
  return {
    kind: "canvas",
    source,
    timestampS: asSec(0),
    width: 320,
    height: 180,
    isKeyFrame: false,
    quality: "exact",
  };
}

function sampleFrame(sample: VideoSampleLike): ScrubFrame {
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

interface FakeCtx {
  clearRect: Mock;
  drawImage: Mock;
}

function makeCanvas(
  width = 320,
  height = 180,
): { canvas: OffscreenCanvas; ctx: FakeCtx } {
  const ctx: FakeCtx = { clearRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width,
    height,
    getContext: vi.fn(() => ctx),
  } as unknown as OffscreenCanvas;
  return { canvas, ctx };
}

describe("CanvasRenderer", () => {
  it("requests an opaque 2d context and reports its backend name", () => {
    const { canvas } = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    expect(canvas.getContext).toHaveBeenCalledWith("2d", {
      alpha: false,
      colorSpace: "srgb",
    });
    expect(renderer.name).toBe("2d");
  });

  it("draw clears then blits a canvas frame to fill the canvas", () => {
    const { canvas, ctx } = makeCanvas(320, 180);
    new CanvasRenderer(canvas).draw(canvasFrame());

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 320, 180);
    expect(ctx.drawImage).toHaveBeenCalledWith(SRC, 0, 0, 320, 180);
  });

  it("draw reads canvas dimensions live, so a resize is picked up", () => {
    const { canvas, ctx } = makeCanvas(320, 180);
    const renderer = new CanvasRenderer(canvas);
    (canvas as { width: number }).width = 640;
    (canvas as { height: number }).height = 360;
    renderer.draw(canvasFrame());

    expect(ctx.drawImage).toHaveBeenCalledWith(SRC, 0, 0, 640, 360);
  });

  it("a sample frame draws through the sample, not drawImage", () => {
    const { canvas, ctx } = makeCanvas(320, 180);
    const draw = vi.fn();
    const sample = { draw } as unknown as VideoSampleLike;
    new CanvasRenderer(canvas).draw(sampleFrame(sample));

    expect(draw).toHaveBeenCalledWith(ctx, 0, 0, 320, 180);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("draw is a no-op when no 2d context is available", () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
    } as unknown as OffscreenCanvas;
    const renderer = new CanvasRenderer(canvas);
    expect(() => renderer.draw(canvasFrame())).not.toThrow();
  });
});

describe("createRenderer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the WebGPU renderer when supported", async () => {
    const fake = {
      draw: vi.fn(),
      dispose: vi.fn(),
    } as unknown as WebGpuRenderer;
    vi.spyOn(WebGpuRenderer, "isSupported").mockReturnValue(true);
    vi.spyOn(WebGpuRenderer, "create").mockResolvedValue(fake);
    const { canvas } = makeCanvas();
    expect(await createRenderer(canvas)).toBe(fake);
  });

  it("falls back to the 2D renderer when WebGPU is unsupported", async () => {
    vi.spyOn(WebGpuRenderer, "isSupported").mockReturnValue(false);
    const { canvas } = makeCanvas();
    expect(await createRenderer(canvas)).toBeInstanceOf(CanvasRenderer);
  });

  it("pins the 2D renderer when prefer2d is set, even if WebGPU is supported", async () => {
    vi.spyOn(WebGpuRenderer, "isSupported").mockReturnValue(true);
    const create = vi.spyOn(WebGpuRenderer, "create");
    const { canvas } = makeCanvas();
    expect(await createRenderer(canvas, { prefer2d: true })).toBeInstanceOf(
      CanvasRenderer,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to 2D when WebGPU device acquisition fails", async () => {
    vi.spyOn(WebGpuRenderer, "isSupported").mockReturnValue(true);
    vi.spyOn(WebGpuRenderer, "create").mockRejectedValue(
      new Error("no adapter"),
    );
    const { canvas } = makeCanvas();
    expect(await createRenderer(canvas)).toBeInstanceOf(CanvasRenderer);
  });
});
