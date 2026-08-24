/// <reference types="@webgpu/types" />

import { DISPLAY_COLOR_SPACE, type Renderer } from "./renderer";
import type { ScrubFrame } from "./scrub-cursor";

/**
 * WebGPU renderer behind the Renderer seam. It samples each frame across a
 * fullscreen triangle so the display canvas is GPU-composited. This is the
 * render seam WebGPU needs and the foundation for render-time zoom / crop /
 * overlay / color work.
 *
 * Two paths, picked per frame:
 *
 *   - Canvas upload (texture_2d, copyExternalImageToTexture): works wherever
 *     WebGPU is present, including Firefox. The frame's pixels are copied into a
 *     sampled texture. Used for canvas frames (CanvasSink decodes, cache blits),
 *     and for a decoded frame converted through the renderer's own 2D canvas.
 *
 *   - Zero-copy import (texture_external, importExternalTexture): the decoded
 *     VideoFrame is wrapped as an external texture and sampled directly, no copy.
 *     Used only for sample frames and only where importExternalTexture exists.
 *     The external texture and the VideoFrame it wraps are valid only for the
 *     current task, so import, draw, submit, and close happen in one tick. The
 *     renderer closes the transient VideoFrame it creates; the controller still
 *     owns and closes the VideoSample.
 *
 * A decoded frame carries its own colour space and the browser converts it on
 * whichever route the frame takes. The routes are not guaranteed to agree: a
 * platform can convert a hardware-decoded frame one way when it is imported
 * straight onto the GPU and another way when it is drawn through a canvas. The
 * cache holds canvas blits, so a disagreement reads as the picture shifting
 * between a frame painted live and the same frame served from the cache. The
 * renderer therefore renders one frame both ways and compares them before it
 * paints through the import.
 *
 * GPU execution is verified in a browser, not in CI: a worker test environment
 * has no adapter, so createRenderer falls back to the 2D renderer there.
 */
const SHADER = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: VsOut;
    let p = corners[i];
    out.pos = vec4f(p, 0.0, 1.0);
    // Map clip space to texture space, flipping Y so the frame is upright.
    out.uv = p * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
    return out;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
    return textureSample(tex, samp, in.uv);
}
`;

/** External-texture variant. textureSampleBaseClampToEdge is the only sampling
 *  builtin valid for texture_external; the vertex stage is shared in spirit but
 *  declared inline so this module is self-contained per pipeline. */
const EXTERNAL_SHADER = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: VsOut;
    let p = corners[i];
    out.pos = vec4f(p, 0.0, 1.0);
    out.uv = p * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
    return out;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
    return textureSampleBaseClampToEdge(tex, samp, in.uv);
}
`;

/** Side of the square render the two routes are compared over. They resample
 *  differently on the way down, so the comparison rides on the mean channel
 *  value, which resampling preserves; over this many samples its noise sits far
 *  below the divergence being looked for. */
const IMPORT_CHECK_SIZE = 64;

/** Mean-channel gap above which the routes are taken to disagree. Rounding and
 *  chroma siting move the mean by a fraction of a level. */
const IMPORT_CHECK_TOLERANCE = 3;

/**
 * Whether a decoded frame may be painted by importing it straight onto the GPU.
 * Unknown until one frame has been rendered both ways and the results compared.
 */
type DirectImport = "unknown" | "measuring" | "usable" | "unusable";

export class WebGpuRenderer implements Renderer {
  readonly name = "webgpu" as const;
  private texture: GPUTexture | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private textureWidth = 0;
  private textureHeight = 0;
  /** Lazily built the first time a sample frame is drawn and import is
   *  available; never built on the canvas-only path. */
  private externalPipeline: GPURenderPipeline | null = null;
  private directImport: DirectImport;
  /** The 2D surface a decoded frame is converted through, built on first use. */
  private conversion: OffscreenCanvasRenderingContext2D | null = null;

  private constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly pipeline: GPURenderPipeline,
    private readonly sampler: GPUSampler,
  ) {
    this.directImport =
      typeof device.importExternalTexture === "function"
        ? "unknown"
        : "unusable";
  }

  /** Cheap pre-check before the async create(): is the API even present? */
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && navigator.gpu != null;
  }

  /** Acquires a device and configures the canvas. Throws if WebGPU is unusable. */
  static async create(canvas: OffscreenCanvas): Promise<WebGpuRenderer> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGpuRenderer: no GPU adapter");
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGpuRenderer: no webgpu context");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: "opaque",
      colorSpace: DISPLAY_COLOR_SPACE,
    });
    const module = device.createShaderModule({ code: SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    return new WebGpuRenderer(
      canvas,
      device,
      context,
      format,
      pipeline,
      sampler,
    );
  }

  draw(frame: ScrubFrame): void {
    if (this.canvas.width === 0 || this.canvas.height === 0) return;
    if (frame.kind !== "sample") {
      // Size the upload to the SOURCE frame, not the display canvas. A preview
      // (coarse) cache frame is downscaled (e.g. 320px wide) while the canvas is
      // full decode size; copying at canvas size overruns the small source, the
      // copy fails, and WebGPU then cannot paint preview frames during a scrub
      // (the GPU error also stalls later draws, so play stops painting). The
      // fullscreen-triangle shader samples 0..1, so any texture size scales to fill.
      this.drawCanvas(frame.source, frame.width, frame.height);
      return;
    }
    if (this.directImport === "usable") {
      this.drawExternal(frame.sample.toVideoFrame());
      return;
    }
    if (this.directImport === "unknown") {
      this.directImport = "measuring";
      void this.measureDirectImport(frame.sample.toVideoFrame());
    }
    this.drawConverted(frame.sample.toVideoFrame());
  }

  dispose(): void {
    this.texture?.destroy();
    this.texture = null;
    this.bindGroup = null;
    this.conversion = null;
    this.device.destroy();
  }

  /** Zero-copy: wrap the VideoFrame as an external texture, sample it, submit,
   *  then close the transient VideoFrame. The external texture is valid only
   *  for this task, so the bind group is rebuilt every frame. */
  private drawExternal(videoFrame: VideoFrame): void {
    try {
      const pipeline = this.ensureExternalPipeline();
      const external = this.device.importExternalTexture({
        source: videoFrame,
        colorSpace: DISPLAY_COLOR_SPACE,
      });
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: external },
        ],
      });
      this.renderPass(pipeline, bindGroup);
    } finally {
      videoFrame.close();
    }
  }

  /** Draws the frame through a 2D canvas and uploads that, which is the
   *  conversion the cache blits and the 2D renderer already go through. The
   *  canvas is display-sized, so the downscale happens once here and the
   *  shader only has to stretch. */
  private drawConverted(videoFrame: VideoFrame): void {
    try {
      const width = this.canvas.width;
      const height = this.canvas.height;
      const conversion = this.conversionFor(width, height);
      if (!conversion) return;
      conversion.drawImage(videoFrame, 0, 0, width, height);
      this.drawCanvas(conversion.canvas, width, height);
    } finally {
      videoFrame.close();
    }
  }

  private conversionFor(
    width: number,
    height: number,
  ): OffscreenCanvasRenderingContext2D | null {
    if (!this.conversion) {
      this.conversion = new OffscreenCanvas(width, height).getContext("2d", {
        alpha: false,
        colorSpace: DISPLAY_COLOR_SPACE,
      });
      return this.conversion;
    }
    const canvas = this.conversion.canvas;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return this.conversion;
  }

  /**
   * Renders one frame through both routes into offscreen targets and compares
   * what came out, which decides whether later frames are painted by importing
   * them directly. Reading the result back costs a round-trip to the GPU, so it
   * happens once and the frames drawn meanwhile take the converted route.
   */
  private async measureDirectImport(videoFrame: VideoFrame): Promise<void> {
    const size = IMPORT_CHECK_SIZE;
    const bytesPerRow = size * 4;
    const region = bytesPerRow * size;
    const scratch: { destroy(): void }[] = [];
    const hold = <T extends { destroy(): void }>(resource: T): T => {
      scratch.push(resource);
      return resource;
    };
    try {
      const renderTarget = (): GPUTexture =>
        hold(
          this.device.createTexture({
            size: [size, size],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          }),
        );
      const imported = renderTarget();
      const converted = renderTarget();
      const reference = hold(
        this.device.createTexture({
          size: [size, size],
          format: "rgba8unorm",
          // RENDER_ATTACHMENT is what makes a texture a legal
          // copyExternalImageToTexture destination. Without it the copy
          // is rejected and the reference reads back black, which the
          // comparison cannot tell apart from two routes that disagree.
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
      const readback = hold(
        this.device.createBuffer({
          size: region * 2,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      );
      const source = new OffscreenCanvas(size, size);
      const context = source.getContext("2d", {
        alpha: false,
        colorSpace: DISPLAY_COLOR_SPACE,
      });
      if (!context) {
        this.directImport = "unusable";
        return;
      }
      context.drawImage(videoFrame, 0, 0, size, size);
      this.device.queue.copyExternalImageToTexture(
        { source },
        { texture: reference, colorSpace: DISPLAY_COLOR_SPACE },
        [size, size],
      );
      const externalPipeline = this.ensureExternalPipeline();
      const encoder = this.device.createCommandEncoder();
      this.encodePass(
        encoder,
        externalPipeline,
        this.device.createBindGroup({
          layout: externalPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sampler },
            {
              binding: 1,
              resource: this.device.importExternalTexture({
                source: videoFrame,
                colorSpace: DISPLAY_COLOR_SPACE,
              }),
            },
          ],
        }),
        imported.createView(),
      );
      this.encodePass(
        encoder,
        this.pipeline,
        this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: reference.createView() },
          ],
        }),
        converted.createView(),
      );
      encoder.copyTextureToBuffer(
        { texture: imported },
        { buffer: readback, bytesPerRow },
        [size, size],
      );
      encoder.copyTextureToBuffer(
        { texture: converted },
        { buffer: readback, bytesPerRow, offset: region },
        [size, size],
      );
      this.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange());
      const gap = Math.abs(
        meanChannel(pixels.subarray(0, region)) -
          meanChannel(pixels.subarray(region)),
      );
      readback.unmap();
      this.directImport = gap <= IMPORT_CHECK_TOLERANCE ? "usable" : "unusable";
    } catch {
      // Latched, not retried: a measurement that threw leaves no evidence
      // the import agrees, and the converted route is always correct.
      this.directImport = "unusable";
    } finally {
      videoFrame.close();
      for (const resource of scratch) resource.destroy();
    }
  }

  private drawCanvas(
    source: GPUCopyExternalImageSource,
    width: number,
    height: number,
  ): void {
    this.ensureTexture(width, height);
    const texture = this.texture;
    if (!texture || !this.bindGroup) return;
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture, colorSpace: DISPLAY_COLOR_SPACE },
      [width, height],
    );
    this.renderPass(this.pipeline, this.bindGroup);
  }

  private renderPass(
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
  ): void {
    const encoder = this.device.createCommandEncoder();
    this.encodePass(
      encoder,
      pipeline,
      bindGroup,
      this.context.getCurrentTexture().createView(),
    );
    this.device.queue.submit([encoder.finish()]);
  }

  private encodePass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    view: GPUTextureView,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private ensureExternalPipeline(): GPURenderPipeline {
    if (this.externalPipeline) return this.externalPipeline;
    const module = this.device.createShaderModule({ code: EXTERNAL_SHADER });
    this.externalPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });
    return this.externalPipeline;
  }

  /** (Re)allocates the sampled texture and bind group when the size changes. */
  private ensureTexture(width: number, height: number): void {
    if (
      this.texture &&
      this.textureWidth === width &&
      this.textureHeight === height
    )
      return;
    this.texture?.destroy();
    this.texture = this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.textureWidth = width;
    this.textureHeight = height;
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.texture.createView() },
      ],
    });
  }
}

/** Assumes the readback has no row padding, which holds while IMPORT_CHECK_SIZE
 *  keeps bytesPerRow on WebGPU's 256-byte alignment. */
function meanChannel(pixels: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
  }
  return sum / ((pixels.length / 4) * 3);
}
