import type { MaskStyle } from "#types/mask-style";

export function canReuseMaskStyleArtifacts(
  previousMaskStyle: MaskStyle | null,
  nextMaskStyle: MaskStyle | null,
) {
  if (previousMaskStyle === nextMaskStyle) {
    return true;
  }

  return (
    previousMaskStyle?.artifactKey !== undefined &&
    nextMaskStyle?.artifactKey !== undefined &&
    previousMaskStyle.artifactKey === nextMaskStyle.artifactKey
  );
}

export function resolveMaskStyleOpacity(
  maskStyle: MaskStyle | null | undefined,
) {
  const opacity = maskStyle?.opacity;

  if (opacity === undefined) {
    return 1;
  }

  return Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 1;
}
