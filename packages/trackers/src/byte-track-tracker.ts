import type {
  ByteTrackTracker,
  ByteTrackTrackerUpdate,
  ByteTrackTrackingOptions,
  TrackingProjection,
} from "./types";
import {
  KalmanBoxTrack,
  intersectionOverUnion,
  maximizeAssignment,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeUnitInterval,
  resolveFrameStep,
} from "./sort-tracker";

interface Match {
  readonly detectionIndex: number;
  readonly trackIndex: number;
}

/**
 * Creates one stateful ByteTrack tracker for a single ordered media sequence.
 *
 * Defaults and two-stage association mirror roboflow/trackers ByteTrack at
 * source commit 60b21c8a48676784085fbee455559f16b75a7c9a.
 * Motion predictions remain internal; only observed detections receive IDs.
 */
export function createByteTrackTracker(
  options: ByteTrackTrackingOptions = {},
): ByteTrackTracker {
  const lostTrackBuffer = normalizeNonNegativeInteger(
    options.lostTrackBuffer ?? 30,
    "lostTrackBuffer",
  );
  const frameRate = options.frameRate ?? 30;
  const trackActivationThreshold = options.trackActivationThreshold ?? 0.7;
  const minimumConsecutiveFrames = normalizePositiveInteger(
    options.minimumConsecutiveFrames ?? 2,
    "minimumConsecutiveFrames",
  );
  const minimumIouThreshold = options.minimumIouThreshold ?? 0.1;
  const highConfidenceDetectionThreshold =
    options.highConfidenceDetectionThreshold ?? 0.6;

  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error("frameRate must be a finite positive value.");
  }
  normalizeUnitInterval(trackActivationThreshold, "trackActivationThreshold");
  normalizeUnitInterval(minimumIouThreshold, "minimumIouThreshold");
  normalizeUnitInterval(
    highConfidenceDetectionThreshold,
    "highConfidenceDetectionThreshold",
  );

  const scaledLostTrackBuffer = (frameRate / 30) * lostTrackBuffer;
  if (!Number.isFinite(scaledLostTrackBuffer)) {
    throw new Error(
      "Scaled lostTrackBuffer overflows: frameRate / 30 * lostTrackBuffer must be finite.",
    );
  }
  const maximumFramesWithoutUpdate =
    lostTrackBuffer === 0 ? 0 : Math.max(1, Math.ceil(scaledLostTrackBuffer));
  let tracks: KalmanBoxTrack[] = [];
  let nextTrackerId = 0;
  let previousFrameIndex: number | undefined;

  return {
    reset() {
      tracks = [];
      nextTrackerId = 0;
      previousFrameIndex = undefined;
    },

    update(detections, frameIndex) {
      const frameStep = resolveFrameStep(frameIndex, previousFrameIndex);
      previousFrameIndex = frameIndex ?? previousFrameIndex;
      tracks.forEach((track) => track.predict(frameStep, frameRate));

      const highDetectionIndexes: number[] = [];
      const lowDetectionIndexes: number[] = [];
      detections.forEach((detection, index) => {
        if ((detection.confidence ?? 1) >= highConfidenceDetectionThreshold) {
          highDetectionIndexes.push(index);
        } else {
          lowDetectionIndexes.push(index);
        }
      });

      const assignments = new Map<number, number>();
      const firstStage = associate(
        tracks,
        detections,
        highDetectionIndexes,
        minimumIouThreshold,
      );
      for (const match of firstStage.matches) {
        updateMatchedTrack(
          tracks[match.trackIndex]!,
          detections[match.detectionIndex]!,
          assignments,
        );
      }

      const remainingTracks = firstStage.unmatchedTrackIndexes.map(
        (index) => tracks[index]!,
      );
      const secondStage = associate(
        remainingTracks,
        detections,
        lowDetectionIndexes,
        minimumIouThreshold,
      );
      for (const match of secondStage.matches) {
        updateMatchedTrack(
          remainingTracks[match.trackIndex]!,
          detections[match.detectionIndex]!,
          assignments,
        );
      }

      // Only unmatched high-confidence observations can start a track.
      for (const detectionIndex of firstStage.unmatchedDetectionIndexes) {
        const detection = detections[detectionIndex]!;
        if ((detection.confidence ?? 1) >= trackActivationThreshold) {
          tracks.push(new KalmanBoxTrack(detection, true));
        }
      }

      // Confirmation is sticky once an ID has been allocated. An unmatched
      // unconfirmed track is discarded immediately, as in Python ByteTrack.
      tracks = tracks.filter(
        (track) =>
          track.timeSinceUpdate <= maximumFramesWithoutUpdate &&
          (track.trackerId !== undefined ||
            track.successfulUpdates >= minimumConsecutiveFrames ||
            track.timeSinceUpdate === 0),
      );

      return {
        activeTrackCount: tracks.length,
        assignments: detections.flatMap((detection) => {
          const trackerId = assignments.get(detection.detectionIndex);
          return trackerId === undefined
            ? []
            : [{ detectionIndex: detection.detectionIndex, trackerId }];
        }),
        confirmedTrackCount: tracks.filter(
          (track) => track.trackerId !== undefined,
        ).length,
      } satisfies ByteTrackTrackerUpdate;
    },
  };

  function updateMatchedTrack(
    track: KalmanBoxTrack,
    detection: TrackingProjection,
    assignments: Map<number, number>,
  ) {
    track.update(detection);
    if (
      track.trackerId === undefined &&
      track.successfulUpdates >= minimumConsecutiveFrames
    ) {
      track.trackerId = nextTrackerId;
      nextTrackerId += 1;
    }
    if (track.trackerId !== undefined) {
      assignments.set(detection.detectionIndex, track.trackerId);
    }
  }
}

function associate(
  tracks: readonly KalmanBoxTrack[],
  detections: readonly TrackingProjection[],
  detectionIndexes: readonly number[],
  minimumIouThreshold: number,
) {
  if (tracks.length === 0 || detectionIndexes.length === 0) {
    return {
      matches: [] as Match[],
      unmatchedDetectionIndexes: [...detectionIndexes],
      unmatchedTrackIndexes: tracks.map((_, index) => index),
    };
  }

  const scores = tracks.map((track) => {
    const predictedRect = track.getStateRect();
    return detectionIndexes.map((detectionIndex) =>
      intersectionOverUnion(predictedRect, detections[detectionIndex]!.rect),
    );
  });
  const matches: Match[] = [];
  const matchedTracks = new Set<number>();
  const matchedDetections = new Set<number>();

  for (const [trackIndex, localDetectionIndex] of maximizeAssignment(scores)) {
    if (scores[trackIndex]![localDetectionIndex]! < minimumIouThreshold) {
      continue;
    }
    const detectionIndex = detectionIndexes[localDetectionIndex]!;
    matches.push({ detectionIndex, trackIndex });
    matchedTracks.add(trackIndex);
    matchedDetections.add(detectionIndex);
  }
  matches.sort((left, right) => left.trackIndex - right.trackIndex);

  return {
    matches,
    unmatchedDetectionIndexes: detectionIndexes.filter(
      (index) => !matchedDetections.has(index),
    ),
    unmatchedTrackIndexes: tracks.flatMap((_, index) =>
      matchedTracks.has(index) ? [] : [index],
    ),
  };
}
