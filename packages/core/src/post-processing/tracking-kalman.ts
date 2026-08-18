import type { Rect } from "#types/detections";
import {
  add,
  identity,
  inverse,
  multiply,
  scale,
  subtract,
  transpose,
  type Matrix,
} from "#post-processing/sort-tracker";

export type TrackingStateRepresentation = "xcycwh" | "xcycsr";

export interface TrackingKalmanSnapshot {
  readonly covariance: Matrix;
  readonly measurementNoise: Matrix;
  readonly processNoise: Matrix;
  readonly state: Matrix;
}

/**
 * Kalman state estimator shared by the browser C-BIoU and OC-SORT ports.
 * Its layouts, covariance update, and gap-scaled constant-velocity model
 * mirror roboflow/trackers at 60b21c8.
 */
export class TrackingKalmanEstimator {
  readonly dimension: number;
  readonly measurementDimension = 4;
  covariance: Matrix;
  measurementNoise = identity(4);
  processNoise: Matrix;
  state: Matrix;
  private baselineProcessNoise: Matrix;
  private readonly positionIndexes: readonly number[];
  private readonly velocityIndexes: readonly number[];

  constructor(
    initialRect: Rect,
    readonly representation: TrackingStateRepresentation,
  ) {
    const measurement = rectToMeasurement(initialRect, representation);
    this.dimension = representation === "xcycsr" ? 7 : 8;
    this.positionIndexes =
      representation === "xcycsr" ? [0, 1, 2] : [0, 1, 2, 3];
    this.velocityIndexes =
      representation === "xcycsr" ? [4, 5, 6] : [4, 5, 6, 7];
    this.state = Array.from({ length: this.dimension }, (_, index) => [
      measurement[index] ?? 0,
    ]);
    this.covariance = identity(this.dimension);
    this.processNoise = identity(this.dimension);
    this.baselineProcessNoise = identity(this.dimension);
  }

  predict(frameStep: number, frameRate: number) {
    if (
      this.representation === "xcycsr" &&
      this.state[2]![0]! + frameStep * this.state[6]![0]! <= 0
    ) {
      this.state[6]![0] = 0;
    }

    const transition = identity(this.dimension);
    this.positionIndexes.forEach((positionIndex, index) => {
      transition[positionIndex]![this.velocityIndexes[index]!] = frameStep;
    });
    this.processNoise = this.createProcessNoise(frameStep, frameRate);
    this.state = multiply(transition, this.state);
    this.covariance = add(
      multiply(multiply(transition, this.covariance), transpose(transition)),
      this.processNoise,
    );
  }

  update(rect: Rect) {
    this.updateMeasurement(rectToMeasurement(rect, this.representation));
  }

  updateMeasurement(measurement: readonly number[]) {
    const observation = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: this.dimension }, (_, column) =>
        row === column ? 1 : 0,
      ),
    );
    const measurementColumn = measurement.map((value) => [value]);
    const innovation = subtract(
      measurementColumn,
      multiply(observation, this.state),
    );
    const covarianceObservationTranspose = multiply(
      this.covariance,
      transpose(observation),
    );
    const innovationCovariance = add(
      multiply(observation, covarianceObservationTranspose),
      this.measurementNoise,
    );
    const gain = multiply(
      covarianceObservationTranspose,
      inverse(innovationCovariance),
    );
    this.state = add(this.state, multiply(gain, innovation));
    const identityMinusGainObservation = subtract(
      identity(this.dimension),
      multiply(gain, observation),
    );
    this.covariance = add(
      multiply(
        multiply(identityMinusGainObservation, this.covariance),
        transpose(identityMinusGainObservation),
      ),
      multiply(multiply(gain, this.measurementNoise), transpose(gain)),
    );
  }

  getRect() {
    return measurementToRect(
      this.state.slice(0, 4).map((row) => row[0]!),
      this.representation,
    );
  }

  setCovariances(options: {
    readonly covariance?: Matrix;
    readonly measurementNoise?: Matrix;
    readonly processNoise?: Matrix;
  }) {
    if (options.covariance) this.covariance = clone(options.covariance);
    if (options.measurementNoise) {
      this.measurementNoise = clone(options.measurementNoise);
    }
    if (options.processNoise) {
      this.processNoise = clone(options.processNoise);
      this.baselineProcessNoise = clone(options.processNoise);
    }
  }

  snapshot(): TrackingKalmanSnapshot {
    return {
      covariance: clone(this.covariance),
      measurementNoise: clone(this.measurementNoise),
      processNoise: clone(this.processNoise),
      state: clone(this.state),
    };
  }

  restore(snapshot: TrackingKalmanSnapshot) {
    this.covariance = clone(snapshot.covariance);
    this.measurementNoise = clone(snapshot.measurementNoise);
    this.processNoise = clone(snapshot.processNoise);
    this.state = clone(snapshot.state);
  }

  private createProcessNoise(frameStep: number, frameRate: number) {
    if (Math.abs(frameStep - 1) <= 0.004 * frameRate) {
      return clone(this.baselineProcessNoise);
    }

    const result = Array.from({ length: this.dimension }, () =>
      new Array(this.dimension).fill(0),
    );
    const dt2 = frameStep * frameStep;
    const dt3 = dt2 * frameStep;
    const dt4 = dt2 * dt2;
    const kinematicIndexes = new Set([
      ...this.positionIndexes,
      ...this.velocityIndexes,
    ]);

    this.positionIndexes.forEach((positionIndex, index) => {
      const velocityIndex = this.velocityIndexes[index]!;
      const accelerationVariance =
        this.baselineProcessNoise[velocityIndex]![velocityIndex]!;
      result[positionIndex]![positionIndex] = (accelerationVariance * dt4) / 4;
      result[positionIndex]![velocityIndex] = (accelerationVariance * dt3) / 2;
      result[velocityIndex]![positionIndex] = (accelerationVariance * dt3) / 2;
      result[velocityIndex]![velocityIndex] = accelerationVariance * dt2;
    });

    for (let index = 0; index < this.dimension; index += 1) {
      if (!kinematicIndexes.has(index)) {
        result[index]![index] = this.baselineProcessNoise[index]![index]!;
      }
    }
    return result;
  }
}

export function rectToXyxy(rect: Rect) {
  return [
    rect.x - rect.width / 2,
    rect.y - rect.height / 2,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  ] as const;
}

export function xyxyToRect(xyxy: readonly number[]): Rect {
  const [x1, y1, x2, y2] = xyxy as readonly [number, number, number, number];
  return {
    height: Math.max(Number.EPSILON, y2 - y1),
    width: Math.max(Number.EPSILON, x2 - x1),
    x: (x1 + x2) / 2,
    y: (y1 + y2) / 2,
  };
}

export function rectToMeasurement(
  rect: Rect,
  representation: TrackingStateRepresentation,
) {
  if (representation === "xcycwh") {
    return [rect.x, rect.y, rect.width, rect.height];
  }
  return [
    rect.x,
    rect.y,
    rect.width * rect.height,
    rect.width / (rect.height + 1e-6),
  ];
}

export function measurementToRect(
  measurement: readonly number[],
  representation: TrackingStateRepresentation,
): Rect {
  const [x, y, third, fourth] = measurement as readonly [
    number,
    number,
    number,
    number,
  ];
  if (representation === "xcycwh") {
    return {
      height: Math.max(1e-3, fourth),
      width: Math.max(1e-3, third),
      x,
      y,
    };
  }

  const width = Math.sqrt(third * fourth);
  const height = width === 0 ? 0 : third / width;
  return {
    height: Math.max(Number.EPSILON, height),
    width: Math.max(Number.EPSILON, width),
    x,
    y,
  };
}

export function diagonal(values: readonly number[]): Matrix {
  return values.map((value, row) =>
    values.map((_, column) => (row === column ? value : 0)),
  );
}

export function scaleMatrix(matrix: Matrix, factor: number) {
  return scale(matrix, factor);
}

function clone(matrix: Matrix): Matrix {
  return matrix.map((row) => [...row]);
}
