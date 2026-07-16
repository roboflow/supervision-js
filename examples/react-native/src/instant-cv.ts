export type InstantCvRecipe = "golden-pose" | "safety-zone" | "clear-to-start";

export type InstantCvRuleStatus = "unknown" | "evaluating" | "pass" | "fail";

export interface InstantCvNormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface InstantCvNormalizedRect extends InstantCvNormalizedPoint {
  readonly height: number;
  readonly width: number;
}

export interface InstantCvPosePoint {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
}

export interface InstantCvPoseDetection {
  readonly points: readonly InstantCvPosePoint[];
}

export interface InstantCvObjectDetection {
  readonly bbox: {
    readonly x1: number;
    readonly x2: number;
    readonly y1: number;
    readonly y2: number;
  };
  readonly label: string;
  readonly mask?: Uint8Array;
  readonly maskHeight?: number;
  readonly maskWidth?: number;
}

interface InstantCvRuleBase {
  readonly dwellMs: number;
  readonly id: string;
  readonly recipe: InstantCvRecipe;
}

export interface InstantCvGoldenPoseRule extends InstantCvRuleBase {
  readonly baselineAngles: readonly number[];
  readonly baselinePoints: readonly InstantCvPosePoint[];
  readonly recipe: "golden-pose";
  readonly toleranceDegrees: number;
}

export interface InstantCvSafetyZoneRule extends InstantCvRuleBase {
  readonly recipe: "safety-zone";
  readonly zone: InstantCvNormalizedRect;
}

export interface InstantCvClearToStartRule extends InstantCvRuleBase {
  readonly className: string;
  readonly recipe: "clear-to-start";
  readonly zone: InstantCvNormalizedRect;
}

export type InstantCvRule =
  InstantCvGoldenPoseRule | InstantCvSafetyZoneRule | InstantCvClearToStartRule;

export interface InstantCvRuleRuntime {
  readonly candidate: Exclude<InstantCvRuleStatus, "evaluating">;
  readonly candidateSinceMs: number;
  readonly id: string;
  readonly score?: number;
  readonly status: InstantCvRuleStatus;
}

export interface InstantCvEvaluationOptions {
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly nowMs: number;
  readonly objects?: readonly InstantCvObjectDetection[];
  readonly poses?: readonly InstantCvPoseDetection[];
  readonly previous: readonly InstantCvRuleRuntime[];
  readonly rules: readonly InstantCvRule[];
}

export interface InstantCvObjectPick {
  readonly detectionIndex: number;
  readonly label: string;
  readonly usedMask: boolean;
}

export interface InstantCvRuleVectorInstructions<
  TMarkerShape extends string = string,
> {
  readonly keypoints: readonly {
    readonly edges: readonly {
      readonly from: InstantCvNormalizedPoint;
      readonly stroke: {
        readonly alpha: number;
        readonly color: number;
        readonly width: number;
      };
      readonly to: InstantCvNormalizedPoint;
    }[];
    readonly markers: readonly {
      readonly fill: { readonly alpha: number; readonly color: number };
      readonly index: number;
      readonly point: InstantCvNormalizedPoint;
      readonly radius: number;
      readonly shape: TMarkerShape;
    }[];
  }[];
  readonly polygons: readonly {
    readonly fill: { readonly alpha: number; readonly color: number };
    readonly points: readonly InstantCvNormalizedPoint[];
    readonly stroke: {
      readonly alpha: number;
      readonly color: number;
      readonly width: number;
    };
  }[];
}

const INSTANT_CV_POSE_ANGLE_TRIPLETS = [
  [5, 7, 9],
  [6, 8, 10],
  [11, 13, 15],
  [12, 14, 16],
  [5, 11, 13],
  [6, 12, 14],
] as const;

const INSTANT_CV_SKELETON_EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
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

function instantCvPointIsVisible(
  point: InstantCvPosePoint | undefined,
): point is InstantCvPosePoint {
  "worklet";

  return Boolean(
    point?.visible && Number.isFinite(point.x) && Number.isFinite(point.y),
  );
}

function instantCvAngleDegrees(
  first: InstantCvPosePoint,
  center: InstantCvPosePoint,
  last: InstantCvPosePoint,
) {
  "worklet";

  const firstX = first.x - center.x;
  const firstY = first.y - center.y;
  const lastX = last.x - center.x;
  const lastY = last.y - center.y;
  const denominator = Math.hypot(firstX, firstY) * Math.hypot(lastX, lastY);

  if (denominator <= 0.000001) {
    return null;
  }

  const cosine = Math.max(
    -1,
    Math.min(1, (firstX * lastX + firstY * lastY) / denominator),
  );

  return (Math.acos(cosine) * 180) / Math.PI;
}

function instantCvPoseAngles(points: readonly InstantCvPosePoint[]) {
  "worklet";

  const angles: number[] = [];

  for (
    let index = 0;
    index < INSTANT_CV_POSE_ANGLE_TRIPLETS.length;
    index += 1
  ) {
    const [firstIndex, centerIndex, lastIndex] =
      INSTANT_CV_POSE_ANGLE_TRIPLETS[index]!;
    const first = points[firstIndex];
    const center = points[centerIndex];
    const last = points[lastIndex];

    if (
      !instantCvPointIsVisible(first) ||
      !instantCvPointIsVisible(center) ||
      !instantCvPointIsVisible(last)
    ) {
      return null;
    }

    const angle = instantCvAngleDegrees(first, center, last);

    if (angle === null) {
      return null;
    }

    angles[index] = angle;
  }

  return angles;
}

function instantCvMeanAngleDelta(
  left: readonly number[],
  right: readonly number[],
) {
  "worklet";

  if (left.length === 0 || left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }

  let total = 0;

  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index]! - right[index]!);
  }

  return total / left.length;
}

function instantCvPointInRect(
  point: InstantCvNormalizedPoint,
  rect: InstantCvNormalizedRect,
) {
  "worklet";

  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function instantCvPoseAnchor(
  pose: InstantCvPoseDetection,
  frameWidth: number,
  frameHeight: number,
) {
  "worklet";

  const leftAnkle = pose.points[15];
  const rightAnkle = pose.points[16];
  const leftHip = pose.points[11];
  const rightHip = pose.points[12];
  const first =
    instantCvPointIsVisible(leftAnkle) && instantCvPointIsVisible(rightAnkle)
      ? leftAnkle
      : leftHip;
  const second =
    instantCvPointIsVisible(leftAnkle) && instantCvPointIsVisible(rightAnkle)
      ? rightAnkle
      : rightHip;

  if (
    !instantCvPointIsVisible(first) ||
    !instantCvPointIsVisible(second) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return null;
  }

  return {
    x: (first.x + second.x) / 2 / frameWidth,
    y: (first.y + second.y) / 2 / frameHeight,
  };
}

function instantCvFindPreviousRuntime(
  previous: readonly InstantCvRuleRuntime[],
  id: string,
) {
  "worklet";

  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]?.id === id) {
      return previous[index]!;
    }
  }

  return undefined;
}

function instantCvApplyDwell(
  rule: InstantCvRule,
  candidate: Exclude<InstantCvRuleStatus, "evaluating">,
  nowMs: number,
  previous: InstantCvRuleRuntime | undefined,
  score?: number,
): InstantCvRuleRuntime {
  "worklet";

  if (candidate === "unknown") {
    return {
      candidate,
      candidateSinceMs: nowMs,
      id: rule.id,
      score,
      status: "unknown",
    };
  }

  const candidateSinceMs =
    previous?.candidate === candidate ? previous.candidateSinceMs : nowMs;
  const stable = nowMs - candidateSinceMs >= Math.max(0, rule.dwellMs);

  return {
    candidate,
    candidateSinceMs,
    id: rule.id,
    score,
    status: stable ? candidate : "evaluating",
  };
}

function instantCvEvaluateGoldenPose(
  rule: InstantCvGoldenPoseRule,
  poses: readonly InstantCvPoseDetection[],
) {
  "worklet";

  let bestDelta = Number.POSITIVE_INFINITY;

  for (let index = 0; index < poses.length; index += 1) {
    const angles = instantCvPoseAngles(poses[index]!.points);

    if (!angles) {
      continue;
    }

    bestDelta = Math.min(
      bestDelta,
      instantCvMeanAngleDelta(rule.baselineAngles, angles),
    );
  }

  if (!Number.isFinite(bestDelta)) {
    return { candidate: "unknown" as const };
  }

  return {
    candidate:
      bestDelta <= rule.toleranceDegrees
        ? ("pass" as const)
        : ("fail" as const),
    score: bestDelta,
  };
}

function instantCvEvaluateSafetyZone(
  rule: InstantCvSafetyZoneRule,
  poses: readonly InstantCvPoseDetection[],
  frameWidth: number,
  frameHeight: number,
) {
  "worklet";

  for (let index = 0; index < poses.length; index += 1) {
    const anchor = instantCvPoseAnchor(poses[index]!, frameWidth, frameHeight);

    if (anchor && instantCvPointInRect(anchor, rule.zone)) {
      return { candidate: "fail" as const };
    }
  }

  return { candidate: "pass" as const };
}

function instantCvEvaluateClearToStart(
  rule: InstantCvClearToStartRule,
  objects: readonly InstantCvObjectDetection[],
  frameWidth: number,
  frameHeight: number,
) {
  "worklet";

  if (frameWidth <= 0 || frameHeight <= 0) {
    return { candidate: "unknown" as const };
  }

  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index]!;

    if (object.label !== rule.className) {
      continue;
    }

    const center = {
      x: (object.bbox.x1 + object.bbox.x2) / 2 / frameWidth,
      y: (object.bbox.y1 + object.bbox.y2) / 2 / frameHeight,
    };

    if (instantCvPointInRect(center, rule.zone)) {
      return { candidate: "fail" as const };
    }
  }

  return { candidate: "pass" as const };
}

export function createInstantCvGoldenPoseBaseline(
  points: readonly InstantCvPosePoint[],
) {
  "worklet";

  return instantCvPoseAngles(points);
}

export function evaluateInstantCvRules(
  options: InstantCvEvaluationOptions,
): InstantCvRuleRuntime[] {
  "worklet";

  const next: InstantCvRuleRuntime[] = [];
  const poses = options.poses ?? [];
  const objects = options.objects ?? [];
  const ruleCount = Math.min(8, options.rules.length);

  for (let index = 0; index < ruleCount; index += 1) {
    const rule = options.rules[index]!;
    const previous = instantCvFindPreviousRuntime(options.previous, rule.id);
    const evaluation =
      rule.recipe === "golden-pose"
        ? instantCvEvaluateGoldenPose(rule, poses)
        : rule.recipe === "safety-zone"
          ? instantCvEvaluateSafetyZone(
              rule,
              poses,
              options.frameWidth,
              options.frameHeight,
            )
          : instantCvEvaluateClearToStart(
              rule,
              objects,
              options.frameWidth,
              options.frameHeight,
            );

    next[index] = instantCvApplyDwell(
      rule,
      evaluation.candidate,
      options.nowMs,
      previous,
      "score" in evaluation ? evaluation.score : undefined,
    );
  }

  return next;
}

export function createInstantCvRuntimeSignature(
  runtime: readonly InstantCvRuleRuntime[],
) {
  "worklet";

  let signature = "";

  for (let index = 0; index < runtime.length; index += 1) {
    const entry = runtime[index]!;
    signature += `${entry.id}:${entry.status};`;
  }

  return signature;
}

function instantCvStatusColor(status: InstantCvRuleStatus) {
  "worklet";

  switch (status) {
    case "pass":
      return 0x57f287;
    case "fail":
      return 0xff5d73;
    case "evaluating":
      return 0xffd166;
    default:
      return 0x70e1f5;
  }
}

export function createInstantCvRuleVectorInstructions<
  TMarkerShape extends string,
>(options: {
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly markerShape: TMarkerShape;
  readonly rules: readonly InstantCvRule[];
  readonly runtime: readonly InstantCvRuleRuntime[];
}): InstantCvRuleVectorInstructions<TMarkerShape> {
  "worklet";

  const keypoints: InstantCvRuleVectorInstructions<TMarkerShape>["keypoints"][number][] =
    [];
  const polygons: InstantCvRuleVectorInstructions<TMarkerShape>["polygons"][number][] =
    [];
  const ruleCount = Math.min(8, options.rules.length);

  for (let ruleIndex = 0; ruleIndex < ruleCount; ruleIndex += 1) {
    const rule = options.rules[ruleIndex]!;
    const runtime = instantCvFindPreviousRuntime(options.runtime, rule.id);
    const color = instantCvStatusColor(runtime?.status ?? "unknown");

    if (rule.recipe === "golden-pose") {
      const edges: InstantCvRuleVectorInstructions<TMarkerShape>["keypoints"][number]["edges"][number][] =
        [];
      const markers: InstantCvRuleVectorInstructions<TMarkerShape>["keypoints"][number]["markers"][number][] =
        [];

      for (
        let edgeIndex = 0;
        edgeIndex < INSTANT_CV_SKELETON_EDGES.length;
        edgeIndex += 1
      ) {
        const [fromIndex, toIndex] = INSTANT_CV_SKELETON_EDGES[edgeIndex]!;
        const from = rule.baselinePoints[fromIndex];
        const to = rule.baselinePoints[toIndex];

        if (!from?.visible || !to?.visible) {
          continue;
        }

        edges[edges.length] = {
          from: {
            x: from.x * options.frameWidth,
            y: from.y * options.frameHeight,
          },
          stroke: { alpha: 0.72, color, width: 3 },
          to: {
            x: to.x * options.frameWidth,
            y: to.y * options.frameHeight,
          },
        };
      }

      for (
        let pointIndex = 0;
        pointIndex < rule.baselinePoints.length;
        pointIndex += 1
      ) {
        const point = rule.baselinePoints[pointIndex];

        if (!point?.visible) {
          continue;
        }

        markers[markers.length] = {
          fill: { alpha: 0.82, color },
          index: pointIndex,
          point: {
            x: point.x * options.frameWidth,
            y: point.y * options.frameHeight,
          },
          radius: 5,
          shape: options.markerShape,
        };
      }

      keypoints[keypoints.length] = { edges, markers };
      continue;
    }

    const x = rule.zone.x * options.frameWidth;
    const y = rule.zone.y * options.frameHeight;
    const width = rule.zone.width * options.frameWidth;
    const height = rule.zone.height * options.frameHeight;

    polygons[polygons.length] = {
      fill: { alpha: 0.12, color },
      points: [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ],
      stroke: { alpha: 0.98, color, width: 4 },
    };
  }

  return { keypoints, polygons };
}

export function pickInstantCvObjectAtPoint(options: {
  readonly detections: readonly InstantCvObjectDetection[];
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly point: InstantCvNormalizedPoint;
}): InstantCvObjectPick | null {
  "worklet";

  const frameX = options.point.x * options.frameWidth;
  const frameY = options.point.y * options.frameHeight;
  let maskPick: InstantCvObjectPick | null = null;
  let maskArea = Number.POSITIVE_INFINITY;
  let boxPick: InstantCvObjectPick | null = null;
  let boxArea = Number.POSITIVE_INFINITY;

  for (let index = 0; index < options.detections.length; index += 1) {
    const detection = options.detections[index]!;
    const width = detection.bbox.x2 - detection.bbox.x1;
    const height = detection.bbox.y2 - detection.bbox.y1;
    const area = width * height;
    const inside =
      width > 0 &&
      height > 0 &&
      frameX >= detection.bbox.x1 &&
      frameX <= detection.bbox.x2 &&
      frameY >= detection.bbox.y1 &&
      frameY <= detection.bbox.y2;

    if (!inside) {
      continue;
    }

    const maskWidth = detection.maskWidth ?? 0;
    const maskHeight = detection.maskHeight ?? 0;
    const mask = detection.mask;

    if (!mask || maskWidth <= 0 || maskHeight <= 0) {
      if (area < boxArea) {
        boxArea = area;
        boxPick = {
          detectionIndex: index,
          label: detection.label,
          usedMask: false,
        };
      }

      continue;
    }

    const maskX = Math.min(
      maskWidth - 1,
      Math.max(
        0,
        Math.floor(((frameX - detection.bbox.x1) / width) * maskWidth),
      ),
    );
    const maskY = Math.min(
      maskHeight - 1,
      Math.max(
        0,
        Math.floor(((frameY - detection.bbox.y1) / height) * maskHeight),
      ),
    );

    if (mask[maskY * maskWidth + maskX] && area < maskArea) {
      maskArea = area;
      maskPick = {
        detectionIndex: index,
        label: detection.label,
        usedMask: true,
      };
    }
  }

  return maskPick ?? boxPick;
}

export function pickInstantCvPoseAtPoint(options: {
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly point: InstantCvNormalizedPoint;
  readonly poses: readonly InstantCvPoseDetection[];
}) {
  "worklet";

  const frameX = options.point.x * options.frameWidth;
  const frameY = options.point.y * options.frameHeight;
  let pickedIndex = -1;
  let pickedArea = Number.POSITIVE_INFINITY;

  for (let index = 0; index < options.poses.length; index += 1) {
    const pose = options.poses[index]!;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (let pointIndex = 0; pointIndex < pose.points.length; pointIndex += 1) {
      const point = pose.points[pointIndex];

      if (!instantCvPointIsVisible(point)) {
        continue;
      }

      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const padding = Math.max(
      12,
      Math.min(options.frameWidth, options.frameHeight) * 0.025,
    );
    const width = maxX - minX;
    const height = maxY - minY;
    const area = width * height;

    if (
      Number.isFinite(area) &&
      frameX >= minX - padding &&
      frameX <= maxX + padding &&
      frameY >= minY - padding &&
      frameY <= maxY + padding &&
      area < pickedArea
    ) {
      pickedArea = area;
      pickedIndex = index;
    }
  }

  return pickedIndex;
}

export function normalizeInstantCvRect(
  start: InstantCvNormalizedPoint,
  end: InstantCvNormalizedPoint,
): InstantCvNormalizedRect {
  const x = Math.max(0, Math.min(1, Math.min(start.x, end.x)));
  const y = Math.max(0, Math.min(1, Math.min(start.y, end.y)));
  const maxX = Math.max(0, Math.min(1, Math.max(start.x, end.x)));
  const maxY = Math.max(0, Math.min(1, Math.max(start.y, end.y)));

  return {
    height: maxY - y,
    width: maxX - x,
    x,
    y,
  };
}
