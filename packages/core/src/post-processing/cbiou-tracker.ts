import type {
  CBIoUTracker,
  CBIoUTrackingOptions,
  TrackingAssignment,
  TrackingProjection,
} from "#types/post-processing";
import {
  associateTrackingScores,
  pairwiseIou,
} from "#post-processing/tracking-association";
import {
  TrackingKalmanEstimator,
  diagonal,
} from "#post-processing/tracking-kalman";
import {
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeUnitInterval,
  resolveFrameStep,
} from "#post-processing/sort-tracker";

const MINIMUM_DETECTION_CONFIDENCE = 0.1;

class CBIoUTrack {
  trackerId: number | undefined;
  successfulUpdates = 1;
  timeSinceUpdate = 0;
  readonly estimator: TrackingKalmanEstimator;

  constructor(initial: TrackingProjection) {
    this.estimator = new TrackingKalmanEstimator(initial.rect, "xcycwh");
    this.setInitialNoise(initial.rect.width, initial.rect.height);
  }

  predict(frameStep: number, frameRate: number) {
    const current = this.estimator.getRect();
    this.estimator.setCovariances({
      processNoise: this.buildProcessNoise(
        Math.max(current.width, 1e-3),
        Math.max(current.height, 1e-3),
      ),
    });
    this.estimator.predict(frameStep, frameRate);
    this.clampState();
    this.timeSinceUpdate += 1;
  }

  update(detection: TrackingProjection) {
    const current = this.estimator.getRect();
    this.estimator.setCovariances({
      measurementNoise: this.buildMeasurementNoise(
        Math.max(current.width, 1e-3),
        Math.max(current.height, 1e-3),
      ),
    });
    this.estimator.update(detection.rect);
    this.clampState();
    this.timeSinceUpdate = 0;
    this.successfulUpdates += 1;
  }

  getRect() {
    return this.estimator.getRect();
  }

  private setInitialNoise(width: number, height: number) {
    const sigmaPosition = 0.05;
    const sigmaVelocity = 0.00625;
    this.estimator.setCovariances({
      covariance: diagonal([
        (2 * sigmaPosition * width) ** 2,
        (2 * sigmaPosition * height) ** 2,
        (2 * sigmaPosition * width) ** 2,
        (2 * sigmaPosition * height) ** 2,
        (10 * sigmaVelocity * width) ** 2,
        (10 * sigmaVelocity * height) ** 2,
        (10 * sigmaVelocity * width) ** 2,
        (10 * sigmaVelocity * height) ** 2,
      ]),
      measurementNoise: this.buildMeasurementNoise(width, height),
      processNoise: this.buildProcessNoise(width, height),
    });
  }

  private buildProcessNoise(width: number, height: number) {
    const sigmaPosition = 0.05;
    const sigmaVelocity = 0.00625;
    return diagonal([
      (sigmaPosition * width) ** 2,
      (sigmaPosition * height) ** 2,
      (sigmaPosition * width) ** 2,
      (sigmaPosition * height) ** 2,
      (sigmaVelocity * width) ** 2,
      (sigmaVelocity * height) ** 2,
      (sigmaVelocity * width) ** 2,
      (sigmaVelocity * height) ** 2,
    ]);
  }

  private buildMeasurementNoise(width: number, height: number) {
    const sigmaMeasurement = 0.05;
    return diagonal([
      (sigmaMeasurement * width) ** 2,
      (sigmaMeasurement * height) ** 2,
      (sigmaMeasurement * width) ** 2,
      (sigmaMeasurement * height) ** 2,
    ]);
  }

  private clampState() {
    this.estimator.state[2]![0] = Math.max(this.estimator.state[2]![0]!, 1e-3);
    this.estimator.state[3]![0] = Math.max(this.estimator.state[3]![0]!, 1e-3);
  }
}

/** Creates the detection-only C-BIoU implementation from roboflow/trackers. */
export function createCBIoUTracker(
  options: CBIoUTrackingOptions = {},
): CBIoUTracker {
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
  const minimumIouThresholdFirstAssociation =
    options.minimumIouThresholdFirstAssociation ?? 0.2;
  const minimumIouThresholdSecondAssociation =
    options.minimumIouThresholdSecondAssociation ?? 0.5;
  const minimumIouThresholdUnconfirmedAssociation =
    options.minimumIouThresholdUnconfirmedAssociation ?? 0.3;
  const highConfidenceDetectionThreshold =
    options.highConfidenceDetectionThreshold ?? 0.6;
  const instantFirstFrameActivation =
    options.instantFirstFrameActivation ?? true;
  const bufferRatioFirst = options.bufferRatioFirst ?? 0.3;
  const bufferRatioSecond = options.bufferRatioSecond ?? 0.5;

  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error("frameRate must be a finite positive value.");
  }
  normalizeUnitInterval(trackActivationThreshold, "trackActivationThreshold");
  normalizeUnitInterval(
    minimumIouThresholdFirstAssociation,
    "minimumIouThresholdFirstAssociation",
  );
  normalizeUnitInterval(
    minimumIouThresholdSecondAssociation,
    "minimumIouThresholdSecondAssociation",
  );
  normalizeUnitInterval(
    minimumIouThresholdUnconfirmedAssociation,
    "minimumIouThresholdUnconfirmedAssociation",
  );
  normalizeUnitInterval(
    highConfidenceDetectionThreshold,
    "highConfidenceDetectionThreshold",
  );
  if (!Number.isFinite(bufferRatioFirst) || bufferRatioFirst < 0) {
    throw new Error("bufferRatioFirst must be a finite non-negative value.");
  }
  if (!Number.isFinite(bufferRatioSecond) || bufferRatioSecond < 0) {
    throw new Error("bufferRatioSecond must be a finite non-negative value.");
  }

  const scaledLostTrackBuffer = (frameRate / 30) * lostTrackBuffer;
  if (!Number.isFinite(scaledLostTrackBuffer)) {
    throw new Error(
      "Scaled lostTrackBuffer overflows: frameRate / 30 * lostTrackBuffer must be finite.",
    );
  }
  const maximumFramesWithoutUpdate =
    lostTrackBuffer === 0 ? 0 : Math.max(1, Math.ceil(scaledLostTrackBuffer));
  let tracks: CBIoUTrack[] = [];
  let nextTrackerId = 0;
  let frameId = 0;
  let previousFrameIndex: number | undefined;

  return {
    reset() {
      tracks = [];
      nextTrackerId = 0;
      frameId = 0;
      previousFrameIndex = undefined;
    },

    update(detections, frameIndex) {
      const frameStep = resolveFrameStep(frameIndex, previousFrameIndex);
      previousFrameIndex = frameIndex ?? previousFrameIndex;
      frameId += 1;
      tracks.forEach((track) => track.predict(frameStep, frameRate));

      const highDetectionIndexes: number[] = [];
      const lowDetectionIndexes: number[] = [];
      detections.forEach((detection, index) => {
        const confidence = detection.confidence ?? 1;
        if (confidence >= highConfidenceDetectionThreshold) {
          highDetectionIndexes.push(index);
        } else if (confidence > MINIMUM_DETECTION_CONFIDENCE) {
          lowDetectionIndexes.push(index);
        }
      });

      const confirmed: CBIoUTrack[] = [];
      const unconfirmed: CBIoUTrack[] = [];
      const lost: CBIoUTrack[] = [];
      for (const track of tracks) {
        if (track.timeSinceUpdate > 1) lost.push(track);
        else if (
          track.trackerId !== undefined ||
          track.successfulUpdates >= minimumConsecutiveFrames
        ) {
          confirmed.push(track);
        } else unconfirmed.push(track);
      }

      const assignments = new Map<number, number>();
      const pool = [...confirmed, ...lost];
      const highDetections = highDetectionIndexes.map(
        (index) => detections[index]!,
      );
      const firstScores = pairwiseIou(
        pool.map((track) => track.getRect()),
        highDetections.map((detection) => detection.rect),
        bufferRatioFirst,
      ).map((row) =>
        row.map(
          (score, index) => score * (highDetections[index]!.confidence ?? 1),
        ),
      );
      const firstAssociation = associateTrackingScores(
        firstScores,
        pool.length,
        highDetections.length,
        minimumIouThresholdFirstAssociation,
      );
      for (const match of firstAssociation.matches) {
        updateMatchedTrack(
          pool[match.trackIndex]!,
          highDetections[match.detectionIndex]!,
          assignments,
        );
      }

      const remainingTracked = firstAssociation.unmatchedTrackIndexes
        .map((index) => pool[index]!)
        .filter((track) => track.timeSinceUpdate === 1);
      const lowDetections = lowDetectionIndexes.map(
        (index) => detections[index]!,
      );
      const secondScores = pairwiseIou(
        remainingTracked.map((track) => track.getRect()),
        lowDetections.map((detection) => detection.rect),
        bufferRatioSecond,
      );
      const secondAssociation = associateTrackingScores(
        secondScores,
        remainingTracked.length,
        lowDetections.length,
        minimumIouThresholdSecondAssociation,
      );
      for (const match of secondAssociation.matches) {
        updateMatchedTrack(
          remainingTracked[match.trackIndex]!,
          lowDetections[match.detectionIndex]!,
          assignments,
        );
      }

      let unmatchedHighLocal = [...firstAssociation.unmatchedDetectionIndexes];
      let unmatchedUnconfirmed = unconfirmed.map((_, index) => index);
      if (unconfirmed.length > 0 && unmatchedHighLocal.length > 0) {
        const remainingHigh = unmatchedHighLocal.map(
          (index) => highDetections[index]!,
        );
        const unconfirmedScores = pairwiseIou(
          unconfirmed.map((track) => track.getRect()),
          remainingHigh.map((detection) => detection.rect),
          bufferRatioFirst,
        ).map((row) =>
          row.map(
            (score, index) => score * (remainingHigh[index]!.confidence ?? 1),
          ),
        );
        const unconfirmedAssociation = associateTrackingScores(
          unconfirmedScores,
          unconfirmed.length,
          remainingHigh.length,
          minimumIouThresholdUnconfirmedAssociation,
        );
        unmatchedUnconfirmed = unconfirmedAssociation.unmatchedTrackIndexes;
        for (const match of unconfirmedAssociation.matches) {
          updateMatchedTrack(
            unconfirmed[match.trackIndex]!,
            remainingHigh[match.detectionIndex]!,
            assignments,
          );
        }
        unmatchedHighLocal =
          unconfirmedAssociation.unmatchedDetectionIndexes.map(
            (index) => unmatchedHighLocal[index]!,
          );
      }

      const unmatchedUnconfirmedTracks = new Set(
        unmatchedUnconfirmed.map((index) => unconfirmed[index]!),
      );
      tracks = tracks.filter((track) => !unmatchedUnconfirmedTracks.has(track));

      for (const localIndex of unmatchedHighLocal) {
        const detection = highDetections[localIndex]!;
        if ((detection.confidence ?? 1) < trackActivationThreshold) continue;
        const track = new CBIoUTrack(detection);
        if (frameId === 1 && instantFirstFrameActivation) {
          track.trackerId = nextTrackerId++;
          assignments.set(detection.detectionIndex, track.trackerId);
        }
        tracks.push(track);
      }

      tracks = tracks.filter(
        (track) =>
          track.timeSinceUpdate <= maximumFramesWithoutUpdate &&
          (track.timeSinceUpdate === 0 ||
            track.trackerId !== undefined ||
            track.successfulUpdates >= minimumConsecutiveFrames),
      );

      return createUpdate(detections, assignments, tracks);
    },
  };

  function updateMatchedTrack(
    track: CBIoUTrack,
    detection: TrackingProjection,
    assignments: Map<number, number>,
  ) {
    track.update(detection);
    if (
      track.trackerId === undefined &&
      track.successfulUpdates >= minimumConsecutiveFrames
    ) {
      track.trackerId = nextTrackerId++;
    }
    if (track.trackerId !== undefined) {
      assignments.set(detection.detectionIndex, track.trackerId);
    }
  }
}

function createUpdate(
  detections: readonly TrackingProjection[],
  assignments: ReadonlyMap<number, number>,
  tracks: readonly CBIoUTrack[],
) {
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
    confirmedTrackCount: tracks.filter((track) => track.trackerId !== undefined)
      .length,
  };
}
