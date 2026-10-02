import { Application, type RenderTexture } from "pixi.js";

export const BackendName = { WebGl: "webgl", WebGpu: "webgpu" } as const;
export type BackendName = (typeof BackendName)[keyof typeof BackendName];

export interface BackendDescription {
  readonly requested: BackendName;
  /** What Pixi actually created; Pixi falls back to WebGL without WebGPU. */
  readonly rendererName: string;
  readonly maxTextureSize: number;
  readonly gpu: string;
}

/**
 * One Pixi application on one backend, with the two things the benchmark
 * needs that Pixi does not offer as such: waiting for the GPU to finish, and
 * an exact readback of a render texture.
 */
export interface BenchBackend {
  readonly app: Application;
  readonly description: BackendDescription;
  /**
   * Resolves once the GPU has finished everything submitted so far. Given the
   * render texture just drawn, WebGL also reads one pixel of it back, which
   * no driver can answer before the draw is done.
   */
  finish(target?: RenderTexture): Promise<void>;
  /** RGBA bytes of a render texture, top row first. */
  readPixels(target: RenderTexture): Promise<Uint8Array>;
  destroy(): void;
}

interface WebGlLike {
  readonly gl: WebGL2RenderingContext;
}

interface WebGpuLike {
  readonly gpu: { readonly adapter: GPUAdapter; readonly device: GPUDevice };
  readonly texture: { getGpuSource(source: unknown): GPUTexture };
}

export async function createBenchBackend(
  requested: BackendName,
): Promise<BenchBackend> {
  const app = new Application();

  await app.init({
    antialias: false,
    autoStart: false,
    backgroundAlpha: 0,
    height: 64,
    preference: requested,
    resolution: 1,
    width: 64,
  });
  app.stop();

  const renderer = app.renderer as unknown as Partial<WebGlLike & WebGpuLike>;
  const rendererName = String(app.renderer.name);

  if (rendererName === "webgpu" && renderer.gpu && renderer.texture) {
    const { adapter, device } = renderer.gpu;
    const texture = renderer.texture;
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;

    return {
      app,
      description: {
        gpu: info
          ? [info.vendor, info.architecture, info.description]
              .filter(Boolean)
              .join(" ")
          : "unknown",
        maxTextureSize: device.limits.maxTextureDimension2D,
        rendererName,
        requested,
      },
      destroy: () => app.destroy({ removeView: true }, true),
      finish: () => device.queue.onSubmittedWorkDone(),
      readPixels: (target) =>
        readWebGpuTexture(device, texture.getGpuSource(target.source), target),
    };
  }

  const gl = renderer.gl;

  if (!gl) throw new Error(`Pixi created neither WebGL nor WebGPU.`);

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");

  return {
    app,
    description: {
      gpu: String(
        debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      ),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      rendererName,
      requested,
    },
    destroy: () => app.destroy({ removeView: true }, true),
    finish: async (target) => {
      gl.finish();
      if (target) readOnePixel(app, gl, target);
    },
    readPixels: async (target) => {
      // WebGL reads the framebuffer as it is: no canvas, no colour management.
      const { pixels } = app.renderer.extract.pixels(target);

      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length);
    },
  };
}

/**
 * Pixi's own WebGPU extract draws the texture onto a canvas and reads that
 * back through a 2D context, which may premultiply or colour-convert. The
 * probe needs the bytes the shader wrote, so it copies the texture into a
 * buffer instead.
 */
async function readWebGpuTexture(
  device: GPUDevice,
  texture: GPUTexture,
  target: RenderTexture,
): Promise<Uint8Array> {
  const width = target.source.pixelWidth;
  const height = target.source.pixelHeight;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();

  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow },
    { height, width },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);

  const mapped = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 4);
  const swapRedBlue = texture.format.startsWith("bgra");

  for (let y = 0; y < height; y += 1) {
    out.set(
      mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
      y * width * 4,
    );
  }
  buffer.unmap();
  buffer.destroy();

  if (swapRedBlue) {
    for (let i = 0; i < out.length; i += 4) {
      const red = out[i];

      out[i] = out[i + 2];
      out[i + 2] = red;
    }
  }

  return out;
}

const onePixel = new Uint8Array(4);

/** Pixi's own WebGL readback, bound the way it binds it, for one pixel. */
function readOnePixel(
  app: Application,
  gl: WebGL2RenderingContext,
  target: RenderTexture,
) {
  const renderTargets = (
    app.renderer as unknown as {
      renderTarget: {
        getRenderTarget(texture: RenderTexture): unknown;
        getGpuRenderTarget(renderTarget: unknown): {
          resolveTargetFramebuffer: unknown;
        };
        adaptor: { bindFramebuffer(framebuffer: unknown): void };
      };
    }
  ).renderTarget;
  const glTarget = renderTargets.getGpuRenderTarget(
    renderTargets.getRenderTarget(target),
  );

  renderTargets.adaptor.bindFramebuffer(glTarget.resolveTargetFramebuffer);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePixel);
}
