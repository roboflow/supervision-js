/**
 * Default live ID-mask artifact bounds, centralized web-style (see
 * `media-session-defaults.ts` in the web package). 720x1280 keeps the
 * Alpha_8 artifact under ~1MB while matching portrait phone frames; both
 * bounds can be overridden per call.
 */
export const REACT_NATIVE_LIVE_ID_MASK_DEFAULTS = {
  maxPixels: 720 * 1280,
  maxSide: 1280,
} as const;
