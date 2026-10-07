export interface TextureSize {
  readonly height: number;
  readonly width: number;
}

/**
 * The size media must be staged at so neither side exceeds `maxTextureSize`.
 *
 * GPUs refuse a texture with a side over their limit (16,384 on most desktops,
 * 4,096 to 8,192 on some mobile and integrated parts), and WebGL then draws the
 * media black. Staging it smaller keeps it visible; the media sprite stays at
 * media size, so geometry, picking and edits keep media-pixel coordinates.
 */
export function fitTextureSize(
  width: number,
  height: number,
  maxTextureSize: number,
): TextureSize {
  const longestSide = Math.max(width, height);

  if (!(maxTextureSize > 0) || longestSide <= maxTextureSize) {
    return { height, width };
  }

  const scale = maxTextureSize / longestSide;
  const fit = (side: number) =>
    Math.min(maxTextureSize, Math.max(1, Math.round(side * scale)));

  return { height: fit(height), width: fit(width) };
}

export interface TextureLimitRenderer {
  readonly gl?: {
    readonly MAX_TEXTURE_SIZE: number;
    getParameter(name: number): unknown;
  };
  readonly gpu?: {
    readonly device?: {
      readonly limits?: Pick<GPUSupportedLimits, "maxTextureDimension2D">;
    };
  };
}

/**
 * The largest texture side the renderer uploads, lowered by the caller's
 * `maxTextureSize` when that is smaller. `Infinity` when neither is known.
 */
export function resolveMaxTextureSize(
  renderer: TextureLimitRenderer,
  requested: number | undefined,
): number {
  const deviceLimit =
    Number(renderer.gl?.getParameter(renderer.gl.MAX_TEXTURE_SIZE)) ||
    renderer.gpu?.device?.limits?.maxTextureDimension2D ||
    Infinity;

  return requested !== undefined && requested > 0
    ? Math.min(deviceLimit, requested)
    : deviceLimit;
}
