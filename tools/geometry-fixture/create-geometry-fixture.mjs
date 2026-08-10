#!/usr/bin/env node
/**
 * Builds the combined geometry showcase fixture from two offline inputs:
 *
 * 1. the committed SAM3 segmentation timeline
 *    (`demo/fixtures/basketball_sam3/detections.json`), whose masks are
 *    converted into bounded simplified polygons on the same detections; and
 * 2. a raw pose JSONL produced once by `run-pose.py`, normalized here into
 *    center-based rects, zero-based COCO skeleton edges, and an explicit
 *    visibility policy.
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
import { convertDetectionMaskToPolygon } from "supervision-js-core";
import {
  DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE,
  DEFAULT_MAX_POLYGON_POINTS,
  DEFAULT_POSE_MATCH_IOU,
  DEFAULT_POLYGON_TOLERANCE,
  attachPoseKeypointsToDetections,
  normalizePoseDetection,
  selectMotionGatedDetection,
  simplifyPolygonPoints,
  summarizeFrameGeometry,
} from "./geometry.mjs";

const DETECTIONS_SCHEMA = "supervision-js.tools.geometry-fixture.detections";
const SEGMENTATION_SOURCE_ID = "sam3";
const POSE_SOURCE_ID = "yolo-pose";
const POSE_Z_INDEX_BASE = 100;
const POSE_TARGET_CLASS_NAMES = ["white team player", "yellow team player"];
const BASKETBALL_TRACE_ALGORITHM = "basketball-motion-track-v1";
const BASKETBALL_TRACE_CLASS_NAME = "basketball";
const BASKETBALL_TRACE_MAX_ASSOCIATION_GAP_SECONDS = 0.1;
const BASKETBALL_TRACE_MAX_POINTS = 60;
const BASKETBALL_TRACE_POSITION_TOLERANCE_PIXELS = 12;
const BASKETBALL_TRACE_TRACK_ID = "basketball-track:0";
const BASKETBALL_TRACE_MAX_SPEED_PIXELS_PER_SECOND = 2_700;
const BASKETBALL_TRACE_WINDOW_SECONDS = 2;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const sam3InputPath = resolve(options.sam3Input);
const poseInputPath = resolve(options.poseInput);
const outputPath = resolve(options.output);
const fixtureDir = resolve(options.fixtureDir);
const sam3Raw = await readFile(sam3InputPath, "utf8");
const poseRaw = await readFile(poseInputPath, "utf8");
const sam3Fixture = JSON.parse(sam3Raw);
const { poseMeta, poseFrames } = parseRawPose(poseRaw);
const polygonOptions = {
  maxPoints: options.maxPolygonPoints,
  tolerance: options.polygonTolerance,
};

let droppedPoseFrameCount = 0;
const knownFrameIndexes = new Set(
  sam3Fixture.frames.map((frame) => frame.frameIndex),
);

for (const frameIndex of poseFrames.keys()) {
  if (!knownFrameIndexes.has(frameIndex)) {
    droppedPoseFrameCount += 1;
  }
}

const poseAssociation = {
  matchedPoseCount: 0,
  unmatchedPoseCount: 0,
  unmatchedTargetCount: 0,
};
const basketballTrace = [];
let previousBasketballTraceObservation;
const frames = sam3Fixture.frames.map((frame) => {
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

  return { ...frame, detections: traceResult.detections };
});
const geometry = summarizeFrameGeometry(frames);
const fixture = {
  classNames: [...(sam3Fixture.inference?.prompts ?? [])],
  frames,
  geometry,
  inference: sam3Fixture.inference,
  provenance: {
    generationCommand: "npm run fixture:geometry:create",
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

if (droppedPoseFrameCount > 0) {
  console.warn(
    `Dropped pose output for ${droppedPoseFrameCount} frame indexes without a SAM3 frame record.`,
  );
}

await runChunker(outputPath, fixtureDir, options.datasetId);

function deriveMaskPolygonDetection(detection, polygonOptions) {
  const withSource = { ...detection, sourceId: SEGMENTATION_SOURCE_ID };

  if (!detection.mask) {
    return withSource;
  }

  const rawPolygon = convertDetectionMaskToPolygon(detection).polygon;
  const points = rawPolygon
    ? simplifyPolygonPoints(rawPolygon.points, polygonOptions)
    : undefined;

  return points ? { ...withSource, polygon: { points } } : withSource;
}

function attachBasketballCenterTrace(
  detections,
  mediaTime,
  trace,
  previousObservation,
) {
  const basketballCandidates = detections.filter(
    (detection) => detection.className === BASKETBALL_TRACE_CLASS_NAME,
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
            },
          }
        : detection,
    ),
    previousObservation: observation,
  };
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

function parseArgs(args) {
  const parsed = {
    datasetId: "basketball_geometry_v1",
    fixtureDir: "demo/fixtures/basketball_geometry",
    help: false,
    maxPolygonPoints: DEFAULT_MAX_POLYGON_POINTS,
    output: "tools/geometry-fixture/output/detections.json",
    poseInput: "demo/fixtures/basketball_geometry/raw-pose.jsonl",
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
  --dataset-id <id>                default: basketball_geometry_v1
  --fixture-dir <path>             default: demo/fixtures/basketball_geometry
  --max-polygon-points <count>     default: ${DEFAULT_MAX_POLYGON_POINTS}
  --output <path>                  default: tools/geometry-fixture/output/detections.json
  --pose-input <path>              default: demo/fixtures/basketball_geometry/raw-pose.jsonl
  --polygon-tolerance <pixels>     default: ${DEFAULT_POLYGON_TOLERANCE}
  --sam3-input <path>              default: demo/fixtures/basketball_sam3/detections.json
  --visible-confidence <value>     default: ${DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE}`);
}
