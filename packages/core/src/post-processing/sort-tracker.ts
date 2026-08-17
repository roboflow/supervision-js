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

/** Creates one stateful SORT tracker for a single ordered media sequence. */
export function createSortTracker(
  options: SortTrackingOptions = {},
): SortTracker {
  const maxAge = normalizePositiveInteger(options.maxAge ?? 30, "maxAge");
  const minHits = normalizePositiveInteger(options.minHits ?? 3, "minHits");
  const iouThreshold = options.iouThreshold ?? 0.3;
  const matchByClass = options.matchByClass ?? true;
  const emitPredictions = options.emitPredictions ?? true;

  if (!Number.isFinite(iouThreshold) || iouThreshold < 0 || iouThreshold > 1) {
    throw new Error("iouThreshold must be between 0 and 1.");
  }
  let tracks: KalmanBoxTrack[] = [];
  let nextTrackerId = 1;
  let previousFrameIndex: number | undefined;

  return {
    reset() {
      tracks = [];
      nextTrackerId = 1;
      previousFrameIndex = undefined;
    },

    update(detections, frameIndex) {
      const deltaFrames = resolveDeltaFrames(frameIndex, previousFrameIndex);
      previousFrameIndex = frameIndex ?? previousFrameIndex;
      const predicted = tracks.map((track) => track.predict(deltaFrames));
      const { matches, unmatchedDetections } = associateDetectionsToTracks(
        detections,
        predicted,
        tracks,
        iouThreshold,
        matchByClass,
      );
      const trackerIds = new Map<number, number>();

      for (const match of matches) {
        const track = tracks[match.trackIndex]!;
        const detection = detections[match.detectionIndex]!;
        track.update(detection);
        trackerIds.set(detection.detectionIndex, track.id);
      }

      for (const detectionIndex of unmatchedDetections) {
        const detection = detections[detectionIndex]!;
        const track = new KalmanBoxTrack(nextTrackerId, detection, minHits);
        nextTrackerId += 1;
        tracks.push(track);
        trackerIds.set(detection.detectionIndex, track.id);
      }

      tracks = tracks.filter((track) => track.timeSinceUpdate <= maxAge);
      const confirmedTrackCount = tracks.filter(
        (track) => track.isConfirmed,
      ).length;

      return {
        activeTrackCount: tracks.length,
        assignments: detections.flatMap((detection) => {
          const trackerId = trackerIds.get(detection.detectionIndex);
          return trackerId === undefined
            ? []
            : [{ detectionIndex: detection.detectionIndex, trackerId }];
        }),
        confirmedTrackCount,
        predictions: emitPredictions
          ? tracks.flatMap((track) => {
              const prediction = track.getPrediction();
              return prediction ? [prediction] : [];
            })
          : [],
      } satisfies SortTrackerUpdate;
    },
  };
}

class KalmanBoxTrack {
  readonly id: number;
  hits = 1;
  hitStreak = 1;
  timeSinceUpdate = 0;
  private className: string | undefined;
  private confirmed: boolean;
  private readonly minHits: number;
  private state: Matrix;
  private covariance: Matrix;

  constructor(id: number, detection: TrackingProjection, minHits: number) {
    this.id = id;
    this.minHits = minHits;
    this.confirmed = minHits <= 1;
    this.className = detection.className;
    this.state = [...rectToMeasurement(detection.rect), 0, 0, 0].map(
      (value) => [value],
    );
    this.covariance = diagonal([10, 10, 10, 10, 10_000, 10_000, 10_000]);
  }

  get detectionClassName() {
    return this.className;
  }

  get isConfirmed() {
    return this.confirmed;
  }

  getPrediction() {
    if (!this.confirmed || this.timeSinceUpdate === 0) {
      return undefined;
    }

    return {
      ageFrames: this.timeSinceUpdate,
      ...(this.className === undefined ? {} : { className: this.className }),
      rect: stateToRect(this.state),
      trackerId: this.id,
    };
  }

  predict(deltaFrames: number): Rect {
    if (this.timeSinceUpdate > 0 || deltaFrames > 1) {
      this.hitStreak = 0;
    }
    const transition = identity(7);
    transition[0]![4] = deltaFrames;
    transition[1]![5] = deltaFrames;
    transition[2]![6] = deltaFrames;
    const processNoise = diagonal([
      1,
      1,
      4,
      0.01,
      0.04 * deltaFrames,
      0.04 * deltaFrames,
      0.01 * deltaFrames,
    ]);

    if (this.state[2]![0]! + this.state[6]![0]! * deltaFrames <= 0) {
      this.state[6]![0] = 0;
    }

    this.state = multiply(transition, this.state);
    this.covariance = add(
      multiply(multiply(transition, this.covariance), transpose(transition)),
      processNoise,
    );
    this.timeSinceUpdate += deltaFrames;
    return stateToRect(this.state);
  }

  update(detection: TrackingProjection) {
    const measurement = rectToMeasurement(detection.rect).map((value) => [
      value,
    ]);
    const observation = [
      [1, 0, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0],
    ];
    const measurementNoise = diagonal([1, 1, 10, 10]);
    const innovation = subtract(measurement, multiply(observation, this.state));
    const innovationCovariance = add(
      multiply(multiply(observation, this.covariance), transpose(observation)),
      measurementNoise,
    );
    const gain = multiply(
      multiply(this.covariance, transpose(observation)),
      inverse(innovationCovariance),
    );

    this.state = add(this.state, multiply(gain, innovation));
    this.covariance = multiply(
      subtract(identity(7), multiply(gain, observation)),
      this.covariance,
    );
    this.className = detection.className ?? this.className;
    this.timeSinceUpdate = 0;
    this.hits += 1;
    this.hitStreak += 1;
    this.confirmed ||= this.hitStreak >= this.minHits;
  }
}

function associateDetectionsToTracks(
  detections: readonly TrackingProjection[],
  predicted: readonly Rect[],
  tracks: readonly KalmanBoxTrack[],
  iouThreshold: number,
  matchByClass: boolean,
) {
  if (tracks.length === 0) {
    return {
      matches: [] as Match[],
      unmatchedDetections: detections.map((_, index) => index),
    };
  }

  const scores = detections.map((detection) =>
    predicted.map((rect, trackIndex) =>
      matchByClass &&
      detection.className !== undefined &&
      tracks[trackIndex]!.detectionClassName !== undefined &&
      detection.className !== tracks[trackIndex]!.detectionClassName
        ? -1
        : intersectionOverUnion(detection.rect, rect),
    ),
  );
  const candidateMatches = maximizeAssignment(scores);
  const matches: Match[] = [];
  const matchedDetections = new Set<number>();

  for (const [detectionIndex, trackIndex] of candidateMatches) {
    if (scores[detectionIndex]![trackIndex]! < iouThreshold) {
      continue;
    }

    matches.push({ detectionIndex, trackIndex });
    matchedDetections.add(detectionIndex);
  }

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

function rectToMeasurement(rect: Rect) {
  const area = Math.max(Number.EPSILON, rect.width * rect.height);
  return [rect.x, rect.y, area, rect.width / Math.max(rect.height, 1e-6)];
}

function stateToRect(state: Matrix): Rect {
  const area = Math.max(Number.EPSILON, state[2]![0]!);
  const ratio = Math.max(Number.EPSILON, state[3]![0]!);
  const width = Math.sqrt(area * ratio);
  const height = area / width;
  return { height, width, x: state[0]![0]!, y: state[1]![0]! };
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

function resolveDeltaFrames(
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

function identity(size: number): Matrix {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

function diagonal(values: readonly number[]): Matrix {
  return values.map((value, row) =>
    values.map((_, column) => (row === column ? value : 0)),
  );
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
