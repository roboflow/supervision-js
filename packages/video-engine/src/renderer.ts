import type { RendererName } from "./diagnostics";
import type { ScrubFrame } from "./scrub-cursor";
import { WebGpuRenderer } from "./webgpu-renderer";

/**
 * The colour space every render surface declares. A decoded frame carries its
 * own and the browser converts it into whatever the destination names, but only
 * on the canvas routes: the zero-copy import converts to sRGB whatever colour
 * space it is asked for. A wider value here would therefore reach some routes
 * and not others, on the same frame.
 */
export const DISPLAY_COLOR_SPACE: PredefinedColorSpace = "srgb";

/**
 * The render seam: turns a decoded frame into pixels on the display canvas. The
 * render loop owns timing and frame selection; a Renderer owns only how a frame
 * reaches the screen, so the 2D and WebGPU paths are interchangeable behind it
 * without the loop knowing which is in play.
 */
export interface Renderer {
  /** Which backend this is, for diagnostics. */
  readonly name: RendererName;
  /**
   * Paint one frame to fill the canvas, replacing whatever it last showed.
   * A canvas frame carries a CanvasImageSource (a CanvasSink decode or a cache
   * blit); a sample frame carries a live VideoSample the WebGPU path can import
   * zero-copy. The controller owns the sample's lifetime and close, so a
   * renderer never closes the frame it is handed.
   */
  draw(frame: ScrubFrame): void;
  dispose(): void;
}

/**
 * 2D-canvas renderer: one blit of an already-decoded frame through a 2D context.
 * It is the graceful-degradation fallback wherever WebGPU is unavailable and the
 * path prefer2d pins. Per the Renderer contract the loop owns cadence, so a draw
 * happens only when a new frame is decoded. This is not a re-decode and not a
 * per-tick repaint; it differs from the WebGPU path only in compositing a frame
 * through a 2D context rather than on the GPU. Canvas dimensions are read live,
 * so a resize between draws is picked up on the next frame.
 */
export class CanvasRenderer implements Renderer {
  readonly name = "2d" as const;
  private readonly ctx: OffscreenCanvasRenderingContext2D | null;

  constructor(private readonly canvas: OffscreenCanvas) {
    // Video is opaque, so alpha:false skips per-pixel blend.
    this.ctx = canvas.getContext("2d", {
      alpha: false,
      colorSpace: DISPLAY_COLOR_SPACE,
    });
  }

  draw(frame: ScrubFrame): void {
    if (!this.ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
    // A sample draws (and scales) itself through the same 2D context; a
    // canvas frame goes through drawImage. Identical pixels either way.
    if (frame.kind === "sample") {
      frame.sample.draw(this.ctx, 0, 0, w, h);
    } else {
      this.ctx.drawImage(frame.source, 0, 0, w, h);
    }
  }

  dispose(): void {}
}

/**
 * The presentation seam: what one paint does with a frame's pixels. The render
 * loop decides which frame is presented and when, and keeps the same books
 * either way; a sink decides only where the pixels go, so the engine's own
 * display canvas and a host compositor are interchangeable behind it.
 *
 * present returns a frame when the pixels left the worker instead of reaching a
 * canvas. That frame has exactly one owner from then on: the sink keeps no
 * reference and never closes it.
 */
export interface FrameSink {
  /** The render backend behind this sink, for diagnostics; null when the sink
   *  renders nothing. */
  readonly name: RendererName | null;
  present(frame: ScrubFrame): VideoFrame | null;
  dispose(): void;
}

/** Pixels to the engine's display canvas, through the resolved Renderer. */
export class RendererFrameSink implements FrameSink {
  constructor(private readonly renderer: Renderer) {}

  get name(): RendererName {
    return this.renderer.name;
  }

  present(frame: ScrubFrame): null {
    this.renderer.draw(frame);
    return null;
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

/**
 * Pixels out of the worker as a VideoFrame, for a host that owns the canvas.
 * A sample hands over its own frame, so a live decode reaches the host without
 * a detour through a canvas. A cache blit has only canvas pixels to give, and
 * the wrap has to be told the media time, which canvas pixels do not carry.
 */
export class TransferFrameSink implements FrameSink {
  readonly name = null;

  present(frame: ScrubFrame): VideoFrame {
    if (frame.kind === "sample") return frame.sample.toVideoFrame();
    return new VideoFrame(frame.source, {
      timestamp: Math.round(frame.timestampS * 1e6),
    });
  }

  dispose(): void {}
}

export interface RendererOptions {
  /** Pin the 2D renderer. Unset, WebGPU is preferred and used when available,
   *  falling back to 2D otherwise, so it is not a guarantee of WebGPU. */
  prefer2d?: boolean;
}

/**
 * Chooses the render backend for a canvas. WebGPU is the default and probed at
 * runtime; an explicit prefer2d, or any failure to acquire a device, yields the
 * 2D renderer instead, so a caller always gets a working renderer.
 */
export async function createRenderer(
  canvas: OffscreenCanvas,
  options: RendererOptions = {},
): Promise<Renderer> {
  if (!options.prefer2d && WebGpuRenderer.isSupported()) {
    try {
      return await WebGpuRenderer.create(canvas);
    } catch {
      // Device acquisition or context config failed; fall back to 2D.
    }
  }
  return new CanvasRenderer(canvas);
}
