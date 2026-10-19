import {
  DetectionPickTarget,
  type DetectionFrame,
  type DetectionPickOptions,
  type DetectionPickPoint,
  type DetectionPickResult,
} from "supervision-js-core";
import {
  readPackedMaskCoverage,
  type PreparedPackedMaskCoverage,
} from "#render-preparation/packed-mask-coverage";

/** Picks independent prepared coverage without decoding RLE on pointer movement. */
export function pickPackedMaskAtPoint(
  frame: DetectionFrame,
  entries: readonly PreparedPackedMaskCoverage[],
  point: DetectionPickPoint,
  media: { readonly width: number; readonly height: number },
  options: DetectionPickOptions = {},
): DetectionPickResult | null {
  if (media.width <= 0 || media.height <= 0) return null;
  let result: DetectionPickResult | null = null;
  for (const entry of entries) {
    const detectionIndex = entry.detectionIndex;
    const detection = frame.detections[detectionIndex];
    if (
      !detection ||
      (detection.locked && options.includeLocked === false) ||
      options.filter?.(detection, detectionIndex) === false
    )
      continue;
    if (
      !readPackedMaskCoverage(
        entry,
        (point.x * entry.sourceWidth) / media.width,
        (point.y * entry.sourceHeight) / media.height,
      )
    )
      continue;
    const order = detection.zIndex ?? detectionIndex;
    const previousOrder = result?.detection.zIndex ?? result?.detectionIndex;
    if (
      result &&
      previousOrder !== undefined &&
      (previousOrder > order ||
        (previousOrder === order && result.detectionIndex > detectionIndex))
    )
      continue;
    result = {
      detection,
      detectionIndex,
      frame,
      mediaTime: frame.mediaTime,
      point,
      target: DetectionPickTarget.Mask,
    };
  }
  return result;
}
