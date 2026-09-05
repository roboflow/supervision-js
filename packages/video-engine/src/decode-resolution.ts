/**
 * Decode-resolution strategies. A strategy decides the pixel width each video
 * frame is decoded to, independent of the source's native resolution. Height
 * follows from native aspect, so a strategy only ever returns a width.
 *
 * Decoding below native trades preview sharpness for paint cost and frame-cache
 * memory. It does NOT cut decode cost: the codec decodes the full coded frame
 * regardless of target width, and CanvasSink resizes the result afterward. The
 * win scales with the gap between source resolution and the on-screen box: a 4K
 * source shown in a 640px surface still pays full 4K decode, but the smaller
 * surface cuts the per-frame paint work and the cached blit size.
 *
 * A strategy applies wherever frames decode through this seam: the live scrub
 * surface and the analysis / extraction path alike. AnalysisSession decodes at
 * whatever strategy it is given (native when omitted), so a thumbnail pass can
 * cache a small blit instead of a native-size one.
 */

/**
 * Inputs a strategy reasons over. Native dimensions are the decoded track's
 * real resolution. Display dimensions describe the on-screen canvas box at
 * decode time; displayWidth is null when the surface has not been laid out
 * yet (a strategy that needs it should fall back to native).
 */
export interface DecodeResolutionContext {
  readonly nativeWidth: number;
  readonly nativeHeight: number;
  /** CSS-pixel width of the canvas box, or null when unmeasured. */
  readonly displayWidth: number | null;
  /** devicePixelRatio at decode time. */
  readonly devicePixelRatio: number;
}

/**
 * Resolved decode dimensions. Always a valid, native-bounded integer pair with
 * native aspect preserved.
 */
export interface DecodeDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * A decode-resolution choice as serializable data. Held as a descriptor rather
 * than a closure so the choice can cross the worker boundary in a load command;
 * resolveDecodeDimensions runs the width math worker-side once native dimensions
 * are known. The resolver clamps any result above native so no strategy can
 * upscale during decode.
 */
export type DecodeResolutionStrategy =
  | { readonly kind: "native" }
  | { readonly kind: "viewport"; readonly maxDevicePixelRatio: number }
  | { readonly kind: "capped"; readonly maxWidth: number }
  | {
      readonly kind: "displayBox";
      readonly boxWidth: number;
      readonly boxHeight: number;
      readonly devicePixelRatio: number;
      readonly maxDevicePixelRatio: number;
    };

/** Decode at native resolution. The conservative default. */
export function nativeResolution(): DecodeResolutionStrategy {
  return { kind: "native" };
}

export interface ViewportResolutionOptions {
  /**
   * Ceiling on devicePixelRatio so a 3x display does not triple decode cost
   * for sharpness past what the eye resolves on a moving preview. Default 2.
   */
  maxDevicePixelRatio?: number;
}

/**
 * Decode at the on-screen size: canvas CSS width times devicePixelRatio. Best
 * for fixed-size surfaces fed by a much larger source (frame sampler, inline
 * players). Falls back to native while the box is unmeasured.
 *
 * The box it reads is the one bindCanvas measures, so this strategy resolves to
 * native under presentation "frames", where the engine holds no canvas and
 * nothing ever measures one. A frames-mode consumer passes displayBoxResolution
 * instead.
 */
export function viewportResolution(
  options: ViewportResolutionOptions = {},
): DecodeResolutionStrategy {
  return {
    kind: "viewport",
    maxDevicePixelRatio: options.maxDevicePixelRatio ?? 2,
  };
}

/**
 * Decode at no more than maxWidth regardless of display size. For consumers
 * with a hard throughput or memory ceiling (batch surfaces, thumbnail farms).
 */
export function cappedResolution(maxWidth: number): DecodeResolutionStrategy {
  return { kind: "capped", maxWidth };
}

export interface DisplayBoxResolutionOptions {
  /** CSS-pixel width of the box the consumer paints frames into. */
  boxWidth: number;
  /** CSS-pixel height of that box. */
  boxHeight: number;
  /** The consumer's own devicePixelRatio; the engine has none to read. */
  devicePixelRatio: number;
  /** Ceiling on that ratio. Default 2, matching viewportResolution. */
  maxDevicePixelRatio?: number;
}

/**
 * Decode at the size the frame will actually occupy inside a box the consumer
 * describes: native aspect fitted into boxWidth x boxHeight, times the clamped
 * device pixel ratio. Letterboxing is why the box is two numbers and not one,
 * since a portrait source in a landscape box paints far narrower than the box.
 *
 * This is the strategy for presentation "frames". There the consumer owns the
 * compositor, so it is the only side that knows the box, and viewportResolution
 * has nothing to read.
 */
export function displayBoxResolution(
  options: DisplayBoxResolutionOptions,
): DecodeResolutionStrategy {
  return {
    kind: "displayBox",
    boxWidth: options.boxWidth,
    boxHeight: options.boxHeight,
    devicePixelRatio: options.devicePixelRatio,
    maxDevicePixelRatio: options.maxDevicePixelRatio ?? 2,
  };
}

/** Runs the descriptor against a context to produce a target decode width. */
function strategyWidth(
  strategy: DecodeResolutionStrategy,
  ctx: DecodeResolutionContext,
): number {
  switch (strategy.kind) {
    case "native":
      return ctx.nativeWidth;
    case "viewport": {
      if (ctx.displayWidth === null || ctx.displayWidth <= 0)
        return ctx.nativeWidth;
      const dpr = clampDpr(ctx.devicePixelRatio, strategy.maxDevicePixelRatio);
      return Math.ceil(ctx.displayWidth * dpr);
    }
    case "capped":
      return Math.min(strategy.maxWidth, ctx.nativeWidth);
    case "displayBox": {
      const { boxWidth, boxHeight } = strategy;
      if (!(boxWidth > 0) || !(boxHeight > 0)) return ctx.nativeWidth;
      const fit = Math.min(
        boxWidth / ctx.nativeWidth,
        boxHeight / ctx.nativeHeight,
      );
      const dpr = clampDpr(
        strategy.devicePixelRatio,
        strategy.maxDevicePixelRatio,
      );
      return Math.ceil(ctx.nativeWidth * fit * dpr);
    }
  }
}

/**
 * Runs a strategy and returns native-bounded, aspect-preserving integer
 * dimensions safe to hand to CanvasSink and to size a canvas backing store.
 * A strategy that returns garbage (non-finite, non-positive) falls back to
 * native rather than producing a broken surface.
 */
export function resolveDecodeDimensions(
  strategy: DecodeResolutionStrategy,
  ctx: DecodeResolutionContext,
): DecodeDimensions {
  const nativeWidth = Math.max(1, Math.round(ctx.nativeWidth));
  const nativeHeight = Math.max(1, Math.round(ctx.nativeHeight));
  const raw = strategyWidth(strategy, ctx);
  const width =
    Number.isFinite(raw) && raw > 0
      ? Math.min(Math.round(raw), nativeWidth)
      : nativeWidth;
  const height = Math.max(1, Math.round((width * nativeHeight) / nativeWidth));
  return { width, height };
}

function clampDpr(dpr: number, maxDpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, maxDpr);
}
