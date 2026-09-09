#!/usr/bin/env node
/**
 * Builds the combined geometry showcase fixture from offline model inputs:
 *
 * 1. the SAM3 segmentation timeline
 *    (`demo/fixtures/basketball_sam3/detections.json`), whose masks are
 *    converted into bounded simplified polygons on the same detections. That
 *    file is git-ignored, so run `npm run fixture:sam3:restore` first; the
 *    chunks beside it are this script's own output and already carry the merged
 *    geometry, so they cannot stand in for it; and
 * 2. a raw pose JSONL produced once by `run-pose.py`, normalized here into
 *    center-based rects, zero-based COCO skeleton edges, and an explicit
 *    visibility policy; and optionally
 * 3. direct SAM3 `head` masks associated one-to-one with the frozen player
 *    detections without clipping or changing their semantic coverage.
 *
 * Both sources share the SAM3 fixture's frame records (frameIndex, mediaTime,
 * endTime), so every geometry type stays on the same detection-frame timing
 * reference. The script then chunks the combined timeline with the existing
 * chunker. Requires `npm run build -w supervision-js-core` first; run through
 * `npm run fixture:geometry:create`.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import {
  convertDetectionMaskToPolygon,
  createCBIoUTracker,
  decodeCompressedRleMask,
  decodeCompressedRleCounts,
  encodeBinaryMask,
  encodeCompressedRleCounts,
} from "supervision-js-core";
import {
  DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE,
  DEFAULT_MAX_POLYGON_POINTS,
  DEFAULT_POSE_MATCH_IOU,
  DEFAULT_POLYGON_TOLERANCE,
  attachPoseKeypointsToDetections,
  closeBinaryGrid,
  createTemporallyStabilizedRects,
  normalizePoseDetection,
  selectMotionGatedDetection,
  simplifyPolygonPoints,
  stabilizeHeadDetectionFrames,
  summarizeFrameGeometry,
} from "./geometry.mjs";

const DETECTIONS_SCHEMA = "supervision-js.tools.geometry-fixture.detections";
const SEGMENTATION_SOURCE_ID = "sam3";
const POSE_SOURCE_ID = "yolo-pose";
const POSE_Z_INDEX_BASE = 100;
const POSE_TARGET_CLASS_NAMES = ["white team player", "yellow team player"];
const BASKETBALL_TRACE_ALGORITHM = "basketball-motion-track-v1";
const BASKETBALL_TRACE_CLASS_NAME = "basketball";
/**
 * A trace candidate covering this much of the frame is the scene, not a ball.
 * The prompt occasionally returns a whole-frame mask at low confidence, and the
 * association has no reason to prefer the real ball over it once it latches, so
 * the trace follows a static blob for the rest of the clip.
 */
const BASKETBALL_TRACE_MAX_FRAME_COVERAGE = 0.5;
const BASKETBALL_TRACE_MAX_ASSOCIATION_GAP_SECONDS = 0.1;
const BASKETBALL_TRACE_MAX_POINTS = 60;
const BASKETBALL_TRACE_POSITION_TOLERANCE_PIXELS = 12;
const BASKETBALL_TRACE_TRACK_ID = "basketball-track:0";
const BASKETBALL_TRACE_MAX_SPEED_PIXELS_PER_SECOND = 2_700;
const BASKETBALL_TRACE_WINDOW_SECONDS = 1;
const HEAD_ASSOCIATION_ALGORITHM = "sam3-head-temporal-mask-v4";
const HEAD_REGION_ALGORITHM = "sam3-head-temporal-mask-v5";
const GAP_FILL_ALGORITHM = "head-rect-center-interpolation-v1";
const HEAD_MAX_GAP_FRAMES = 4;
const HEAD_MASK_NORMALIZATION_SIZE = 64;
const HEAD_MASK_SMOOTHING_RADIUS = 2;
const HEAD_SOURCE_ID = "sam3-head";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const sam3InputPath = resolve(options.sam3Input);
const poseInputPath = resolve(options.poseInput);
const headSam3InputPath = options.headSam3Input
  ? resolve(options.headSam3Input)
  : undefined;
const outputPath = resolve(options.output);
const fixtureDir = resolve(options.fixtureDir);
const sam3Raw = await readFile(sam3InputPath, "utf8");
const poseRaw = await readFile(poseInputPath, "utf8");
const headSam3Raw = headSam3InputPath
  ? await readFile(headSam3InputPath, "utf8")
  : undefined;
const sam3Fixture = JSON.parse(sam3Raw);
const headSam3Fixture = headSam3Raw ? JSON.parse(headSam3Raw) : undefined;
const headFrames = new Map(
  (headSam3Fixture?.frames ?? []).map((frame) => [frame.frameIndex, frame]),
);
const { poseMeta, poseFrames } = readPose(poseRaw, poseInputPath, sam3Fixture);
const polygonOptions = {
  maxPoints: options.maxPolygonPoints,
  tolerance: options.polygonTolerance,
};

const poseAssociation = {
  matchedPoseCount: 0,
  unmatchedPoseCount: 0,
  unmatchedTargetCount: 0,
};
const basketballTrace = [];
let previousBasketballTraceObservation;
const baseFrames = sam3Fixture.frames.map((frame) => {
  const segmentationDetections = frame.detections.map((detection) =>
    deriveMaskPolygonDetection(detection, polygonOptions),
  );
  const poseDetections = normalizePoseFrame(
    poseFrames.get(frame.frameIndex) ?? [],
    frame,
  );
  const association = attachPoseKeypointsToDetections(
    segmentationDetections,
    poseDetections,
    {
      minimumIou: DEFAULT_POSE_MATCH_IOU,
      targetClassNames: POSE_TARGET_CLASS_NAMES,
    },
  );

  poseAssociation.matchedPoseCount += association.matchedPoseCount;
  poseAssociation.unmatchedPoseCount += association.unmatchedPoseCount;
  poseAssociation.unmatchedTargetCount += association.unmatchedTargetCount;

  const traceResult = attachBasketballCenterTrace(
    association.detections,
    frame.mediaTime,
    basketballTrace,
    previousBasketballTraceObservation,
  );
  previousBasketballTraceObservation = traceResult.previousObservation;

  return {
    ...frame,
    detections: traceResult.detections,
  };
});
const trackedHeadPlayerFrames = trackHeadPlayerDetections(baseFrames);
const stabilizedHeads = headSam3Fixture
  ? stabilizeHeadDetectionFrames(
      baseFrames.map((frame) => ({
        frameIndex: frame.frameIndex,
        headDetections: headFrames.get(frame.frameIndex)?.detections ?? [],
        playerDetections: trackedHeadPlayerFrames.get(frame.frameIndex) ?? [],
      })),
      {
        associationAlgorithm: HEAD_ASSOCIATION_ALGORITHM,
        fillGap: interpolateHeadBetweenObservations,
        maxGapFrames: HEAD_MAX_GAP_FRAMES,
        sourceId: HEAD_SOURCE_ID,
        targetClassNames: POSE_TARGET_CLASS_NAMES,
      },
    )
  : undefined;
if (stabilizedHeads) {
  stabilizeAuthoredHeadMasks(stabilizedHeads);
}
const frames = baseFrames.map((frame) => ({
  ...frame,
  detections: [
    ...frame.detections,
    ...(stabilizedHeads?.detectionsByFrame.get(frame.frameIndex) ?? []),
  ],
}));
const geometry = summarizeFrameGeometry(frames);
const fixture = {
  classNames: [
    ...(sam3Fixture.inference?.prompts ?? []),
    ...(headSam3Fixture ? ["head"] : []),
  ],
  frames,
  geometry,
  inference: sam3Fixture.inference,
  provenance: {
    generationCommand: describeInvocation(),
    ...(headSam3Fixture
      ? {
          headRegions: {
            algorithm: HEAD_REGION_ALGORITHM,
            associationPolicy: `C-BIoU assigns stable team-player tracks before global one-to-one head matching; exact repeated masks retain their prior owner, implausible relative position/scale jumps are rejected, confidence >= 0.7 starts a head track, confidence >= 0.5 continues it, and internal gaps of at most ${HEAD_MAX_GAP_FRAMES} frames are filled`,
            cropPolicy:
              "6px mask-bounds padding with bidirectional exponential smoothing and a seven-frame local size envelope; every crop remains a superset of its stabilized mask bounds",
            derivedFrom: `direct SAM3 \`head\` masks associated with offline C-BIoU team-player tracks; masks are normalized to ${HEAD_MASK_NORMALIZATION_SIZE}x${HEAD_MASK_NORMALIZATION_SIZE}, stabilized by a ${HEAD_MASK_SMOOTHING_RADIUS * 2 + 1}-frame weighted temporal majority and one-cell morphological close, then projected into the current frame's SAM3 bounds so media pixels remain spatially aligned; a gap frame carries the nearer bracketing observation's mask, rigidly translated onto the position interpolated between both bracketing observations`,
            gapFillAlgorithm: GAP_FILL_ALGORITHM,
            gapFillPolicy: `a gap frame's head center is the linear interpolation of both bracketing observations' mask centers; a gap frame whose player track has no frozen detection stays empty`,
            continuedLowConfidenceHeadCount:
              stabilizedHeads.summary.continuedLowConfidenceHeadCount,
            gapFilledHeadCount: stabilizedHeads.summary.gapFilledHeadCount,
            ignoredLowConfidenceHeadCount:
              stabilizedHeads.summary.ignoredLowConfidenceHeadCount,
            matchedHeadCount:
              stabilizedHeads.summary.observedHeadCount +
              stabilizedHeads.summary.gapFilledHeadCount,
            modelId: headSam3Fixture.inference?.modelId,
            prompt: "head",
            sourceId: HEAD_SOURCE_ID,
            stableTrackCount: stabilizedHeads.summary.trackCount,
            temporallyStabilizedMaskCount:
              stabilizedHeads.summary.temporallyStabilizedMaskCount,
            unmatchedHeadCount: stabilizedHeads.summary.unmatchedHeadCount,
            unmatchedPlayerCount: stabilizedHeads.summary.unmatchedPlayerCount,
          },
        }
      : {}),
    polygon: {
      derivedFrom:
        "sam3 compressed RLE masks via convertDetectionMaskToPolygon",
      maxPointsPerPolygon: options.maxPolygonPoints,
      simplification: "ramer-douglas-peucker with uniform-decimation cap",
      tolerance: options.polygonTolerance,
    },
    pose: {
      ...poseMeta,
      associationPolicy:
        "greedy one-to-one center-rect IoU; keypoints attach to the matched SAM3 class detection and standalone pose detections are omitted",
      coordinateConversion:
        "xyxy corner boxes to center-based rects; COCO one-based skeleton edges to zero-based indexes",
      matchedPoseDetectionCount: poseAssociation.matchedPoseCount,
      minimumMatchIou: DEFAULT_POSE_MATCH_IOU,
      sourceFile: relative(fixtureDir, poseInputPath),
      targetClassNames: POSE_TARGET_CLASS_NAMES,
      unmatchedPoseDetectionCount: poseAssociation.unmatchedPoseCount,
      unmatchedTargetDetectionCount: poseAssociation.unmatchedTargetCount,
      visibilityPolicy: `keypoint confidence >= ${options.visibleConfidence} maps to Visible(2), otherwise NotLabeled(0); Occluded(1) is never inferred`,
    },
    polyline: {
      algorithm: BASKETBALL_TRACE_ALGORITHM,
      confidencePolicy:
        "metadata.trajectoryConfidence is the median SAM3 confidence of the observations composing the drawn window; the detection's own confidence stays its single frame's raw score",
      derivedFrom:
        "motion-gated nearest-neighbor association across SAM3 basketball detections on the shared frame grid",
      interpolation: "none",
      maxAssociationGapSeconds: BASKETBALL_TRACE_MAX_ASSOCIATION_GAP_SECONDS,
      maxPoints: BASKETBALL_TRACE_MAX_POINTS,
      maxSpeedPixelsPerSecond: BASKETBALL_TRACE_MAX_SPEED_PIXELS_PER_SECOND,
      positionTolerancePixels: BASKETBALL_TRACE_POSITION_TOLERANCE_PIXELS,
      selectionPolicy:
        "nearest reachable center; higher confidence then source order break ties; a rejected or stale observation starts a new trace segment",
      trackId: BASKETBALL_TRACE_TRACK_ID,
      windowSeconds: BASKETBALL_TRACE_WINDOW_SECONDS,
    },
    sources: [
      {
        id: SEGMENTATION_SOURCE_ID,
        input: relative(fixtureDir, sam3InputPath),
        inputSha256: sha256(sam3Raw),
        kind: "segmentation",
        modelId: sam3Fixture.inference?.modelId,
      },
      {
        id: POSE_SOURCE_ID,
        input: relative(fixtureDir, poseInputPath),
        inputSha256: sha256(poseRaw),
        kind: "pose",
        modelId: poseMeta.model,
      },
      ...(headSam3Fixture
        ? [
            {
              id: HEAD_SOURCE_ID,
              input: relative(fixtureDir, headSam3InputPath),
              inputSha256: sha256(headSam3Raw),
              kind: "segmentation",
              modelId: headSam3Fixture.inference?.modelId,
              prompts: headSam3Fixture.inference?.prompts,
            },
          ]
        : []),
    ],
  },
  schema: DETECTIONS_SCHEMA,
  version: 1,
  video: sam3Fixture.video,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(fixture)}\n`);
console.log(
  `Wrote combined timeline (${frames.length} frames, ${JSON.stringify(geometry)}) to ${outputPath}`,
);

await runChunker(outputPath, fixtureDir, options.datasetId);

function deriveMaskPolygonDetection(
  detection,
  polygonOptions,
  sourceId = SEGMENTATION_SOURCE_ID,
) {
  const withSource = { ...detection, sourceId };

  if (!detection.mask) {
    return withSource;
  }

  const rawPolygon = convertDetectionMaskToPolygon(detection).polygon;
  const points = rawPolygon
    ? simplifyPolygonPoints(rawPolygon.points, polygonOptions)
    : undefined;

  return points ? { ...withSource, polygon: { points } } : withSource;
}

function trackHeadPlayerDetections(frames) {
  const trackers = new Map(
    POSE_TARGET_CLASS_NAMES.map((className) => [
      className,
      createCBIoUTracker({
        frameRate: 30,
        highConfidenceDetectionThreshold: 0,
        instantFirstFrameActivation: true,
        lostTrackBuffer: 6,
        minimumConsecutiveFrames: 1,
        trackActivationThreshold: 0,
      }),
    ]),
  );
  const classIndexes = new Map(
    POSE_TARGET_CLASS_NAMES.map((className, index) => [className, index]),
  );
  const result = new Map();

  for (const frame of frames) {
    const trackedPlayers = [];

    for (const className of POSE_TARGET_CLASS_NAMES) {
      const detections = frame.detections.filter(
        (detection) => detection.className === className && detection.rect,
      );
      const assignments = trackers.get(className).update(
        detections.map((detection, detectionIndex) => ({
          confidence: detection.confidence,
          detectionIndex,
          rect: detection.rect,
        })),
        frame.frameIndex,
      ).assignments;

      for (const { detectionIndex, trackerId } of assignments) {
        const detection = detections[detectionIndex];

        if (!detection) continue;
        trackedPlayers.push({
          ...detection,
          id: `player-track:${classIndexes.get(className)}:${trackerId}`,
          metadata: {
            ...detection.metadata,
            headAuthoringSourceDetectionId: detection.id,
          },
          trackerId,
        });
      }
    }

    result.set(frame.frameIndex, trackedPlayers);
  }

  return result;
}

/**
 * The player box is limb-driven: its top follows whichever body part is
 * highest, usually a raised arm. Moving a head by that box's delta tracks the
 * arm, not the head, and the error compounds with distance from the
 * observation it was moved from, so both bracketing observations anchor the
 * placement.
 */
function interpolateHeadBetweenObservations({
  interpolationAmount,
  nextHead,
  previousHead,
}) {
  if (!previousHead.rect || !nextHead.rect) return undefined;
  const ordered =
    interpolationAmount <= 0.5
      ? [previousHead, nextHead]
      : [nextHead, previousHead];

  for (const sourceHead of ordered) {
    const filled = translateHeadMaskToInterpolatedCenter({
      interpolationAmount,
      nextHead,
      previousHead,
      sourceHead,
    });

    if (filled) return filled;
  }

  return undefined;
}

function translateHeadMaskToInterpolatedCenter({
  interpolationAmount,
  nextHead,
  previousHead,
  sourceHead,
}) {
  if (!sourceHead.mask || !sourceHead.rect) return undefined;
  const offsetX = Math.round(
    lerp(previousHead.rect.x, nextHead.rect.x, interpolationAmount) -
      sourceHead.rect.x,
  );
  const offsetY = Math.round(
    lerp(previousHead.rect.y, nextHead.rect.y, interpolationAmount) -
      sourceHead.rect.y,
  );
  const decoded = decodeCompressedRleMask(sourceHead.mask);
  const translated = new Uint8Array(decoded.data.length);
  let left = decoded.width;
  let right = -1;
  let top = decoded.height;
  let bottom = -1;

  for (let y = 0; y < decoded.height; y += 1) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= decoded.height) continue;

    for (let x = 0; x < decoded.width; x += 1) {
      if (!decoded.data[y * decoded.width + x]) continue;
      const targetX = x + offsetX;
      if (targetX < 0 || targetX >= decoded.width) continue;
      translated[targetY * decoded.width + targetX] = 1;
      left = Math.min(left, targetX);
      right = Math.max(right, targetX);
      top = Math.min(top, targetY);
      bottom = Math.max(bottom, targetY);
    }
  }

  if (right < left || bottom < top) return undefined;

  return {
    ...sourceHead,
    confidence: Math.min(sourceHead.confidence ?? 0.5, 0.5),
    mask: encodeBinaryMask(translated, decoded.width, decoded.height),
    metadata: {
      ...sourceHead.metadata,
      gapFill: GAP_FILL_ALGORITHM,
      gapFillOffset: { x: offsetX, y: offsetY },
      gapFillSourceDetectionId: sourceHead.id,
    },
    rect: {
      height: bottom - top + 1,
      width: right - left + 1,
      x: left + (right - left + 1) / 2,
      y: top + (bottom - top + 1) / 2,
    },
  };
}

function stabilizeAuthoredHeadMasks(stabilizedHeads) {
  const observationsByTrack = new Map();

  for (const [frameIndex, detections] of stabilizedHeads.detectionsByFrame) {
    for (const detection of detections) {
      if (!detection.mask || !detection.metadata?.rawMaskRect) continue;
      const observations = observationsByTrack.get(detection.id) ?? [];
      observations.push({ detection, frameIndex });
      observationsByTrack.set(detection.id, observations);
    }
  }

  let stabilizedMaskCount = 0;

  for (const observations of observationsByTrack.values()) {
    observations.sort((left, right) => left.frameIndex - right.frameIndex);
    for (const segment of splitContiguousObservations(
      observations,
      HEAD_MAX_GAP_FRAMES + 1,
    )) {
      const normalizedMasks = segment.map(({ detection }) =>
        normalizeMaskToGrid(
          detection.mask,
          detection.metadata.rawMaskRect,
          HEAD_MASK_NORMALIZATION_SIZE,
        ),
      );
      const projectedBounds = new Map();

      for (let index = 0; index < segment.length; index += 1) {
        const { detection, frameIndex } = segment[index];
        const normalizedMask = closeBinaryGrid(
          temporalMajorityMask(
            normalizedMasks,
            segment.map((observation) => observation.frameIndex),
            index,
            HEAD_MASK_SMOOTHING_RADIUS,
          ),
          HEAD_MASK_NORMALIZATION_SIZE,
        );
        const projected = projectGridMask(
          normalizedMask,
          HEAD_MASK_NORMALIZATION_SIZE,
          detection.metadata.rawMaskRect,
          detection.mask.width,
          detection.mask.height,
        );

        if (!projected) continue;
        detection.mask = projected.mask;
        detection.metadata = {
          ...detection.metadata,
          maskStabilization: HEAD_ASSOCIATION_ALGORITHM,
          ...(detection.metadata.headObservation === "observed"
            ? { rawSam3MaskRect: detection.metadata.rawMaskRect }
            : {}),
          rawMaskRect: projected.bounds,
        };
        projectedBounds.set(frameIndex, projected.bounds);
        stabilizedMaskCount += 1;
      }

      const stabilizedCrops = createTemporallyStabilizedRects(
        [...projectedBounds].map(([frameIndex, rect]) => ({
          frameIndex,
          rect,
        })),
        {
          maxGapFrames: HEAD_MAX_GAP_FRAMES,
        },
      );

      for (const { detection, frameIndex } of segment) {
        const rect = stabilizedCrops.get(frameIndex);
        if (rect) detection.rect = rect;
      }
    }
  }

  stabilizedHeads.summary.temporallyStabilizedMaskCount = stabilizedMaskCount;
}

function splitContiguousObservations(observations, maximumGap) {
  const segments = [];
  let segment = [];

  for (const observation of observations) {
    const previous = segment.at(-1);
    if (previous && observation.frameIndex - previous.frameIndex > maximumGap) {
      segments.push(segment);
      segment = [];
    }
    segment.push(observation);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function normalizeMaskToGrid(mask, rect, size) {
  const counts = decodeCompressedRleCounts(mask.counts);
  const runEnds = [];
  let offset = 0;
  for (const count of counts) {
    offset += count;
    runEnds.push(offset);
  }
  const result = new Uint8Array(size * size);
  const left = rect.x - rect.width / 2;
  const top = rect.y - rect.height / 2;

  for (let gridY = 0; gridY < size; gridY += 1) {
    const y = clampInteger(
      Math.floor(top + ((gridY + 0.5) * rect.height) / size),
      0,
      mask.height - 1,
    );
    for (let gridX = 0; gridX < size; gridX += 1) {
      const x = clampInteger(
        Math.floor(left + ((gridX + 0.5) * rect.width) / size),
        0,
        mask.width - 1,
      );
      const runIndex = findRunIndex(runEnds, x * mask.height + y);
      result[gridY * size + gridX] = runIndex % 2;
    }
  }

  return result;
}

function temporalMajorityMask(masks, frameIndexes, index, radius) {
  const result = new Uint8Array(masks[index].length);
  const currentFrameIndex = frameIndexes[index];
  const neighbors = masks.flatMap((mask, candidateIndex) => {
    const distance = Math.abs(frameIndexes[candidateIndex] - currentFrameIndex);
    return distance <= radius ? [{ mask, weight: radius + 1 - distance }] : [];
  });
  const totalWeight = neighbors.reduce(
    (total, neighbor) => total + neighbor.weight,
    0,
  );

  for (let pixelIndex = 0; pixelIndex < result.length; pixelIndex += 1) {
    let activeWeight = 0;
    for (const neighbor of neighbors) {
      activeWeight += neighbor.mask[pixelIndex] * neighbor.weight;
    }
    result[pixelIndex] = activeWeight * 2 >= totalWeight ? 1 : 0;
  }
  return result;
}

function projectGridMask(grid, size, rect, width, height) {
  const left = Math.max(0, Math.floor(rect.x - rect.width / 2));
  const right = Math.min(width - 1, Math.ceil(rect.x + rect.width / 2) - 1);
  const top = Math.max(0, Math.floor(rect.y - rect.height / 2));
  const bottom = Math.min(height - 1, Math.ceil(rect.y + rect.height / 2) - 1);
  const runs = [];
  let runValue = 0;
  let runLength = 0;
  let boundsLeft = width;
  let boundsRight = -1;
  let boundsTop = height;
  let boundsBottom = -1;

  const append = (value, length) => {
    if (length <= 0) return;
    if (value === runValue) {
      runLength += length;
      return;
    }
    runs.push(runLength);
    runValue = value;
    runLength = length;
  };

  append(0, left * height);
  for (let x = left; x <= right; x += 1) {
    append(0, top);
    for (let y = top; y <= bottom; y += 1) {
      const gridX = clampInteger(
        Math.floor(((x + 0.5 - (rect.x - rect.width / 2)) / rect.width) * size),
        0,
        size - 1,
      );
      const gridY = clampInteger(
        Math.floor(
          ((y + 0.5 - (rect.y - rect.height / 2)) / rect.height) * size,
        ),
        0,
        size - 1,
      );
      const value = grid[gridY * size + gridX];
      append(value, 1);
      if (value) {
        boundsLeft = Math.min(boundsLeft, x);
        boundsRight = Math.max(boundsRight, x);
        boundsTop = Math.min(boundsTop, y);
        boundsBottom = Math.max(boundsBottom, y);
      }
    }
    append(0, height - bottom - 1);
  }
  append(0, (width - right - 1) * height);
  runs.push(runLength);

  if (boundsRight < boundsLeft || boundsBottom < boundsTop) return undefined;
  const bounds = {
    height: boundsBottom - boundsTop + 1,
    width: boundsRight - boundsLeft + 1,
    x: boundsLeft + (boundsRight - boundsLeft + 1) / 2,
    y: boundsTop + (boundsBottom - boundsTop + 1) / 2,
  };

  return {
    bounds,
    mask: {
      counts: encodeCompressedRleCounts(runs),
      encoding: "compressedRle",
      height,
      width,
    },
  };
}

function findRunIndex(runEnds, flatIndex) {
  let low = 0;
  let high = runEnds.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (flatIndex < runEnds[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

function clampInteger(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function coversWholeFrame(detection) {
  const frameArea =
    (detection.mask?.width ?? 0) * (detection.mask?.height ?? 0);

  if (frameArea <= 0) {
    return false;
  }

  return (
    (detection.rect.width * detection.rect.height) / frameArea >=
    BASKETBALL_TRACE_MAX_FRAME_COVERAGE
  );
}

function attachBasketballCenterTrace(
  detections,
  mediaTime,
  trace,
  previousObservation,
) {
  const basketballCandidates = detections.filter(
    (detection) =>
      detection.className === BASKETBALL_TRACE_CLASS_NAME &&
      !coversWholeFrame(detection),
  );

  const observationIsStale =
    previousObservation &&
    mediaTime - previousObservation.mediaTime >
      BASKETBALL_TRACE_MAX_ASSOCIATION_GAP_SECONDS;
  const associationPreviousObservation = observationIsStale
    ? undefined
    : previousObservation;

  if (observationIsStale) {
    trace.length = 0;
  }

  const basketball = selectMotionGatedDetection(
    basketballCandidates,
    associationPreviousObservation,
    mediaTime,
    {
      maxSpeedPixelsPerSecond: BASKETBALL_TRACE_MAX_SPEED_PIXELS_PER_SECOND,
      positionTolerancePixels: BASKETBALL_TRACE_POSITION_TOLERANCE_PIXELS,
    },
  );

  if (!basketball) {
    return { detections, previousObservation };
  }

  const observation = {
    confidence: basketball.confidence,
    mediaTime,
    x: basketball.rect.x,
    y: basketball.rect.y,
  };
  trace.push(observation);

  const earliestMediaTime = mediaTime - BASKETBALL_TRACE_WINDOW_SECONDS;

  while (
    trace.length > BASKETBALL_TRACE_MAX_POINTS ||
    trace[0]?.mediaTime < earliestMediaTime
  ) {
    trace.shift();
  }

  const polyline =
    trace.length >= 2
      ? { points: trace.map(({ x, y }) => ({ x, y })) }
      : undefined;

  return {
    detections: detections.map((detection) =>
      detection === basketball
        ? {
            ...detection,
            ...(polyline ? { polyline } : {}),
            metadata: {
              ...detection.metadata,
              trajectoryTrackId: BASKETBALL_TRACE_TRACK_ID,
              ...(polyline
                ? {
                    trajectoryConfidence: medianConfidence(trace),
                  }
                : {}),
            },
          }
        : detection,
    ),
    previousObservation: observation,
  };
}

/**
 * How much of the drawn path the model stood behind.
 *
 * A drawn window spans up to a second of observations, so its own detection's
 * score answers a question about a single frame and not about the path. The
 * median holds against the one-frame dropouts that punctuate this clip and
 * still falls when a whole segment is weak.
 */
function medianConfidence(trace) {
  const sorted = trace
    .map(({ confidence }) => confidence)
    .sort((a, b) => a - b);
  const middle = sorted.length / 2;

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}

function normalizePoseFrame(rawDetections, frame) {
  return rawDetections.flatMap((rawDetection, personIndex) => {
    const detection = normalizePoseDetection(rawDetection, {
      frameIndex: frame.frameIndex,
      personIndex,
      sourceId: POSE_SOURCE_ID,
      visibleConfidence: options.visibleConfidence,
      zIndexBase: POSE_Z_INDEX_BASE,
    });

    return detection ? [detection] : [];
  });
}

/**
 * Pose read against the detection grid it claims to describe.
 *
 * Keypoints join the timeline by frame index alone, and an index resolves on
 * any grid. A pose run against a different frame rate therefore lands every
 * skeleton on a frame it was not measured from, which reads as annotations
 * quietly drifting rather than as a failure.
 */
function readPose(raw, inputPath, sam3Fixture) {
  const { poseMeta, poseFrames } = parseRawPose(raw);
  const detectionFrameCount = sam3Fixture.frames.length;
  const knownFrameIndexes = new Set(
    sam3Fixture.frames.map((frame) => frame.frameIndex),
  );
  const unknownFrameIndexes = [...poseFrames.keys()].filter(
    (frameIndex) => !knownFrameIndexes.has(frameIndex),
  );

  if (
    poseMeta.frameCount !== detectionFrameCount ||
    unknownFrameIndexes.length > 0
  ) {
    throw new Error(
      `${inputPath} was run over ${poseMeta.frameCount} frames and the ` +
        `detections cover ${detectionFrameCount}` +
        (unknownFrameIndexes.length > 0
          ? `, with ${unknownFrameIndexes.length} pose frame indexes absent ` +
            `from the detection grid`
          : "") +
        `. Rerun run-pose.py over frames extracted from the video these ` +
        `detections were inferred against.`,
    );
  }

  return { poseFrames, poseMeta };
}

function parseRawPose(raw) {
  const lines = raw.split("\n").filter(Boolean);
  const poseMeta = JSON.parse(lines[0]);

  if (poseMeta.schema !== "supervision-js.tools.geometry-fixture.raw-pose") {
    throw new Error(
      `Unexpected raw pose schema: ${poseMeta.schema ?? "missing"}`,
    );
  }

  const poseFrames = new Map();

  for (const line of lines.slice(1)) {
    const record = JSON.parse(line);
    poseFrames.set(record.frameIndex, record.detections);
  }

  return { poseMeta, poseFrames };
}

function runChunker(inputPath, fixtureDir, datasetId) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunker = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "../sam3-fixture/chunk-detections.mjs"),
        "--input",
        inputPath,
        "--fixture-dir",
        fixtureDir,
        "--dataset-id",
        datasetId,
        "--compact",
      ],
      { stdio: "inherit" },
    );

    chunker.on("error", rejectPromise);
    chunker.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`chunk-detections.mjs exited with ${code}`)),
    );
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The flags decide which fixture is built and which inputs it reads, so a
 * manifest that records the bare script records a rebuild of something else.
 */
function describeInvocation() {
  const args = process.argv
    .slice(2)
    .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg));

  return [
    "npm run fixture:geometry:create",
    ...(args.length ? ["--"] : []),
    ...args,
  ].join(" ");
}

function parseArgs(args) {
  const parsed = {
    datasetId: "basketball_sam3_v1",
    fixtureDir: "demo/fixtures/basketball_sam3",
    headSam3Input: undefined,
    help: false,
    maxPolygonPoints: DEFAULT_MAX_POLYGON_POINTS,
    output: "tools/geometry-fixture/output/merged-detections.json",
    poseInput: "demo/fixtures/basketball_sam3/raw-pose.jsonl",
    polygonTolerance: DEFAULT_POLYGON_TOLERANCE,
    sam3Input: "demo/fixtures/basketball_sam3/detections.json",
    visibleConfidence: DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--dataset-id":
        parsed.datasetId = readFlagValue(args, (index += 1), arg);
        break;
      case "--head-sam3-input":
        parsed.headSam3Input = readFlagValue(args, (index += 1), arg);
        break;
      case "--fixture-dir":
        parsed.fixtureDir = readFlagValue(args, (index += 1), arg);
        break;
      case "--max-polygon-points":
        parsed.maxPolygonPoints = Number(
          readFlagValue(args, (index += 1), arg),
        );
        break;
      case "--output":
        parsed.output = readFlagValue(args, (index += 1), arg);
        break;
      case "--pose-input":
        parsed.poseInput = readFlagValue(args, (index += 1), arg);
        break;
      case "--polygon-tolerance":
        parsed.polygonTolerance = Number(
          readFlagValue(args, (index += 1), arg),
        );
        break;
      case "--sam3-input":
        parsed.sam3Input = readFlagValue(args, (index += 1), arg);
        break;
      case "--visible-confidence":
        parsed.visibleConfidence = Number(
          readFlagValue(args, (index += 1), arg),
        );
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage:
npm run fixture:geometry:create -- [options]

Options:
  --dataset-id <id>                default: basketball_sam3_v1
  --fixture-dir <path>             default: demo/fixtures/basketball_sam3
  --head-sam3-input <path>         append direct SAM3 head masks associated to players
  --max-polygon-points <count>     default: ${DEFAULT_MAX_POLYGON_POINTS}
  --output <path>                  default: tools/geometry-fixture/output/merged-detections.json
  --pose-input <path>              default: demo/fixtures/basketball_sam3/raw-pose.jsonl
  --polygon-tolerance <pixels>     default: ${DEFAULT_POLYGON_TOLERANCE}
  --sam3-input <path>              default: demo/fixtures/basketball_sam3/detections.json
  --visible-confidence <value>     default: ${DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE}`);
}
