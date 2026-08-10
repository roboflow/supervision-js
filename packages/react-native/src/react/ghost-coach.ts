import type {
  DetectionFrame,
  KeypointDrawInstruction,
  KeypointMarkerShape,
} from "supervision-js-core";

/**
 * A small, renderer-neutral temporal layer for a single-athlete pose demo.
 * It intentionally stores only normalized landmarks: no camera frames leave
 * the native inference lane and the replay remains a semantic vector replay.
 */
export type ReactNativeGhostCoachIntent =
  "idle" | "capture" | "coach" | "replay";

export interface ReactNativeGhostCoachReference {
  readonly samples: readonly ReactNativeGhostCoachSample[];
}

export interface ReactNativeGhostCoachSample {
  readonly phase: number;
  readonly points: readonly ReactNativeGhostCoachPoint[];
}

export interface ReactNativeGhostCoachPoint {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
}

export interface ReactNativeGhostCoachOptions {
  readonly active: boolean;
  readonly captureDurationMs?: number;
  readonly intent: ReactNativeGhostCoachIntent;
  readonly reference: ReactNativeGhostCoachReference | null;
  /** A normalized phase (0 standing, 1 deepest) used by the vector-only lab. */
  readonly replayPhase?: number;
}

export interface ReactNativeGhostCoachRuntime {
  readonly cue: string;
  readonly match: number;
  readonly phase: number;
  readonly repCount: number;
  readonly status:
    "finding-athlete" | "ready" | "capturing" | "coaching" | "replay";
}

export interface ReactNativeGhostCoachResult {
  readonly keypoints: readonly KeypointDrawInstruction[];
  readonly reference: ReactNativeGhostCoachReference | null;
  readonly runtime: ReactNativeGhostCoachRuntime;
}

export interface ReactNativeGhostCoachState {
  captureStartedAt: number;
  captureSamples: ReactNativeGhostCoachSample[];
  lastIntent: ReactNativeGhostCoachIntent;
  lastPhase: number;
  lastRepWasDeep: boolean;
  reference: ReactNativeGhostCoachReference | null;
  repCount: number;
}

const EMPTY_RUNTIME: ReactNativeGhostCoachRuntime = {
  cue: "Step into frame",
  match: 0,
  phase: 0,
  repCount: 0,
  status: "finding-athlete",
};

export function createReactNativeGhostCoachState(): ReactNativeGhostCoachState {
  "worklet";
  return {
    captureStartedAt: 0,
    captureSamples: [],
    lastIntent: "idle",
    lastPhase: 0,
    lastRepWasDeep: false,
    reference: null,
    repCount: 0,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  "worklet";
  return Math.max(minimum, Math.min(maximum, value));
}

function angle(
  a: ReactNativeGhostCoachPoint,
  b: ReactNativeGhostCoachPoint,
  c: ReactNativeGhostCoachPoint,
) {
  "worklet";
  const abX = a.x - b.x;
  const abY = a.y - b.y;
  const cbX = c.x - b.x;
  const cbY = c.y - b.y;
  const denominator =
    Math.sqrt(abX * abX + abY * abY) * Math.sqrt(cbX * cbX + cbY * cbY);
  if (denominator < 0.001) return 180;
  const cosine = clamp((abX * cbX + abY * cbY) / denominator, -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

function poseFromFrame(
  frame: DetectionFrame,
): ReactNativeGhostCoachPoint[] | null {
  "worklet";
  const detection = frame.detections[0];
  const geometry = detection?.keypoints;
  if (!geometry || geometry.points.length < 17) return null;
  const points: ReactNativeGhostCoachPoint[] = [];
  for (let index = 0; index < geometry.points.length; index += 1) {
    const point = geometry.points[index]!;
    points[index] = {
      visible: geometry.visibility?.[index] !== 0,
      x: point.x,
      y: point.y,
    };
  }
  return points;
}

function posePhase(points: readonly ReactNativeGhostCoachPoint[]) {
  "worklet";
  const left =
    points[11]?.visible && points[13]?.visible && points[15]?.visible
      ? angle(points[11]!, points[13]!, points[15]!)
      : null;
  const right =
    points[12]?.visible && points[14]?.visible && points[16]?.visible
      ? angle(points[12]!, points[14]!, points[16]!)
      : null;
  const degrees =
    left !== null && right !== null
      ? (left + right) / 2
      : (left ?? right ?? 180);
  // A deliberately forgiving squat signal. This demo is a self-comparison,
  // not a medical or universal form judgement.
  return clamp((178 - degrees) / 92, 0, 1);
}

function normalizePose(points: readonly ReactNativeGhostCoachPoint[]) {
  "worklet";
  const leftHip = points[11];
  const rightHip = points[12];
  const leftShoulder = points[5];
  const rightShoulder = points[6];
  const anchorX = ((leftHip?.x ?? 0) + (rightHip?.x ?? 0)) / 2;
  const anchorY = ((leftHip?.y ?? 0) + (rightHip?.y ?? 0)) / 2;
  const shoulderY =
    ((leftShoulder?.y ?? anchorY - 100) + (rightShoulder?.y ?? anchorY - 100)) /
    2;
  const scale = Math.max(32, Math.abs(anchorY - shoulderY));
  const normalized: ReactNativeGhostCoachPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    normalized[index] = {
      visible: point.visible,
      x: (point.x - anchorX) / scale,
      y: (point.y - anchorY) / scale,
    };
  }
  return normalized;
}

function findSample(reference: ReactNativeGhostCoachReference, phase: number) {
  "worklet";
  let closest = reference.samples[0]!;
  let distance = Math.abs(closest.phase - phase);
  for (let index = 1; index < reference.samples.length; index += 1) {
    const candidate = reference.samples[index]!;
    const nextDistance = Math.abs(candidate.phase - phase);
    if (nextDistance < distance) {
      closest = candidate;
      distance = nextDistance;
    }
  }
  return closest;
}

function toInstruction(
  normalized: readonly ReactNativeGhostCoachPoint[],
  current: readonly ReactNativeGhostCoachPoint[],
  color: number,
  alpha: number,
): KeypointDrawInstruction {
  "worklet";
  const currentNormalized = normalizePose(current);
  const leftHip = current[11];
  const rightHip = current[12];
  const anchorX = ((leftHip?.x ?? 0) + (rightHip?.x ?? 0)) / 2;
  const anchorY = ((leftHip?.y ?? 0) + (rightHip?.y ?? 0)) / 2;
  const currentScale = Math.max(
    32,
    Math.abs(
      (current[5]?.y ?? anchorY - 100) +
        (current[6]?.y ?? anchorY - 100) -
        anchorY * 2,
    ) / 2,
  );
  const mapped: ReactNativeGhostCoachPoint[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const point = normalized[index]!;
    mapped[index] = {
      visible: point.visible,
      x: anchorX + point.x * currentScale,
      y: anchorY + point.y * currentScale,
    };
  }
  const edges: Array<KeypointDrawInstruction["edges"][number]> = [];
  const pairs = [
    [5, 6],
    [5, 7],
    [7, 9],
    [6, 8],
    [8, 10],
    [5, 11],
    [6, 12],
    [11, 12],
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16],
  ] as const;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!;
    const from = mapped[pair[0]];
    const to = mapped[pair[1]];
    if (from?.visible && to?.visible)
      edges[edges.length] = { from, to, stroke: { alpha, color, width: 4 } };
  }
  const markers: Array<KeypointDrawInstruction["markers"][number]> = [];
  for (let index = 0; index < mapped.length; index += 1) {
    const point = mapped[index]!;
    if (point.visible)
      markers[markers.length] = {
        fill: { alpha, color },
        index,
        point,
        radius: 4,
        // Worklets capture the string rather than a runtime enum object.
        shape: "circle" as KeypointMarkerShape,
        stroke: { alpha, color, width: 1 },
      };
  }
  // Kept to make the intent explicit to worklet compilers and avoid losing
  // the normalization calculation when this code gets optimized differently.
  void currentNormalized;
  return { edges, markers };
}

function matchScore(
  reference: ReactNativeGhostCoachSample,
  current: readonly ReactNativeGhostCoachPoint[],
) {
  "worklet";
  const normalized = normalizePose(current);
  let count = 0;
  let distance = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const expected = reference.points[index];
    const observed = normalized[index];
    if (!expected?.visible || !observed?.visible) continue;
    const dx = expected.x - observed.x;
    const dy = expected.y - observed.y;
    distance += Math.sqrt(dx * dx + dy * dy);
    count += 1;
  }
  return count === 0
    ? 0
    : Math.round(clamp(100 - (distance / count) * 90, 0, 100));
}

export function evaluateReactNativeGhostCoach(options: {
  readonly config: ReactNativeGhostCoachOptions;
  readonly frame: DetectionFrame;
  readonly nowMs: number;
  readonly state: ReactNativeGhostCoachState;
}): ReactNativeGhostCoachResult {
  "worklet";
  const current = poseFromFrame(options.frame);
  if (!options.config.active || !current)
    return {
      keypoints: [],
      reference: options.config.reference,
      runtime: EMPTY_RUNTIME,
    };
  const phase = posePhase(current);
  const state = options.state;
  let reference = options.config.reference ?? state.reference;

  if (options.config.intent === "capture" && state.lastIntent !== "capture") {
    state.captureStartedAt = options.nowMs;
    state.captureSamples = [];
  }
  if (options.config.intent === "capture") {
    if (
      state.captureSamples.length < 40 &&
      (state.captureSamples.length === 0 ||
        options.nowMs - state.captureStartedAt >
          state.captureSamples.length * 55)
    ) {
      state.captureSamples[state.captureSamples.length] = {
        phase,
        points: normalizePose(current),
      };
    }
    const complete =
      options.nowMs - state.captureStartedAt >=
        (options.config.captureDurationMs ?? 2200) &&
      state.captureSamples.length >= 8;
    if (complete) {
      reference = { samples: state.captureSamples };
      state.reference = reference;
    }
    state.lastIntent = options.config.intent;
    return {
      keypoints: [],
      reference,
      runtime: {
        cue: complete
          ? "Ghost learned. Start your set."
          : "Teaching your movement…",
        match: 0,
        phase,
        repCount: state.repCount,
        status: complete ? "ready" : "capturing",
      },
    };
  }

  if (!reference || reference.samples.length === 0) {
    state.lastIntent = options.config.intent;
    return { keypoints: [], reference, runtime: { ...EMPTY_RUNTIME, phase } };
  }
  const requestedPhase =
    options.config.intent === "replay"
      ? (options.config.replayPhase ?? phase)
      : phase;
  const target = findSample(reference, requestedPhase);
  const vectors: KeypointDrawInstruction[] = [];
  // The translucent echoes are prior phase samples, never buffered imagery.
  for (let offset = 0; offset < 2; offset += 1) {
    const echo = findSample(
      reference,
      clamp(requestedPhase - (offset + 1) * 0.16, 0, 1),
    );
    vectors[vectors.length] = toInstruction(
      echo.points,
      current,
      0x8b5cf6,
      0.18 - offset * 0.05,
    );
  }
  vectors[vectors.length] = toInstruction(
    target.points,
    current,
    0x6ee7b7,
    0.8,
  );
  const match = matchScore(target, current);
  if (options.config.intent === "coach") {
    if (phase > 0.68) state.lastRepWasDeep = true;
    if (state.lastRepWasDeep && phase < 0.22 && state.lastPhase >= 0.22) {
      state.repCount += 1;
      state.lastRepWasDeep = false;
    }
  }
  state.lastPhase = phase;
  state.lastIntent = options.config.intent;
  const cue =
    match >= 82
      ? "Locked in — keep that rhythm"
      : phase > 0.65
        ? "Drive through the floor"
        : "Match the mint ghost";
  return {
    keypoints: vectors,
    reference,
    runtime: {
      cue,
      match,
      phase,
      repCount: state.repCount,
      status:
        options.config.intent === "replay"
          ? "replay"
          : options.config.intent === "coach"
            ? "coaching"
            : "ready",
    },
  };
}
