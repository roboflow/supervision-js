export type DemoRenderQuality = number | undefined;

export const defaultDemoRenderQuality = 1.5;

export function getDemoMaxDevicePixelRatio(quality: DemoRenderQuality) {
  return quality;
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
