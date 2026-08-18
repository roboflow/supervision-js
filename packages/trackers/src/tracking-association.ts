import type { Rect } from "./types";
import { maximizeAssignment } from "./sort-tracker";

export interface TrackingMatch {
  readonly detectionIndex: number;
  readonly trackIndex: number;
}

export function associateTrackingScores(
  scores: readonly (readonly number[])[],
  trackCount: number,
  detectionCount: number,
  minimumScore: number,
  acceptanceScores: readonly (readonly number[])[] = scores,
) {
  const matches: TrackingMatch[] = [];
  const matchedTracks = new Set<number>();
  const matchedDetections = new Set<number>();

  for (const [trackIndex, detectionIndex] of maximizeAssignment(scores)) {
    if (acceptanceScores[trackIndex]![detectionIndex]! < minimumScore) continue;
    matches.push({ detectionIndex, trackIndex });
    matchedTracks.add(trackIndex);
    matchedDetections.add(detectionIndex);
  }
  matches.sort((left, right) => left.trackIndex - right.trackIndex);

  return {
    matches,
    unmatchedDetectionIndexes: Array.from(
      { length: detectionCount },
      (_, index) => index,
    ).filter((index) => !matchedDetections.has(index)),
    unmatchedTrackIndexes: Array.from(
      { length: trackCount },
      (_, index) => index,
    ).filter((index) => !matchedTracks.has(index)),
  };
}

export function pairwiseIou(
  tracks: readonly Rect[],
  detections: readonly Rect[],
  bufferRatio = 0,
) {
  return tracks.map((track) =>
    detections.map((detection) =>
      bufferedIntersectionOverUnion(track, detection, bufferRatio),
    ),
  );
}

export function bufferedIntersectionOverUnion(
  left: Rect,
  right: Rect,
  bufferRatio: number,
) {
  const leftWidth = left.width * (1 + 2 * bufferRatio);
  const leftHeight = left.height * (1 + 2 * bufferRatio);
  const rightWidth = right.width * (1 + 2 * bufferRatio);
  const rightHeight = right.height * (1 + 2 * bufferRatio);
  const leftX = left.x - leftWidth / 2;
  const leftY = left.y - leftHeight / 2;
  const rightX = right.x - rightWidth / 2;
  const rightY = right.y - rightHeight / 2;
  const intersectionWidth = Math.max(
    0,
    Math.min(leftX + leftWidth, rightX + rightWidth) - Math.max(leftX, rightX),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftY + leftHeight, rightY + rightHeight) -
      Math.max(leftY, rightY),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const union =
    leftWidth * leftHeight + rightWidth * rightHeight - intersection;
  return union <= 0 ? 0 : intersection / union;
}
