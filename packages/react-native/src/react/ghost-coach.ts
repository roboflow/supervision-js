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
  "idle" | "recording" | "finish-recording" | "coach" | "replay";

export interface ReactNativeGhostCoachReference {
  readonly samples: readonly ReactNativeGhostCoachSample[];
}

export interface ReactNativeGhostCoachSample {
  /** Position in the user-recorded sequence, from 0 to 1. */
  readonly position: number;
  readonly points: readonly ReactNativeGhostCoachPoint[];
}

export interface ReactNativeGhostCoachPoint {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
}

export interface ReactNativeGhostCoachOptions {
  readonly active: boolean;
  readonly intent: ReactNativeGhostCoachIntent;
  readonly reference: ReactNativeGhostCoachReference | null;
  /** A normalized sequence position used by the vector-only Rep Lab. */
  readonly replayPosition?: number;
}

export interface ReactNativeGhostCoachRuntime {
  readonly cue: string;
  readonly match: number;
  readonly progress: number;
  readonly sampleCount: number;
  readonly status:
    | "finding-athlete"
    | "ready"
    | "recording"
    | "needs-more-poses"
    | "coaching"
    | "replay";
}

export interface ReactNativeGhostCoachResult {
  readonly keypoints: readonly KeypointDrawInstruction[];
  readonly reference: ReactNativeGhostCoachReference | null;
  readonly runtime: ReactNativeGhostCoachRuntime;
}

export interface ReactNativeGhostCoachState {
  captureSamples: ReactNativeGhostCoachSample[];
  lastIntent: ReactNativeGhostCoachIntent;
  lastRecordedAt: number;
  recordingIntervalMs: number;
  reference: ReactNativeGhostCoachReference | null;
}

const EMPTY_RUNTIME: ReactNativeGhostCoachRuntime = {
  cue: "Step into frame",
  match: 0,
  progress: 0,
  sampleCount: 0,
  status: "finding-athlete",
};

export function createReactNativeGhostCoachState(): ReactNativeGhostCoachState {
  "worklet";
  return {
    captureSamples: [],
    lastIntent: "idle",
    lastRecordedAt: 0,
    recordingIntervalMs: 55,
    reference: null,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  "worklet";
  return Math.max(minimum, Math.min(maximum, value));
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

function sampleDistance(
  sample: ReactNativeGhostCoachSample,
  normalized: readonly ReactNativeGhostCoachPoint[],
) {
  "worklet";
  let count = 0;
  let distance = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const expected = sample.points[index];
    const observed = normalized[index];
    if (!expected?.visible || !observed?.visible) continue;
    const x = expected.x - observed.x;
    const y = expected.y - observed.y;
    distance += Math.sqrt(x * x + y * y);
    count += 1;
  }
  return count === 0 ? Number.POSITIVE_INFINITY : distance / count;
}

function findClosestSampleIndex(
  reference: ReactNativeGhostCoachReference,
  normalized: readonly ReactNativeGhostCoachPoint[],
) {
  "worklet";
  let closestIndex = 0;
  let closestDistance = sampleDistance(reference.samples[0]!, normalized);
  for (let index = 1; index < reference.samples.length; index += 1) {
    const distance = sampleDistance(reference.samples[index]!, normalized);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }
  return closestIndex;
}

function toInstruction(
  normalized: readonly ReactNativeGhostCoachPoint[],
  current: readonly ReactNativeGhostCoachPoint[],
  color: number,
  alpha: number,
): KeypointDrawInstruction {
  "worklet";
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
  return { edges, markers };
}

function matchScore(
  reference: ReactNativeGhostCoachSample,
  current: readonly ReactNativeGhostCoachPoint[],
) {
  "worklet";
  const normalized = normalizePose(current);
  const distance = sampleDistance(reference, normalized);
  return Number.isFinite(distance)
    ? Math.round(clamp(100 - distance * 90, 0, 100))
    : 0;
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
  const state = options.state;
  let reference = options.config.reference ?? state.reference;

  if (
    options.config.intent === "recording" &&
    state.lastIntent !== "recording"
  ) {
    state.captureSamples = [];
    state.lastRecordedAt = 0;
    state.recordingIntervalMs = 55;
  }
  if (options.config.intent === "recording") {
    if (state.captureSamples.length >= 80) {
      // Keep the whole user-bounded take without allowing unbounded worklet memory.
      const samples: ReactNativeGhostCoachSample[] = [];
      for (let index = 0; index < state.captureSamples.length; index += 2) {
        samples[samples.length] = state.captureSamples[index]!;
      }
      state.captureSamples = samples;
      state.recordingIntervalMs *= 2;
    }
    if (
      state.lastRecordedAt === 0 ||
      options.nowMs - state.lastRecordedAt >= state.recordingIntervalMs
    ) {
      state.captureSamples[state.captureSamples.length] = {
        position: 0,
        points: normalizePose(current),
      };
      state.lastRecordedAt = options.nowMs;
    }
    state.lastIntent = options.config.intent;
    return {
      keypoints: [],
      reference,
      runtime: {
        cue: "Recording your movement — finish whenever you are ready.",
        match: 0,
        progress: 0,
        sampleCount: state.captureSamples.length,
        status: "recording",
      },
    };
  }

  if (options.config.intent === "finish-recording") {
    if (state.captureSamples.length >= 8) {
      const samples: ReactNativeGhostCoachSample[] = [];
      const lastIndex = Math.max(1, state.captureSamples.length - 1);
      for (let index = 0; index < state.captureSamples.length; index += 1) {
        const sample = state.captureSamples[index]!;
        samples[index] = {
          position: index / lastIndex,
          points: sample.points,
        };
      }
      reference = { samples };
      state.reference = reference;
      state.lastIntent = options.config.intent;
      return {
        keypoints: [],
        reference,
        runtime: {
          cue: "Reference ready. Compare live when you are ready.",
          match: 0,
          progress: 0,
          sampleCount: samples.length,
          status: "ready",
        },
      };
    }
    state.lastIntent = options.config.intent;
    return {
      keypoints: [],
      reference,
      runtime: {
        cue: "Keep recording a little longer so the ghost has enough poses.",
        match: 0,
        progress: 0,
        sampleCount: state.captureSamples.length,
        status: "needs-more-poses",
      },
    };
  }

  if (!reference || reference.samples.length === 0) {
    state.lastIntent = options.config.intent;
    return { keypoints: [], reference, runtime: EMPTY_RUNTIME };
  }
  const normalized = normalizePose(current);
  const targetIndex =
    options.config.intent === "replay"
      ? Math.round(
          clamp(options.config.replayPosition ?? 0, 0, 1) *
            (reference.samples.length - 1),
        )
      : findClosestSampleIndex(reference, normalized);
  const target = reference.samples[targetIndex]!;
  const vectors: KeypointDrawInstruction[] = [];
  // The translucent echoes are prior recorded poses, never buffered imagery.
  for (let offset = 0; offset < 2; offset += 1) {
    const echo =
      reference.samples[Math.max(0, targetIndex - (offset + 1) * 3)]!;
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
  state.lastIntent = options.config.intent;
  const cue =
    match >= 82 ? "Locked in — keep that shape" : "Match the mint ghost";
  return {
    keypoints: vectors,
    reference,
    runtime: {
      cue,
      match,
      progress: target.position,
      sampleCount: reference.samples.length,
      status:
        options.config.intent === "replay"
          ? "replay"
          : options.config.intent === "coach"
            ? "coaching"
            : "ready",
    },
  };
}
