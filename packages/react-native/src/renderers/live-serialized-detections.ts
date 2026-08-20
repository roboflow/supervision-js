import {
  DetectionMaskEncoding,
  resolveDetectionClassColorStyle,
  type Detection,
  type DetectionFrame,
} from "supervision-js-core";

import type { ReactNativeLiveSerializedDetection } from "../index";

const EMPTY_MASK = new Uint8Array(0);

/**
 * Bridges a producer's `DetectionFrame` into the package's flat live
 * detection shape.
 *
 * The live ID-mask fill loops and the instant-CV rule evaluation still read
 * the flat shape. Converting here lets the live hook accept a
 * `ReactNativeLiveDetectionProducer` without rewriting the hot path in the
 * same change, which matters because that path is what currently runs on
 * device.
 *
 * The conversion is deliberately shallow: it repackages fields and never
 * touches mask bytes. Mask buffers cross by reference, so the per-frame cost
 * is a handful of small objects rather than anything proportional to
 * resolution.
 *
 * Color is resolved here rather than carried by the producer. Core detections
 * hold no styling, so `className` is the input and presentation owns the
 * mapping.
 */
export function serializeReactNativeLiveDetectionFrame(
  detectionFrame: DetectionFrame,
): ReactNativeLiveSerializedDetection[] {
  "worklet";

  const serialized: ReactNativeLiveSerializedDetection[] = [];

  for (let index = 0; index < detectionFrame.detections.length; index += 1) {
    const detection = detectionFrame.detections[index]!;
    const converted = serializeReactNativeLiveDetection(detection);

    if (converted) {
      serialized[serialized.length] = converted;
    }
  }

  return serialized;
}

/**
 * Converts one detection, or returns null when it carries no rectangle.
 *
 * The flat shape is bbox-centric: every consumer indexes the mask through the
 * detection's box, so a detection without one has nothing to draw here. Pose
 * detections keep their own vector lane instead.
 */
export function serializeReactNativeLiveDetection(
  detection: Detection,
): ReactNativeLiveSerializedDetection | null {
  "worklet";

  const rect = detection.rect;

  if (!rect) {
    return null;
  }

  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const label = detection.className ?? "";
  const mask = detection.mask;
  // Only dense masks reach the live lane. An RLE mask is cold storage and
  // would need decoding, which is exactly the per-frame cost the dense
  // encoding exists to avoid, so it is treated as no mask rather than
  // silently paid for.
  const dense =
    mask && mask.encoding === DetectionMaskEncoding.DenseBitmap ? mask : null;
  // The flat shape reports the stored buffer's dimensions; `rotatedCw` tells
  // the fill loops to sample it transposed. A rotated buffer is `height` wide
  // and `width` tall, so the reported dims swap back here.
  const rotatedCw = dense?.rotatedCw === true;

  return {
    bbox: {
      x1: rect.x - halfWidth,
      x2: rect.x + halfWidth,
      y1: rect.y - halfHeight,
      y2: rect.y + halfHeight,
    },
    color: resolveDetectionClassColorStyle(label).fill,
    label,
    mask: dense ? dense.data : EMPTY_MASK,
    maskHeight: dense ? (rotatedCw ? dense.width : dense.height) : 0,
    maskRotatedCw: rotatedCw,
    maskWidth: dense ? (rotatedCw ? dense.height : dense.width) : 0,
    score: detection.confidence,
  };
}
