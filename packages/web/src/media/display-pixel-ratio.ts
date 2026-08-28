const DEFAULT_MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * The pixel ratio a host's display box rasterizes at, for every grid that lands
 * in that box: the presentation surface, the mask rasters drawn onto it, and the
 * decode under both. The ceiling is what keeps a 3x display from costing nine
 * times the texels of a 1x one for sharpness nobody resolves on a moving
 * picture, and left unstated it is the one the video engine's
 * displayBoxResolution applies, so the three land on the same grid. An id raster
 * carries a detection per pixel and can only be sampled nearest, so a grid it
 * does not share ragged its edges.
 *
 * A ceiling that is not a usable number states nothing, and takes the default.
 */
export function resolveDisplayPixelRatio(display: {
  readonly devicePixelRatio: number;
  readonly maxDevicePixelRatio?: number;
}): number {
  const { devicePixelRatio, maxDevicePixelRatio } = display;

  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    return 1;
  }

  const ceiling =
    maxDevicePixelRatio !== undefined &&
    Number.isFinite(maxDevicePixelRatio) &&
    maxDevicePixelRatio > 0
      ? maxDevicePixelRatio
      : DEFAULT_MAX_DEVICE_PIXEL_RATIO;

  return Math.min(devicePixelRatio, ceiling);
}
