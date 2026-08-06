/**
 * Defaults shared by React Native media sessions. Hosts can override the
 * file-session presentation guards, while the live values are intentionally
 * exported so adapters and demos do not duplicate platform policy.
 */
export const REACT_NATIVE_FILE_SESSION_DEFAULTS = {
  // Memory guards for high-resolution uploads (phones record 4K): above
  // these bounds masks fall back to model resolution and the presented CPU
  // raster is GPU-downscaled before an app is terminated for memory pressure.
  fullResMaskMaxPixels: 1920 * 1088,
  maxPresentationSide: 1600,
  statsIntervalMs: 250,
} as const;

export const REACT_NATIVE_LIVE_SESSION_DEFAULTS = {
  maxInstances: 6,
  targetResolution: { height: 1280, width: 720 },
} as const;
