export type DemoRenderQuality = number | undefined;

export const defaultDemoRenderQuality = 1.5;

/**
 * An unstated ceiling is capped at 2x by every grid the library sizes, so "no
 * cap" is the viewer's own ratio said out loud.
 */
export function getDemoMaxDevicePixelRatio(quality: DemoRenderQuality) {
  return quality ?? globalThis.devicePixelRatio ?? 1;
}

export function getDemoRenderQualityDescription(quality: DemoRenderQuality) {
  if (quality === undefined) {
    return "No DPR cap";
  }

  return `Max DPR ${formatDemoRenderQualityValue(quality)}`;
}

export function formatDemoRenderQualityValue(quality: DemoRenderQuality) {
  return quality === undefined ? "No limit" : quality.toFixed(2);
}
