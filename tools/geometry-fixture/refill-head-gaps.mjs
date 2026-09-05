#!/usr/bin/env node
/**
 * Rebuilds the committed head-region fixture's gap-filled head detections from
 * the committed chunks alone, leaving every other detection byte for byte as it
 * found it.
 *
 * The 30fps segmentation timeline `create-geometry-fixture.mjs` consumes is not
 * committed, so `npm run fixture:geometry:create` cannot run. The two things the
 * gap fill reads, the observed head detections bracketing each gap and the
 * frozen player detections, are both in the chunks.
 *
 * Placement interpolates both bracketing observations. Deriving a gap frame from
 * one neighbour plus the player box's motion tracks whichever limb sets the box
 * top, not the head, and that error compounds with distance from the neighbour.
 *
 * A gap frame whose player track has no frozen detection is left empty: a head
 * placed against a guessed player box lands on whatever else is under it.
 *
 * Usage:
 *   node tools/geometry-fixture/refill-head-gaps.mjs \
 *     [--fixture-dir demo/fixtures/basketball_regions] \
 *     [--max-gap-frames 4] [--crop-padding 6] [--dry-run]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  createCBIoUTracker,
  decodeCompressedRleMask,
  encodeBinaryMask,
} from "supervision-js-core";

const GAP_FILL_ALGORITHM = "head-observation-interpolation-v1";
const HEAD_REGION_ALGORITHM = "sam3-head-temporal-mask-v5";
const HEAD_CLASS_NAME = "head";
const HEAD_ID_PREFIX = "head:";
const HEAD_SOURCE_ID = "sam3-head";
const PLAYER_TRACK_CLASS_NAMES = ["white team player", "yellow team player"];

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const fixtureDir = resolve(options.fixtureDir);
const chunksDir = resolve(fixtureDir, "detections");
const manifestPath = resolve(fixtureDir, "detections.manifest.json");
const chunkFiles = (await readdir(chunksDir))
  .filter((file) => file.endsWith(".json"))
  .sort();
const chunks = [];

for (const file of chunkFiles) {
  const path = resolve(chunksDir, file);
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);

  if (JSON.stringify(parsed) !== raw) {
    throw new Error(
      `${file} does not round-trip through JSON.stringify; refusing to rewrite it.`,
    );
  }
  chunks.push({ file, parsed, path, raw });
}

const frames = chunks
  .flatMap(({ parsed }) => parsed.frames)
  .sort((left, right) => left.frameIndex - right.frameIndex);

for (const frame of frames) {
  const firstHeadIndex = frame.detections.findIndex(isHead);
  const trailing =
    firstHeadIndex < 0 ? [] : frame.detections.slice(firstHeadIndex);

  if (!trailing.every(isHead)) {
    throw new Error(
      `Frame ${frame.frameIndex} interleaves head and non-head detections.`,
    );
  }
  for (let index = 1; index < trailing.length; index += 1) {
    if (trailing[index - 1].trackerId > trailing[index].trackerId) {
      throw new Error(
        `Frame ${frame.frameIndex} heads are not tracker-sorted.`,
      );
    }
  }
}

const playerTrackFrames = trackPlayerDetections(frames);
const observedByTrack = new Map();

for (const frame of frames) {
  for (const detection of frame.detections) {
    if (
      !isHead(detection) ||
      detection.metadata?.headObservation !== "observed"
    ) {
      continue;
    }
    const observations = observedByTrack.get(detection.id) ?? new Map();
    observations.set(frame.frameIndex, detection);
    observedByTrack.set(detection.id, observations);
  }
}

for (const [headId, observations] of observedByTrack) {
  const playerTrackId = headId.slice(HEAD_ID_PREFIX.length);

  for (const frameIndex of observations.keys()) {
    if (!playerTrackFrames.get(frameIndex)?.has(playerTrackId)) {
      throw new Error(
        `Rebuilt player tracks miss ${playerTrackId} on frame ${frameIndex}, where an observed head is matched to it.`,
      );
    }
  }
}

const filledByFrame = new Map(frames.map(({ frameIndex }) => [frameIndex, []]));
const summary = {
  candidateCount: 0,
  droppedBeyondMaxGap: 0,
  droppedWithoutPlayerDetection: 0,
  filledCount: 0,
  gapLengthHistogram: new Map(),
};

for (const [headId, observations] of observedByTrack) {
  const playerTrackId = headId.slice(HEAD_ID_PREFIX.length);
  const observedIndexes = [...observations.keys()].sort(
    (left, right) => left - right,
  );

  for (let index = 1; index < observedIndexes.length; index += 1) {
    const previousFrameIndex = observedIndexes[index - 1];
    const nextFrameIndex = observedIndexes[index];
    const gapLength = nextFrameIndex - previousFrameIndex - 1;

    if (gapLength <= 0) continue;
    summary.candidateCount += gapLength;
    summary.gapLengthHistogram.set(
      gapLength,
      (summary.gapLengthHistogram.get(gapLength) ?? 0) + gapLength,
    );

    if (gapLength > options.maxGapFrames) {
      summary.droppedBeyondMaxGap += gapLength;
      continue;
    }
    const previous = observations.get(previousFrameIndex);
    const next = observations.get(nextFrameIndex);

    for (
      let frameIndex = previousFrameIndex + 1;
      frameIndex < nextFrameIndex;
      frameIndex += 1
    ) {
      if (!playerTrackFrames.get(frameIndex)?.has(playerTrackId)) {
        summary.droppedWithoutPlayerDetection += 1;
        continue;
      }
      const amount =
        (frameIndex - previousFrameIndex) /
        (nextFrameIndex - previousFrameIndex);
      const filled = interpolateHeadBetweenObservations({
        amount,
        cropPadding: options.cropPadding,
        next,
        nextFrameIndex,
        previous,
        previousFrameIndex,
        targetFrameIndex: frameIndex,
      });

      if (!filled) continue;
      filledByFrame.get(frameIndex).push(filled);
      summary.filledCount += 1;
    }
  }
}

let observedCount = 0;

for (const frame of frames) {
  const observed = frame.detections.filter(
    (detection) =>
      isHead(detection) && detection.metadata?.headObservation === "observed",
  );

  observedCount += observed.length;
  frame.detections = [
    ...frame.detections.filter((detection) => !isHead(detection)),
    ...[...observed, ...filledByFrame.get(frame.frameIndex)].sort(
      (left, right) => left.trackerId - right.trackerId,
    ),
  ];

  if (!frame.detections.some(isHead)) {
    throw new Error(`Frame ${frame.frameIndex} would carry no head detection.`);
  }
}

const headCount = observedCount + summary.filledCount;
const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);

if (JSON.stringify(manifest) !== manifestRaw) {
  throw new Error("The manifest does not round-trip; refusing to rewrite it.");
}

const removedCount = manifest.provenance.headRegions.matchedHeadCount
  ? manifest.provenance.headRegions.matchedHeadCount - headCount
  : 0;

manifest.detectionCount -= removedCount;
manifest.geometry.boxDetectionCount -= removedCount;
manifest.geometry.maskDetectionCount -= removedCount;
manifest.provenance.headRegions = {
  ...manifest.provenance.headRegions,
  algorithm: HEAD_REGION_ALGORITHM,
  associationPolicy: `C-BIoU assigns stable team-player tracks before global one-to-one head matching; exact repeated masks retain their prior owner, implausible relative position/scale jumps are rejected, confidence >= 0.7 starts a head track, confidence >= 0.5 continues it, and internal gaps of at most ${options.maxGapFrames} frames are filled`,
  derivedFrom:
    "direct SAM3 `head` masks associated with offline C-BIoU team-player tracks; masks are normalized to 64x64, stabilized by a 5-frame weighted temporal majority and one-cell morphological close, then projected into the current frame's SAM3 bounds so media pixels remain spatially aligned; a gap frame carries the nearer bracketing observation's stabilized mask, rigidly translated onto the position interpolated between both bracketing observations",
  gapFillAlgorithm: GAP_FILL_ALGORITHM,
  gapFillPolicy: `regenerated offline from the committed chunks by refill-head-gaps.mjs; a gap frame's head bounds are the linear interpolation of both bracketing observations' stabilized mask bounds, its mask is the nearer bracketing observation's mask translated onto those bounds, and its crop is the interpolation of both bracketing crops widened to hold that mask with ${options.cropPadding}px of padding; a gap frame whose player track has no frozen detection stays empty`,
  gapFillCommand: describeInvocation(),
  gapFilledHeadCount: summary.filledCount,
  matchedHeadCount: headCount,
  temporallyStabilizedMaskCount: headCount,
};

if (options.dryRun) {
  console.log("Dry run; no files written.");
} else {
  for (const { parsed, path } of chunks) {
    await writeFile(path, JSON.stringify(parsed));
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
}

console.log(
  JSON.stringify(
    {
      candidateGapFrames: summary.candidateCount,
      droppedBeyondMaxGap: summary.droppedBeyondMaxGap,
      droppedWithoutPlayerDetection: summary.droppedWithoutPlayerDetection,
      gapFilledHeadCount: summary.filledCount,
      gapLengthHistogram: Object.fromEntries(
        [...summary.gapLengthHistogram].sort(
          (left, right) => left[0] - right[0],
        ),
      ),
      headCount,
      observedHeadCount: observedCount,
      removedDetectionCount: removedCount,
    },
    undefined,
    2,
  ),
);

/**
 * The committed heads carry this script's fill, not the one
 * `create-geometry-fixture.mjs` writes under its own tag, so the manifest has
 * to name the run that produced them.
 */
function describeInvocation() {
  const args = process.argv
    .slice(2)
    .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg));

  return ["node tools/geometry-fixture/refill-head-gaps.mjs", ...args].join(
    " ",
  );
}

function interpolateHeadBetweenObservations({
  amount,
  cropPadding,
  next,
  nextFrameIndex,
  previous,
  previousFrameIndex,
  targetFrameIndex,
}) {
  const previousBounds = previous.metadata.rawMaskRect;
  const nextBounds = next.metadata.rawMaskRect;
  const source =
    targetFrameIndex - previousFrameIndex <= nextFrameIndex - targetFrameIndex
      ? previous
      : next;
  const sourceBounds = source.metadata.rawMaskRect;
  const offsetX = Math.round(
    lerp(previousBounds.x, nextBounds.x, amount) - sourceBounds.x,
  );
  const offsetY = Math.round(
    lerp(previousBounds.y, nextBounds.y, amount) - sourceBounds.y,
  );
  const translated = translateMask(source.mask, offsetX, offsetY);

  if (!translated) return undefined;
  const crop = coverBounds(
    {
      height: lerp(previous.rect.height, next.rect.height, amount),
      width: lerp(previous.rect.width, next.rect.width, amount),
      x: lerp(previous.rect.x, next.rect.x, amount),
      y: lerp(previous.rect.y, next.rect.y, amount),
    },
    translated.bounds,
    cropPadding,
  );

  return {
    className: HEAD_CLASS_NAME,
    confidence: Math.min(source.confidence ?? 0.5, 0.5),
    id: source.id,
    mask: translated.mask,
    metadata: {
      sam3Prompt: source.metadata.sam3Prompt,
      sam3PromptIndex: source.metadata.sam3PromptIndex,
      gapFill: GAP_FILL_ALGORITHM,
      gapFillBracketFrameIndexes: [previousFrameIndex, nextFrameIndex],
      gapFillOffset: { x: offsetX, y: offsetY },
      gapFillSourceFrameIndex:
        source === previous ? previousFrameIndex : nextFrameIndex,
      association: source.metadata.association,
      headObservation: "gap-filled",
      matchedPlayerClassName: source.metadata.matchedPlayerClassName,
      matchedPlayerDetectionId: source.metadata.matchedPlayerDetectionId,
      normalizedTopCenterDistance: source.metadata.normalizedTopCenterDistance,
      rawMaskRect: translated.bounds,
      maskStabilization: source.metadata.maskStabilization,
    },
    rect: crop,
    sourceId: HEAD_SOURCE_ID,
    trackerId: source.trackerId,
  };
}

function translateMask(mask, offsetX, offsetY) {
  const decoded = decodeCompressedRleMask(mask);
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
  const encoded = encodeBinaryMask(translated, decoded.width, decoded.height);

  return {
    bounds: {
      height: bottom - top + 1,
      width: right - left + 1,
      x: left + (right - left + 1) / 2,
      y: top + (bottom - top + 1) / 2,
    },
    mask: {
      counts: encoded.counts,
      encoding: encoded.encoding,
      height: encoded.height,
      width: encoded.width,
    },
  };
}

function coverBounds(rect, bounds, padding) {
  const left = Math.min(
    rect.x - rect.width / 2,
    bounds.x - bounds.width / 2 - padding,
  );
  const right = Math.max(
    rect.x + rect.width / 2,
    bounds.x + bounds.width / 2 + padding,
  );
  const top = Math.min(
    rect.y - rect.height / 2,
    bounds.y - bounds.height / 2 - padding,
  );
  const bottom = Math.max(
    rect.y + rect.height / 2,
    bounds.y + bounds.height / 2 + padding,
  );

  return {
    height: round(bottom - top, 1),
    width: round(right - left, 1),
    x: round((left + right) / 2, 1),
    y: round((top + bottom) / 2, 1),
  };
}

function trackPlayerDetections(frames) {
  const trackers = new Map(
    PLAYER_TRACK_CLASS_NAMES.map((className) => [
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
    PLAYER_TRACK_CLASS_NAMES.map((className, index) => [className, index]),
  );
  const result = new Map();

  for (const frame of frames) {
    const trackIds = new Set();

    for (const className of PLAYER_TRACK_CLASS_NAMES) {
      const detections = frame.detections.filter(
        (detection) => detection.className === className && detection.rect,
      );
      const { assignments } = trackers.get(className).update(
        detections.map((detection, detectionIndex) => ({
          confidence: detection.confidence,
          detectionIndex,
          rect: detection.rect,
        })),
        frame.frameIndex,
      );

      for (const { detectionIndex, trackerId } of assignments) {
        if (!detections[detectionIndex]) continue;
        trackIds.add(
          `player-track:${classIndexes.get(className)}:${trackerId}`,
        );
      }
    }

    result.set(frame.frameIndex, trackIds);
  }

  return result;
}

function isHead(detection) {
  return detection.sourceId === HEAD_SOURCE_ID;
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function round(value, decimals) {
  const factor = 10 ** decimals;

  return Math.round(value * factor) / factor;
}

function parseArgs(args) {
  const parsed = {
    cropPadding: 6,
    dryRun: false,
    fixtureDir: "demo/fixtures/basketball_regions",
    help: false,
    maxGapFrames: 4,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--crop-padding":
        parsed.cropPadding = Number(readFlagValue(args, (index += 1), arg));
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--fixture-dir":
        parsed.fixtureDir = readFlagValue(args, (index += 1), arg);
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--max-gap-frames":
        parsed.maxGapFrames = Number(readFlagValue(args, (index += 1), arg));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (value === undefined) throw new Error(`${flag} requires a value.`);

  return value;
}

function printHelp() {
  console.log(`Usage: node tools/geometry-fixture/refill-head-gaps.mjs [options]

  --crop-padding <pixels>     padding a gap-filled crop keeps around its mask
  --dry-run                   report counts without rewriting the fixture
  --fixture-dir <path>        fixture root holding detections/ and the manifest
  --max-gap-frames <count>    longest observation gap that is still filled`);
}
