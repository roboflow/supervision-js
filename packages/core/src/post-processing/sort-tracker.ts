import type { Rect } from "#types/detections";
import type {
  SortTracker,
  SortTrackerUpdate,
  SortTrackingOptions,
  TrackingProjection,
} from "#types/post-processing";

type Matrix = number[][];

interface Match {
  readonly detectionIndex: number;
  readonly trackIndex: number;
}

/**
 * Creates one stateful SORT tracker for a single ordered media sequence.
 *
 * Defaults, lifecycle semantics, and observation-only output mirror
 * roboflow/trackers SORT. Motion predictions remain internal to association.
 */
export function createSortTracker(
  options: SortTrackingOptions = {},
): SortTracker {
  const lostTrackBuffer = normalizeNonNegativeInteger(
    options.lostTrackBuffer ?? 30,
    "lostTrackBuffer",
  );
  const frameRate = options.frameRate ?? 30;
  const trackActivationThreshold = options.trackActivationThreshold ?? 0.25;
  const minimumConsecutiveFrames = normalizePositiveInteger(
    options.minimumConsecutiveFrames ?? 3,
    "minimumConsecutiveFrames",
  );
  const minimumIouThreshold = options.minimumIouThreshold ?? 0.3;

  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error("frameRate must be a finite positive value.");
  }
  normalizeUnitInterval(trackActivationThreshold, "trackActivationThreshold");
  normalizeUnitInterval(minimumIouThreshold, "minimumIouThreshold");

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
      const predicted = tracks.map((track) =>
        track.predict(frameStep, frameRate),
      );
      const { matches, unmatchedDetections } = associateDetectionsToTracks(
        detections,
        predicted,
        minimumIouThreshold,
      );
      const trackerIds = new Map<number, number>();

      for (const match of matches) {
        const track = tracks[match.trackIndex]!;
        const detection = detections[match.detectionIndex]!;
        track.update(detection);

        if (
          track.trackerId === undefined &&
          track.successfulUpdates >= minimumConsecutiveFrames
        ) {
          track.trackerId = nextTrackerId;
          nextTrackerId += 1;
        }
        if (track.trackerId !== undefined) {
          trackerIds.set(detection.detectionIndex, track.trackerId);
        }
      }

      for (const detectionIndex of unmatchedDetections) {
        const detection = detections[detectionIndex]!;
        if ((detection.confidence ?? 1) >= trackActivationThreshold) {
          tracks.push(new KalmanBoxTrack(detection));
        }
      }

      tracks = tracks.filter(
        (track) =>
          track.timeSinceUpdate <= maximumFramesWithoutUpdate &&
          (track.successfulUpdates >= minimumConsecutiveFrames ||
            track.timeSinceUpdate === 0),
      );

      return {
        activeTrackCount: tracks.length,
        assignments: detections.flatMap((detection) => {
          const trackerId = trackerIds.get(detection.detectionIndex);
          return trackerId === undefined
            ? []
            : [{ detectionIndex: detection.detectionIndex, trackerId }];
        }),
        confirmedTrackCount: tracks.filter(
          (track) => track.trackerId !== undefined,
        ).length,
      } satisfies SortTrackerUpdate;
    },
  };
}

class KalmanBoxTrack {
  trackerId: number | undefined;
  successfulUpdates = 1;
  timeSinceUpdate = 0;
  private state: Matrix;
  private covariance = identity(8);

  constructor(detection: TrackingProjection) {
    this.state = [...rectToXyxy(detection.rect), 0, 0, 0, 0].map((value) => [
      value,
    ]);
  }

  predict(frameStep: number, frameRate: number): Rect {
    const transition = identity(8);
    for (let index = 0; index < 4; index += 1) {
      transition[index]![index + 4] = frameStep;
    }

    this.state = multiply(transition, this.state);
    this.covariance = add(
      multiply(multiply(transition, this.covariance), transpose(transition)),
      createProcessNoise(frameStep, frameRate),
    );
    // Python SORT counts update calls for the fixed-rate lost-track budget.
    this.timeSinceUpdate += 1;
    return stateToRect(this.state);
  }

  update(detection: TrackingProjection) {
    const measurement = rectToXyxy(detection.rect).map((value) => [value]);
    const observation = [
      [1, 0, 0, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0],
    ];
    const measurementNoise = scale(identity(4), 0.1);
    const innovation = subtract(measurement, multiply(observation, this.state));
    const covarianceObservationTranspose = multiply(
      this.covariance,
      transpose(observation),
    );
    const innovationCovariance = add(
      multiply(observation, covarianceObservationTranspose),
      measurementNoise,
    );
    const gain = multiply(
      covarianceObservationTranspose,
      inverse(innovationCovariance),
    );

    this.state = add(this.state, multiply(gain, innovation));
    const identityMinusGainObservation = subtract(
      identity(8),
      multiply(gain, observation),
    );
    // Joseph form matches the Python implementation and is more stable.
    this.covariance = add(
      multiply(
        multiply(identityMinusGainObservation, this.covariance),
        transpose(identityMinusGainObservation),
      ),
      multiply(multiply(gain, measurementNoise), transpose(gain)),
    );
    this.timeSinceUpdate = 0;
    this.successfulUpdates += 1;
  }
}

function associateDetectionsToTracks(
  detections: readonly TrackingProjection[],
  predicted: readonly Rect[],
  minimumIouThreshold: number,
) {
  if (predicted.length === 0 || detections.length === 0) {
    return {
      matches: [] as Match[],
      unmatchedDetections: detections.map((_, index) => index),
    };
  }

  // Python SORT associates all detections class-agnostically using standard IoU.
  const scores = predicted.map((rect) =>
    detections.map((detection) => intersectionOverUnion(rect, detection.rect)),
  );
  const candidateMatches = maximizeAssignment(scores);
  const matches: Match[] = [];
  const matchedDetections = new Set<number>();

  for (const [trackIndex, detectionIndex] of candidateMatches) {
    if (scores[trackIndex]![detectionIndex]! < minimumIouThreshold) continue;
    matches.push({ detectionIndex, trackIndex });
    matchedDetections.add(detectionIndex);
  }
  matches.sort((left, right) => left.trackIndex - right.trackIndex);

  return {
    matches,
    unmatchedDetections: detections.flatMap((_, index) =>
      matchedDetections.has(index) ? [] : [index],
    ),
  };
}

/** Hungarian assignment for a rectangular score matrix. */
function maximizeAssignment(scores: readonly (readonly number[])[]) {
  if (scores.length === 0 || scores[0]?.length === 0) {
    return [] as [number, number][];
  }

  const rowCount = scores.length;
  const columnCount = scores[0]!.length;
  const transposed = rowCount > columnCount;
  const costs = transposed
    ? Array.from({ length: columnCount }, (_, row) =>
        Array.from(
          { length: rowCount },
          (_, column) => 1 - scores[column]![row]!,
        ),
      )
    : scores.map((row) => row.map((score) => 1 - score));
  const rows = costs.length;
  const columns = costs[0]!.length;
  const u = new Array(rows + 1).fill(0);
  const v = new Array(columns + 1).fill(0);
  const p = new Array(columns + 1).fill(0);
  const way = new Array(columns + 1).fill(0);

  for (let row = 1; row <= rows; row += 1) {
    p[0] = row;
    let column0 = 0;
    const minValue = new Array(columns + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array(columns + 1).fill(false);

    do {
      used[column0] = true;
      const row0 = p[column0]!;
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;

      for (let column = 1; column <= columns; column += 1) {
        if (used[column]) continue;
        const current = costs[row0 - 1]![column - 1]! - u[row0]! - v[column]!;
        if (current < minValue[column]!) {
          minValue[column] = current;
          way[column] = column0;
        }
        if (minValue[column]! < delta) {
          delta = minValue[column]!;
          column1 = column;
        }
      }

      for (let column = 0; column <= columns; column += 1) {
        if (used[column]) {
          u[p[column]!] += delta;
          v[column] -= delta;
        } else {
          minValue[column] -= delta;
        }
      }

      column0 = column1;
    } while (p[column0] !== 0);

    do {
      const column1 = way[column0]!;
      p[column0] = p[column1]!;
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignments: [number, number][] = [];
  for (let column = 1; column <= columns; column += 1) {
    if (p[column] === 0) continue;
    const row = p[column]! - 1;
    assignments.push(transposed ? [column - 1, row] : [row, column - 1]);
  }
  return assignments;
}

function rectToXyxy(rect: Rect) {
  return [
    rect.x - rect.width / 2,
    rect.y - rect.height / 2,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  ];
}

function stateToRect(state: Matrix): Rect {
  // The Python XYXY estimator intentionally leaves corner velocities
  // unconstrained. Normalize only at the browser Rect boundary so a crossing
  // prediction cannot violate the positive-width/height storage contract.
  const x1 = Math.min(state[0]![0]!, state[2]![0]!);
  const y1 = Math.min(state[1]![0]!, state[3]![0]!);
  const x2 = Math.max(state[0]![0]!, state[2]![0]!);
  const y2 = Math.max(state[1]![0]!, state[3]![0]!);
  return {
    height: Math.max(Number.EPSILON, y2 - y1),
    width: Math.max(Number.EPSILON, x2 - x1),
    x: (x1 + x2) / 2,
    y: (y1 + y2) / 2,
  };
}

function createProcessNoise(frameStep: number, frameRate: number): Matrix {
  if (Math.abs(frameStep - 1) <= 0.004 * frameRate) {
    return scale(identity(8), 0.01);
  }

  const result = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const dt2 = frameStep * frameStep;
  const dt3 = dt2 * frameStep;
  const dt4 = dt2 * dt2;
  for (let index = 0; index < 4; index += 1) {
    const velocityIndex = index + 4;
    result[index]![index] = (0.01 * dt4) / 4;
    result[index]![velocityIndex] = (0.01 * dt3) / 2;
    result[velocityIndex]![index] = (0.01 * dt3) / 2;
    result[velocityIndex]![velocityIndex] = 0.01 * dt2;
  }
  return result;
}

function intersectionOverUnion(left: Rect, right: Rect) {
  const leftX = left.x - left.width / 2;
  const leftY = left.y - left.height / 2;
  const rightX = right.x - right.width / 2;
  const rightY = right.y - right.height / 2;
  const intersectionWidth = Math.max(
    0,
    Math.min(leftX + left.width, rightX + right.width) -
      Math.max(leftX, rightX),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftY + left.height, rightY + right.height) -
      Math.max(leftY, rightY),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const union =
    left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function resolveFrameStep(
  current: number | undefined,
  previous: number | undefined,
) {
  if (current === undefined || previous === undefined) return 1;
  return Math.max(1, current - previous);
}

function normalizePositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function normalizeUnitInterval(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
}

function identity(size: number): Matrix {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

function scale(matrix: Matrix, factor: number): Matrix {
  return matrix.map((row) => row.map((value) => value * factor));
}

function transpose(matrix: Matrix): Matrix {
  return matrix[0]!.map((_, column) => matrix.map((row) => row[column]!));
}

function add(left: Matrix, right: Matrix): Matrix {
  return left.map((row, rowIndex) =>
    row.map((value, columnIndex) => value + right[rowIndex]![columnIndex]!),
  );
}

function subtract(left: Matrix, right: Matrix): Matrix {
  return left.map((row, rowIndex) =>
    row.map((value, columnIndex) => value - right[rowIndex]![columnIndex]!),
  );
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return left.map((row) =>
    right[0]!.map((_, column) =>
      row.reduce(
        (sum, value, index) => sum + value * right[index]![column]!,
        0,
      ),
    ),
  );
}

function inverse(matrix: Matrix): Matrix {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    ...identity(size)[index]!,
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row]![column]!) >
        Math.abs(augmented[pivot]![column]!)
      ) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-12) {
      throw new Error("SORT Kalman covariance is singular.");
    }
    [augmented[column], augmented[pivot]] = [
      augmented[pivot]!,
      augmented[column]!,
    ];
    const divisor = augmented[column]![column]!;
    augmented[column] = augmented[column]!.map((value) => value / divisor);

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      augmented[row] = augmented[row]!.map(
        (value, index) => value - factor * augmented[column]![index]!,
      );
    }
  }

  return augmented.map((row) => row.slice(size));
}
