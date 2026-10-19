const DEFAULT_MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * Base display density for the presentation surface and video decode.
 * Annotation antialiasing can prepare mask rasters at a higher density.
 * Invalid ceilings use the default maximum.
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
