import type { DetectionFrame, Rect } from "#types/detections";
import {
  DetectionPickTarget,
  type DetectionPickOptions,
  type DetectionPickPoint,
  type DetectionPickResult,
} from "#types/interaction";

interface CandidatePick {
  readonly area: number;
  readonly result: DetectionPickResult;
}

export function pickDetectionAtPoint(
  frame: DetectionFrame | undefined,
  point: DetectionPickPoint,
  options: DetectionPickOptions = {},
): DetectionPickResult | null {
  if (!frame) {
    return null;
  }

  const padding = Math.max(0, options.padding ?? 0);
  const candidates: CandidatePick[] = [];

  for (
    let detectionIndex = 0;
    detectionIndex < frame.detections.length;
    detectionIndex += 1
  ) {
    const detection = frame.detections[detectionIndex];

    if (!detection?.rect) {
      continue;
    }

    const paddedRect = padRect(detection.rect, padding);

    if (!containsPoint(paddedRect, point)) {
      continue;
    }

    candidates.push({
      area: detection.rect.width * detection.rect.height,
      result: {
        detection,
        detectionIndex,
        frame,
        mediaTime: frame.mediaTime,
        point,
        target: DetectionPickTarget.Box,
      },
    });
  }

  candidates.sort((left, right) => {
    const areaDifference = left.area - right.area;

    return areaDifference === 0
      ? right.result.detectionIndex - left.result.detectionIndex
      : areaDifference;
  });

  return candidates[0]?.result ?? null;
}

export function createDetectionPickKey(pick: DetectionPickResult | null) {
  if (!pick) {
    return null;
  }

  const detectionId =
    pick.detection.id === undefined ? "anonymous" : String(pick.detection.id);

  return [
    pick.frame.frameIndex ?? "time",
    pick.frame.mediaTime,
    detectionId,
    pick.detectionIndex,
    pick.target,
  ].join(":");
}

export function rebaseDetectionPickToFrame(
  pick: DetectionPickResult | null,
  frame: DetectionFrame | undefined,
): DetectionPickResult | null {
  if (!pick || !frame) {
    return null;
  }

  const detection = frame.detections[pick.detectionIndex];

  if (!detection) {
    return null;
  }

  const rebasedPick = {
    detection,
    detectionIndex: pick.detectionIndex,
    frame,
    mediaTime: frame.mediaTime,
    point: pick.point,
    target: pick.target,
  };

  return createDetectionPickKey(rebasedPick) === createDetectionPickKey(pick)
    ? rebasedPick
    : null;
}

export function pickDetectionByMaskId(
  frame: DetectionFrame | undefined,
  maskId: number,
  point: DetectionPickPoint,
): DetectionPickResult | null {
  if (!frame || maskId <= 0 || !Number.isInteger(maskId)) {
    return null;
  }

  const detectionIndex = maskId - 1;
  const detection = frame.detections[detectionIndex];

  if (!detection) {
    return null;
  }

  return {
    detection,
    detectionIndex,
    frame,
    mediaTime: frame.mediaTime,
    point,
    target: DetectionPickTarget.Mask,
  };
}

function padRect(rect: Rect, padding: number): Rect {
  if (padding === 0) {
    return rect;
  }

  return {
    height: rect.height + padding * 2,
    width: rect.width + padding * 2,
    x: rect.x - padding,
    y: rect.y - padding,
  };
}

function containsPoint(rect: Rect, point: DetectionPickPoint) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
