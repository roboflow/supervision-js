const DEFAULT_MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * The pixel ratio a host's display box rasterizes at. The ceiling is what keeps
 * a 3x display from costing nine times the texels of a 1x one for sharpness
 * nobody resolves on a moving picture, and left unstated it is the one the
 * video engine's displayBoxResolution applies, so a raster and the decode under
 * it land on the same pixel grid.
 */
export function resolveDisplayPixelRatio(display: {
  readonly devicePixelRatio: number;
  readonly maxDevicePixelRatio?: number;
}): number {
  if (
    !Number.isFinite(display.devicePixelRatio) ||
    display.devicePixelRatio <= 0
  ) {
    return 1;
  }

  return Math.min(
    display.devicePixelRatio,
    display.maxDevicePixelRatio ?? DEFAULT_MAX_DEVICE_PIXEL_RATIO,
  );
}
