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

export type InstantCvZoneShape = "rectangle" | "free-shape";

export interface InstantCvRectangleZone {
  readonly kind: "rectangle";
  readonly rect: InstantCvNormalizedRect;
}

export interface InstantCvPolygonZone {
  readonly kind: "polygon";
  readonly points: readonly InstantCvNormalizedPoint[];
}

export type InstantCvZone = InstantCvRectangleZone | InstantCvPolygonZone;

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
  readonly zone: InstantCvZone;
}

export interface InstantCvClearToStartRule extends InstantCvRuleBase {
  readonly className: string;
  readonly recipe: "clear-to-start";
  readonly zone: InstantCvZone;
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

function instantCvZonePoints(zone: InstantCvZone) {
  "worklet";

  if (zone.kind === "polygon") {
    return zone.points;
  }

  const { rect } = zone;

  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function instantCvPointInZone(
  point: InstantCvNormalizedPoint,
  zone: InstantCvZone,
) {
  "worklet";

  if (zone.kind === "rectangle") {
    return instantCvPointInRect(point, zone.rect);
  }

  let inside = false;
  const points = zone.points;

  for (
    let index = 0, previousIndex = points.length - 1;
    index < points.length;
    previousIndex = index, index += 1
  ) {
    const current = points[index]!;
    const previous = points[previousIndex]!;
    const crosses =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;

    if (crosses) {
      inside = !inside;
    }
  }

  return inside;
}

function instantCvZoneBounds(zone: InstantCvZone): InstantCvNormalizedRect {
  "worklet";

  if (zone.kind === "rectangle") {
    return zone.rect;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < zone.points.length; index += 1) {
    const point = zone.points[index]!;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  if (!Number.isFinite(minX)) {
    return { height: 0, width: 0, x: 0, y: 0 };
  }

  return { height: maxY - minY, width: maxX - minX, x: minX, y: minY };
}

function instantCvMaskContainsFramePoint(
  object: InstantCvObjectDetection,
  framePoint: InstantCvNormalizedPoint,
  frameWidth: number,
  frameHeight: number,
) {
  "worklet";

  const mask = object.mask;
  const maskWidth = object.maskWidth ?? 0;
  const maskHeight = object.maskHeight ?? 0;
  const boxWidth = object.bbox.x2 - object.bbox.x1;
  const boxHeight = object.bbox.y2 - object.bbox.y1;
  const x = framePoint.x * frameWidth;
  const y = framePoint.y * frameHeight;

  if (
    !mask ||
    maskWidth <= 0 ||
    maskHeight <= 0 ||
    mask.length < maskWidth * maskHeight ||
    boxWidth <= 0 ||
    boxHeight <= 0 ||
    x < object.bbox.x1 ||
    x > object.bbox.x2 ||
    y < object.bbox.y1 ||
    y > object.bbox.y2
  ) {
    return false;
  }

  const maskX = Math.min(
    maskWidth - 1,
    Math.max(0, Math.floor(((x - object.bbox.x1) / boxWidth) * maskWidth)),
  );
  const maskY = Math.min(
    maskHeight - 1,
    Math.max(0, Math.floor(((y - object.bbox.y1) / boxHeight) * maskHeight)),
  );

  return Boolean(mask[maskY * maskWidth + maskX]);
}

function instantCvObjectOverlapsZone(
  object: InstantCvObjectDetection,
  zone: InstantCvZone,
  frameWidth: number,
  frameHeight: number,
) {
  "worklet";

  if (frameWidth <= 0 || frameHeight <= 0) {
    return false;
  }

  const bounds = instantCvZoneBounds(zone);
  const intersectionX1 = Math.max(object.bbox.x1, bounds.x * frameWidth);
  const intersectionY1 = Math.max(object.bbox.y1, bounds.y * frameHeight);
  const intersectionX2 = Math.min(
    object.bbox.x2,
    (bounds.x + bounds.width) * frameWidth,
  );
  const intersectionY2 = Math.min(
    object.bbox.y2,
    (bounds.y + bounds.height) * frameHeight,
  );

  if (intersectionX2 <= intersectionX1 || intersectionY2 <= intersectionY1) {
    return false;
  }

  const mask = object.mask;
  const maskWidth = object.maskWidth ?? 0;
  const maskHeight = object.maskHeight ?? 0;
  const boxWidth = object.bbox.x2 - object.bbox.x1;
  const boxHeight = object.bbox.y2 - object.bbox.y1;
  const validMask =
    mask &&
    maskWidth > 0 &&
    maskHeight > 0 &&
    mask.length >= maskWidth * maskHeight &&
    boxWidth > 0 &&
    boxHeight > 0;

  // Missing masks fall back conservatively to bbox/bounds overlap. Both live
  // Instant recipes normally receive RF-DETR masks, so this is only a safety
  // net for producer errors or alternate segmentation producers.
  if (!validMask) {
    return true;
  }

  const zonePoints = instantCvZonePoints(zone);

  for (let index = 0; index < zonePoints.length; index += 1) {
    if (
      instantCvMaskContainsFramePoint(
        object,
        zonePoints[index]!,
        frameWidth,
        frameHeight,
      )
    ) {
      return true;
    }
  }

  const maskX1 = Math.max(
    0,
    Math.floor(((intersectionX1 - object.bbox.x1) / boxWidth) * maskWidth),
  );
  const maskY1 = Math.max(
    0,
    Math.floor(((intersectionY1 - object.bbox.y1) / boxHeight) * maskHeight),
  );
  const maskX2 = Math.min(
    maskWidth - 1,
    Math.ceil(((intersectionX2 - object.bbox.x1) / boxWidth) * maskWidth),
  );
  const maskY2 = Math.min(
    maskHeight - 1,
    Math.ceil(((intersectionY2 - object.bbox.y1) / boxHeight) * maskHeight),
  );
  const regionArea =
    Math.max(1, maskX2 - maskX1 + 1) * Math.max(1, maskY2 - maskY1 + 1);
  const stride = Math.max(1, Math.ceil(Math.sqrt(regionArea / 576)));

  for (let maskY = maskY1; maskY <= maskY2; maskY += stride) {
    for (let maskX = maskX1; maskX <= maskX2; maskX += stride) {
      if (!mask[maskY * maskWidth + maskX]) {
        continue;
      }

      const point = {
        x:
          (object.bbox.x1 + ((maskX + 0.5) / maskWidth) * boxWidth) /
          frameWidth,
        y:
          (object.bbox.y1 + ((maskY + 0.5) / maskHeight) * boxHeight) /
          frameHeight,
      };

      if (instantCvPointInZone(point, zone)) {
        return true;
      }
    }
  }

  return false;
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
  objects: readonly InstantCvObjectDetection[],
  frameWidth: number,
  frameHeight: number,
) {
  "worklet";

  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index]!;

    if (
      object.label === "person" &&
      instantCvObjectOverlapsZone(object, rule.zone, frameWidth, frameHeight)
    ) {
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

    if (
      instantCvObjectOverlapsZone(object, rule.zone, frameWidth, frameHeight)
    ) {
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
              objects,
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

    const normalizedZonePoints = instantCvZonePoints(rule.zone);
    const zonePoints: InstantCvNormalizedPoint[] = [];

    for (
      let pointIndex = 0;
      pointIndex < normalizedZonePoints.length;
      pointIndex += 1
    ) {
      const point = normalizedZonePoints[pointIndex]!;
      zonePoints[pointIndex] = {
        x: point.x * options.frameWidth,
        y: point.y * options.frameHeight,
      };
    }

    polygons[polygons.length] = {
      fill: { alpha: 0.12, color },
      points: zonePoints,
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

export function createInstantCvRectangleZone(
  start: InstantCvNormalizedPoint,
  end: InstantCvNormalizedPoint,
): InstantCvRectangleZone {
  return { kind: "rectangle", rect: normalizeInstantCvRect(start, end) };
}

export function createInstantCvFreeShapeZone(
  inputPoints: readonly InstantCvNormalizedPoint[],
): InstantCvPolygonZone | null {
  const points: InstantCvNormalizedPoint[] = [];

  for (let index = 0; index < inputPoints.length; index += 1) {
    const input = inputPoints[index]!;
    const point = {
      x: Math.max(0, Math.min(1, input.x)),
      y: Math.max(0, Math.min(1, input.y)),
    };
    const previous = points[points.length - 1];

    if (
      previous &&
      Math.hypot(point.x - previous.x, point.y - previous.y) < 0.004
    ) {
      continue;
    }

    points[points.length] = point;

    if (points.length >= 64) {
      break;
    }
  }

  if (points.length < 3) {
    return null;
  }

  let twiceArea = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += point.x * next.y - next.x * point.y;
  }

  if (Math.abs(twiceArea) < 0.002) {
    return null;
  }

  return { kind: "polygon", points };
}

export function getInstantCvZonePoints(zone: InstantCvZone) {
  "worklet";

  return instantCvZonePoints(zone);
}
