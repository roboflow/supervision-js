import type {
  OCSortTracker,
  OCSortTrackingOptions,
  TrackingAssignment,
  TrackingProjection,
} from "#types/post-processing";
import {
  associateTrackingScores,
  pairwiseIou,
} from "#post-processing/tracking-association";
import {
  TrackingKalmanEstimator,
  rectToMeasurement,
  scaleMatrix,
  type TrackingKalmanSnapshot,
} from "#post-processing/tracking-kalman";
import {
  identity,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeUnitInterval,
  resolveFrameStep,
} from "#post-processing/sort-tracker";

interface Velocity {
  readonly x: number;
  readonly y: number;
}

class OCSortTrack {
  age = 0;
  lastObservation: TrackingProjection;
  trackerId: number | undefined;
  successfulConsecutiveUpdates = 0;
  timeSinceUpdate = 0;
  velocity: Velocity | undefined;
  private frozenState: TrackingKalmanSnapshot | undefined;
  private observed = true;
  private readonly observations = new Map<number, TrackingProjection>();
  private readonly estimator: TrackingKalmanEstimator;

  constructor(
    initial: TrackingProjection,
    private readonly deltaT: number,
  ) {
    this.lastObservation = initial;
    this.estimator = new TrackingKalmanEstimator(initial.rect, "xcycsr");
    this.configureNoise();
  }

  predict(frameStep: number, frameRate: number) {
    if (this.observed && this.timeSinceUpdate > 0) {
      this.frozenState = this.estimator.snapshot();
      this.observed = false;
    }
    this.estimator.predict(frameStep, frameRate);
    if (this.timeSinceUpdate > 0) {
      this.successfulConsecutiveUpdates = 0;
    }
    this.timeSinceUpdate += 1;
    this.age += 1;
  }

  update(detection: TrackingProjection, frameStep: number, frameRate: number) {
    const previous = this.getPreviousObservation();
    if (previous) {
      this.velocity = computeVelocity(previous, detection);
    }
    if (!this.observed && this.frozenState) {
      this.unfreeze(detection, frameStep, frameRate);
    }
    this.estimator.update(detection.rect);
    this.observed = true;
    this.timeSinceUpdate = 0;
    this.successfulConsecutiveUpdates += 1;
    this.lastObservation = detection;
    this.observations.set(this.age, detection);
    const cutoff = this.age - this.deltaT;
    for (const age of this.observations.keys()) {
      if (age < cutoff) this.observations.delete(age);
    }
  }

  getRect() {
    return this.estimator.getRect();
  }

  getPreviousObservation() {
    if (this.observations.size === 0) return undefined;
    for (let index = 0; index < this.deltaT; index += 1) {
      const delta = this.deltaT - index;
      const observation = this.observations.get(this.age - delta);
      if (observation) return observation;
    }
    const latestAge = Math.max(...this.observations.keys());
    return this.observations.get(latestAge);
  }

  private configureNoise() {
    const measurementNoise = identity(4);
    for (let index = 2; index < 4; index += 1) {
      measurementNoise[index]![index] *= 10;
    }
    const covariance = scaleMatrix(identity(7), 10);
    for (let index = 4; index < 7; index += 1) {
      covariance[index]![index] *= 1000;
    }
    const processNoise = identity(7);
    processNoise[6]![6] *= 0.01;
    for (let index = 4; index < 7; index += 1) {
      processNoise[index]![index] *= 0.01;
    }
    this.estimator.setCovariances({
      covariance,
      measurementNoise,
      processNoise,
    });
  }

  private unfreeze(
    detection: TrackingProjection,
    frameStep: number,
    frameRate: number,
  ) {
    if (!this.frozenState || this.timeSinceUpdate === 0) return;
    this.estimator.restore(this.frozenState);
    const timeGap = this.timeSinceUpdate;
    const start = rectToMeasurement(this.lastObservation.rect, "xcycsr");
    const end = rectToMeasurement(detection.rect, "xcycsr");
    const startWidth = Math.sqrt(start[2]! * start[3]!);
    const startHeight = start[3] === 0 ? 0 : Math.sqrt(start[2]! / start[3]!);
    const endWidth = Math.sqrt(end[2]! * end[3]!);
    const endHeight = end[3] === 0 ? 0 : Math.sqrt(end[2]! / end[3]!);

    for (let index = 0; index < timeGap; index += 1) {
      const progress = (index + 1) / timeGap;
      const x = start[0]! + progress * (end[0]! - start[0]!);
      const y = start[1]! + progress * (end[1]! - start[1]!);
      const width = startWidth + progress * (endWidth - startWidth);
      const height = startHeight + progress * (endHeight - startHeight);
      this.estimator.updateMeasurement([x, y, width * height, width / height]);
      if (index < timeGap - 1) {
        this.estimator.predict(frameStep, frameRate);
      }
    }
    this.frozenState = undefined;
  }
}

/** Creates the observation-centric SORT implementation from roboflow/trackers. */
export function createOCSortTracker(
  options: OCSortTrackingOptions = {},
): OCSortTracker {
  const lostTrackBuffer = normalizeNonNegativeInteger(
    options.lostTrackBuffer ?? 30,
    "lostTrackBuffer",
  );
  const frameRate = options.frameRate ?? 30;
  const minimumConsecutiveFrames = normalizePositiveInteger(
    options.minimumConsecutiveFrames ?? 3,
    "minimumConsecutiveFrames",
  );
  const minimumIouThreshold = options.minimumIouThreshold ?? 0.3;
  const directionConsistencyWeight = options.directionConsistencyWeight ?? 0.2;
  const highConfidenceDetectionThreshold =
    options.highConfidenceDetectionThreshold ?? 0.6;
  const deltaT = normalizePositiveInteger(options.deltaT ?? 3, "deltaT");

  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error("frameRate must be a finite positive value.");
  }
  normalizeUnitInterval(minimumIouThreshold, "minimumIouThreshold");
  normalizeUnitInterval(
    directionConsistencyWeight,
    "directionConsistencyWeight",
  );
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
  let tracks: OCSortTrack[] = [];
  let frameCount = 0;
  let nextTrackerId = 0;
  let previousFrameIndex: number | undefined;

  return {
    reset() {
      tracks = [];
      frameCount = 0;
      nextTrackerId = 0;
      previousFrameIndex = undefined;
    },

    update(detections, frameIndex) {
      const frameStep = resolveFrameStep(frameIndex, previousFrameIndex);
      previousFrameIndex = frameIndex ?? previousFrameIndex;
      tracks.forEach((track) => track.predict(frameStep, frameRate));

      const highDetectionIndexes = detections.flatMap((detection, index) =>
        detection.confidence === undefined ||
        detection.confidence >= highConfidenceDetectionThreshold
          ? [index]
          : [],
      );
      const highDetections = highDetectionIndexes.map(
        (index) => detections[index]!,
      );
      const iouScores = pairwiseIou(
        tracks.map((track) => track.getRect()),
        highDetections.map((detection) => detection.rect),
      );
      const combinedScores = iouScores.map((row, trackIndex) =>
        row.map((iou, detectionIndex) => {
          if (directionConsistencyWeight === 0) return iou;
          return (
            iou +
            directionConsistencyWeight *
              directionConsistency(
                tracks[trackIndex]!,
                highDetections[detectionIndex]!,
              ) *
              (highDetections[detectionIndex]!.confidence ?? 1)
          );
        }),
      );
      const primary = associateTrackingScores(
        combinedScores,
        tracks.length,
        highDetections.length,
        minimumIouThreshold,
        iouScores,
      );
      const assignments = new Map<number, number>();
      for (const match of primary.matches) {
        updateMatchedTrack(
          tracks[match.trackIndex]!,
          highDetections[match.detectionIndex]!,
          assignments,
          frameStep,
        );
      }

      let remainingHigh = [...primary.unmatchedDetectionIndexes];
      if (
        primary.unmatchedTrackIndexes.length > 0 &&
        remainingHigh.length > 0
      ) {
        const unmatchedTracks = primary.unmatchedTrackIndexes.map(
          (index) => tracks[index]!,
        );
        const unmatchedDetections = remainingHigh.map(
          (index) => highDetections[index]!,
        );
        const recoveryScores = pairwiseIou(
          unmatchedTracks.map((track) => track.lastObservation.rect),
          unmatchedDetections.map((detection) => detection.rect),
        );
        const recovery = associateTrackingScores(
          recoveryScores,
          unmatchedTracks.length,
          unmatchedDetections.length,
          minimumIouThreshold,
        );
        for (const match of recovery.matches) {
          updateMatchedTrack(
            unmatchedTracks[match.trackIndex]!,
            unmatchedDetections[match.detectionIndex]!,
            assignments,
            frameStep,
          );
        }
        remainingHigh = recovery.unmatchedDetectionIndexes.map(
          (index) => remainingHigh[index]!,
        );
      }

      for (const localIndex of remainingHigh) {
        tracks.push(new OCSortTrack(highDetections[localIndex]!, deltaT));
      }
      tracks = tracks.filter(
        (track) => track.timeSinceUpdate <= maximumFramesWithoutUpdate,
      );
      frameCount += 1;

      const resolvedAssignments: TrackingAssignment[] = detections.flatMap(
        (detection) => {
          const trackerId = assignments.get(detection.detectionIndex);
          return trackerId === undefined
            ? []
            : [{ detectionIndex: detection.detectionIndex, trackerId }];
        },
      );
      return {
        activeTrackCount: tracks.length,
        assignments: resolvedAssignments,
        confirmedTrackCount: tracks.filter(
          (track) => track.trackerId !== undefined,
        ).length,
      };
    },
  };

  function updateMatchedTrack(
    track: OCSortTrack,
    detection: TrackingProjection,
    assignments: Map<number, number>,
    frameStep: number,
  ) {
    track.update(detection, frameStep, frameRate);
    const earlySequence = frameCount <= minimumConsecutiveFrames;
    const shouldEmit =
      (earlySequence && track.timeSinceUpdate === 0) ||
      track.successfulConsecutiveUpdates >= minimumConsecutiveFrames;
    if (shouldEmit) {
      if (track.trackerId === undefined) {
        track.trackerId = nextTrackerId++;
      }
      assignments.set(detection.detectionIndex, track.trackerId);
    }
  }
}

function computeVelocity(
  previous: TrackingProjection,
  current: TrackingProjection,
): Velocity {
  const deltaX = current.rect.x - previous.rect.x;
  const deltaY = current.rect.y - previous.rect.y;
  const norm = Math.sqrt(deltaX * deltaX + deltaY * deltaY) + 1e-6;
  return { x: deltaX / norm, y: deltaY / norm };
}

function directionConsistency(
  track: OCSortTrack,
  detection: TrackingProjection,
) {
  if (!track.velocity) return 0;
  const reference = track.getPreviousObservation() ?? track.lastObservation;
  const deltaX = detection.rect.x - reference.rect.x;
  const deltaY = detection.rect.y - reference.rect.y;
  const norm = Math.sqrt(deltaX * deltaX + deltaY * deltaY) + 1e-6;
  const cosine = Math.max(
    -1,
    Math.min(
      1,
      track.velocity.x * (deltaX / norm) + track.velocity.y * (deltaY / norm),
    ),
  );
  const angle = Math.acos(cosine);
  return (Math.PI / 2 - Math.abs(angle)) / Math.PI;
}
