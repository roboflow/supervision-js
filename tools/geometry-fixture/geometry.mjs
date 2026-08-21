/**
 * Pure conversion helpers for the geometry showcase fixture.
 *
 * These functions normalize offline model output into supervision-js
 * `Detection` geometry:
 *
 * - mask contours become bounded, deterministically simplified polygons;
 * - Python/model `xyxy` corner boxes become center-based `Rect` records;
 * - one-based COCO skeleton edges become zero-based `KeypointEdge` pairs;
 * - keypoint confidence maps onto an explicit visibility policy that only
 *   distinguishes `Visible` from `NotLabeled` (pose output has no true
 *   occlusion state, so `Occluded` is never invented).
 */

export const DEFAULT_MAX_POLYGON_POINTS = 48;
export const DEFAULT_POLYGON_TOLERANCE = 2;
export const DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE = 0.5;
export const DEFAULT_POSE_MATCH_IOU = 0.3;
export const DEFAULT_TRAJECTORY_MAX_SPEED_PIXELS_PER_SECOND = 2_700;
export const DEFAULT_TRAJECTORY_POSITION_TOLERANCE_PIXELS = 12;
export const DEFAULT_HEAD_MINIMUM_CONFIDENCE = 0.7;
export const DEFAULT_HEAD_CONTINUATION_CONFIDENCE = 0.5;
export const DEFAULT_HEAD_MAX_GAP_FRAMES = 3;
export const DEFAULT_HEAD_CROP_PADDING_PIXELS = 6;
export const DEFAULT_HEAD_CROP_SMOOTHING = 0.35;
export const DEFAULT_HEAD_CROP_WINDOW_RADIUS = 3;
export const DEFAULT_HEAD_MAX_WIDTH_TO_PLAYER_RATIO = 0.7;
export const DEFAULT_HEAD_MAX_HEIGHT_TO_PLAYER_RATIO = 0.42;
export const DEFAULT_HEAD_MAX_CENTER_Y_TO_PLAYER_RATIO = 0.45;
export const DEFAULT_HEAD_MAX_RELATIVE_CENTER_DELTA = 0.28;
export const DEFAULT_HEAD_MAX_RELATIVE_SCALE_DELTA = Math.log(1.9);

export const KEYPOINT_VISIBILITY_NOT_LABELED = 0;
export const KEYPOINT_VISIBILITY_VISIBLE = 2;

/**
 * COCO-17 person skeleton edges as published by COCO and mirrored by the
 * Python Supervision keypoint annotators. Indexes are one-based vertex ids.
 */
export const COCO_SKELETON_EDGES_ONE_BASED = [
  [16, 14],
  [14, 12],
  [17, 15],
  [15, 13],
  [12, 13],
  [6, 12],
  [7, 13],
  [6, 7],
  [6, 8],
  [7, 9],
  [8, 10],
  [9, 11],
  [2, 3],
  [1, 2],
  [1, 3],
  [2, 4],
  [3, 5],
  [4, 6],
  [5, 7],
];

/**
 * Converts one-based skeleton edges (COCO / Python Supervision annotator
 * convention) into the zero-based `KeypointEdge` pairs used by supervision-js.
 */
export function convertOneBasedEdges(edges, vertexCount) {
  return edges.map(([from, to]) => {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to < 1 ||
      from > vertexCount ||
      to > vertexCount
    ) {
      throw new Error(
        `Skeleton edge [${from}, ${to}] is outside the one-based vertex range 1..${vertexCount}.`,
      );
    }

    return [from - 1, to - 1];
  });
}

/** Converts a model `xyxy` corner box into a center-based media-pixel rect. */
export function xyxyToCenterRect([x1, y1, x2, y2]) {
  const width = x2 - x1;
  const height = y2 - y1;

  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }

  return {
    height: round(height, 1),
    width: round(width, 1),
    x: round(x1 + width / 2, 1),
    y: round(y1 + height / 2, 1),
  };
}

/**
 * Deterministically simplifies a closed polygon contour.
 *
 * Runs Ramer-Douglas-Peucker with `tolerance`, then keeps growing the
 * tolerance until the ring fits inside `maxPoints`. A final uniform decimation
 * guarantees the bound even for pathological zig-zag contours, so a hostile
 * mask can never produce an unbounded vector payload.
 */
export function simplifyPolygonPoints(points, options = {}) {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POLYGON_POINTS;
  const baseTolerance = options.tolerance ?? DEFAULT_POLYGON_TOLERANCE;

  if (!Number.isInteger(maxPoints) || maxPoints < 3) {
    throw new Error("maxPoints must be an integer of at least 3.");
  }

  let simplified = dedupeConsecutivePoints(
    points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
  );

  for (
    let tolerance = baseTolerance;
    simplified.length > maxPoints;
    tolerance *= 2
  ) {
    const next = dedupeConsecutivePoints(
      simplifyClosedRing(simplified, tolerance),
    );

    if (next.length < 3 || next.length >= simplified.length) {
      break;
    }

    simplified = next;
  }

  if (simplified.length > maxPoints) {
    simplified = decimateToCount(simplified, maxPoints);
  }

  return simplified.length < 3 ? undefined : simplified;
}

/**
 * Associates direct SAM3 head masks with frozen player detections.
 *
 * The player's top-center is a stable authoring anchor even when its mask
 * temporarily omits part of the neck or head. Matching is one-to-one and never
 * clips or otherwise changes the SAM3 head mask.
 */
export function associateHeadDetectionsToPlayers(
  headDetections,
  playerDetections,
  options = {},
) {
  const minimumConfidence =
    options.minimumConfidence ?? DEFAULT_HEAD_MINIMUM_CONFIDENCE;
  const maximumWidthRatio =
    options.maximumWidthRatio ?? DEFAULT_HEAD_MAX_WIDTH_TO_PLAYER_RATIO;
  const maximumHeightRatio =
    options.maximumHeightRatio ?? DEFAULT_HEAD_MAX_HEIGHT_TO_PLAYER_RATIO;
  const maximumCenterYRatio =
    options.maximumCenterYRatio ?? DEFAULT_HEAD_MAX_CENTER_Y_TO_PLAYER_RATIO;
  const targetClassNames = new Set(options.targetClassNames ?? []);
  const previousRelativeCenters = options.previousRelativeCenters ?? new Map();
  const previousAssignments = options.previousAssignments ?? new Map();
  const previousMaskOwners = options.previousMaskOwners ?? new Map();
  const currentFrameIndex = options.frameIndex;
  const maximumTemporalGapFrames = options.maximumTemporalGapFrames ?? 7;
  const maximumRelativeCenterDelta =
    options.maximumRelativeCenterDelta ??
    DEFAULT_HEAD_MAX_RELATIVE_CENTER_DELTA;
  const maximumRelativeScaleDelta =
    options.maximumRelativeScaleDelta ?? DEFAULT_HEAD_MAX_RELATIVE_SCALE_DELTA;
  const temporalWeight = options.temporalWeight ?? 2;
  const scaleWeight = options.scaleWeight ?? 0.25;
  const eligiblePlayers = playerDetections.filter(
    (player) =>
      player.rect &&
      (targetClassNames.size === 0 || targetClassNames.has(player.className)),
  );
  const eligibleHeads = headDetections.filter(
    (head) =>
      head.rect && head.mask && (head.confidence ?? 0) >= minimumConfidence,
  );
  const candidates = [];

  for (const [headIndex, head] of eligibleHeads.entries()) {
    for (const [playerIndex, player] of eligiblePlayers.entries()) {
      const playerLeft = player.rect.x - player.rect.width / 2;
      const playerRight = player.rect.x + player.rect.width / 2;
      const playerTop = player.rect.y - player.rect.height / 2;
      const playerHeadBandBottom =
        playerTop + player.rect.height * maximumCenterYRatio;
      const centerIsInHeadBand =
        head.rect.x >= playerLeft &&
        head.rect.x <= playerRight &&
        head.rect.y >= playerTop &&
        head.rect.y <= playerHeadBandBottom;
      const sizeIsPlausible =
        head.rect.width <= player.rect.width * maximumWidthRatio &&
        head.rect.height <= player.rect.height * maximumHeightRatio;

      if (!centerIsInHeadBand || !sizeIsPlausible) continue;

      const normalizedX = (head.rect.x - player.rect.x) / player.rect.width;
      const normalizedY = (head.rect.y - playerTop) / player.rect.height;
      const previousAssignment = previousAssignments.get(player.id);
      const previousAssignmentIsCurrent =
        previousAssignment &&
        (currentFrameIndex === undefined ||
          previousAssignment.frameIndex === undefined ||
          currentFrameIndex - previousAssignment.frameIndex <=
            maximumTemporalGapFrames);
      const previousRelativeCenter = previousAssignmentIsCurrent
        ? previousAssignment.relativeCenter
        : previousRelativeCenters.get(player.id);
      const temporalDistance = previousRelativeCenter
        ? Math.hypot(
            normalizedX - previousRelativeCenter.x,
            normalizedY - previousRelativeCenter.y,
          )
        : 0;
      const relativeWidth = head.rect.width / player.rect.width;
      const relativeHeight = head.rect.height / player.rect.height;
      const previousRelativeWidth = previousAssignmentIsCurrent
        ? previousAssignment.relativeWidth
        : undefined;
      const previousRelativeHeight = previousAssignmentIsCurrent
        ? previousAssignment.relativeHeight
        : undefined;
      const relativeScaleDistance =
        previousRelativeWidth && previousRelativeHeight
          ? Math.max(
              Math.abs(Math.log(relativeWidth / previousRelativeWidth)),
              Math.abs(Math.log(relativeHeight / previousRelativeHeight)),
            )
          : 0;
      const sameMaskAsPrevious =
        previousAssignmentIsCurrent &&
        maskSignature(head) === previousAssignment.maskSignature;
      const previousMaskOwner = previousMaskOwners.get(maskSignature(head));

      if (
        previousMaskOwner &&
        previousMaskOwner.playerId !== player.id &&
        (currentFrameIndex === undefined ||
          previousMaskOwner.frameIndex === undefined ||
          currentFrameIndex - previousMaskOwner.frameIndex <=
            maximumTemporalGapFrames)
      ) {
        continue;
      }

      if (
        previousAssignmentIsCurrent &&
        !sameMaskAsPrevious &&
        (temporalDistance > maximumRelativeCenterDelta ||
          relativeScaleDistance > maximumRelativeScaleDelta)
      ) {
        continue;
      }

      candidates.push({
        head,
        headIndex,
        player,
        playerIndex,
        relativeCenter: { x: normalizedX, y: normalizedY },
        relativeHeight,
        relativeWidth,
        sameMaskAsPrevious,
        score:
          Math.hypot(normalizedX, normalizedY) +
          temporalDistance * temporalWeight +
          relativeScaleDistance * scaleWeight,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.score - right.score ||
      (right.head.confidence ?? 0) - (left.head.confidence ?? 0) ||
      left.headIndex - right.headIndex ||
      left.playerIndex - right.playerIndex,
  );

  const assignedCandidates = assignHeadCandidates(
    candidates,
    eligibleHeads.length,
    eligiblePlayers.length,
  );
  const matches = assignedCandidates.map((candidate) => ({
    head: candidate.head,
    normalizedTopCenterDistance: round(candidate.score, 4),
    player: candidate.player,
    relativeCenter: candidate.relativeCenter,
    relativeHeight: candidate.relativeHeight,
    relativeWidth: candidate.relativeWidth,
  }));

  return {
    ignoredLowConfidenceHeadCount: headDetections.length - eligibleHeads.length,
    matches,
    unmatchedHeadCount: eligibleHeads.length - matches.length,
    unmatchedPlayerCount: eligiblePlayers.length - matches.length,
  };
}

/**
 * Stabilizes independently inferred head masks against persistent player ids.
 *
 * High-confidence observations start tracks; lower-confidence observations may
 * only continue them. Short internal gaps can be synthesized by an offline
 * caller, and crop rectangles are padded/smoothed while remaining guaranteed
 * to contain the exact current mask bounds.
 */
export function stabilizeHeadDetectionFrames(frames, options = {}) {
  const startConfidence =
    options.startConfidence ?? DEFAULT_HEAD_MINIMUM_CONFIDENCE;
  const continuationConfidence =
    options.continuationConfidence ?? DEFAULT_HEAD_CONTINUATION_CONFIDENCE;
  const maxGapFrames = options.maxGapFrames ?? DEFAULT_HEAD_MAX_GAP_FRAMES;
  const cropPadding = options.cropPadding ?? DEFAULT_HEAD_CROP_PADDING_PIXELS;
  const cropSmoothing = options.cropSmoothing ?? DEFAULT_HEAD_CROP_SMOOTHING;
  const associationAlgorithm =
    options.associationAlgorithm ?? "sam3-head-temporal-player-v2";
  const targetClassNames = options.targetClassNames ?? [];
  const previousRelativeCenters = new Map();
  const previousAssignments = new Map();
  const previousMaskOwners = new Map();
  const associatedFrames = [];
  const associationSummary = {
    ignoredLowConfidenceHeadCount: 0,
    unmatchedHeadCount: 0,
    unmatchedPlayerCount: 0,
  };

  for (const frame of frames) {
    const association = associateHeadDetectionsToPlayers(
      frame.headDetections,
      frame.playerDetections,
      {
        frameIndex: frame.frameIndex,
        minimumConfidence: continuationConfidence,
        maximumTemporalGapFrames: maxGapFrames,
        previousAssignments,
        previousMaskOwners,
        previousRelativeCenters,
        targetClassNames,
      },
    );

    for (const match of association.matches) {
      if (match.player.id !== undefined) {
        previousRelativeCenters.set(match.player.id, match.relativeCenter);
        previousAssignments.set(match.player.id, {
          frameIndex: frame.frameIndex,
          maskSignature: maskSignature(match.head),
          relativeCenter: match.relativeCenter,
          relativeHeight: match.relativeHeight,
          relativeWidth: match.relativeWidth,
        });
        previousMaskOwners.set(maskSignature(match.head), {
          frameIndex: frame.frameIndex,
          playerId: match.player.id,
        });
      }
    }

    associationSummary.ignoredLowConfidenceHeadCount +=
      association.ignoredLowConfidenceHeadCount;
    associationSummary.unmatchedHeadCount += association.unmatchedHeadCount;
    associationSummary.unmatchedPlayerCount += association.unmatchedPlayerCount;
    associatedFrames.push({ ...frame, matches: association.matches });
  }

  const allPlayerIds = [
    ...new Set(
      associatedFrames.flatMap((frame) =>
        frame.playerDetections.flatMap((player) =>
          player.id === undefined ? [] : [String(player.id)],
        ),
      ),
    ),
  ].sort();
  const trackerIds = new Map(
    allPlayerIds.map((playerId, index) => [playerId, index + 1]),
  );
  const frameByIndex = new Map(
    associatedFrames.map((frame) => [frame.frameIndex, frame]),
  );
  const observationsByPlayer = new Map();

  for (const frame of associatedFrames) {
    for (const match of frame.matches) {
      if (match.player.id === undefined) continue;
      const playerId = String(match.player.id);
      const observations = observationsByPlayer.get(playerId) ?? new Map();
      observations.set(frame.frameIndex, { ...match, synthetic: false });
      observationsByPlayer.set(playerId, observations);
    }
  }

  const detectionsByFrame = new Map(
    associatedFrames.map((frame) => [frame.frameIndex, []]),
  );
  let gapFilledHeadCount = 0;
  let observedHeadCount = 0;
  let continuedLowConfidenceHeadCount = 0;
  let trackCount = 0;

  for (const [playerId, allObservations] of observationsByPlayer) {
    const sortedObservedIndexes = [...allObservations.keys()].sort(
      (left, right) => left - right,
    );
    const firstHighConfidenceIndex = sortedObservedIndexes.find(
      (frameIndex) =>
        (allObservations.get(frameIndex).head.confidence ?? 0) >=
        startConfidence,
    );

    if (firstHighConfidenceIndex === undefined) continue;
    trackCount += 1;

    const observations = new Map(
      [...allObservations].filter(
        ([frameIndex]) => frameIndex >= firstHighConfidenceIndex,
      ),
    );
    const observedIndexes = [...observations.keys()].sort(
      (left, right) => left - right,
    );

    for (let index = 1; index < observedIndexes.length; index += 1) {
      const previousFrameIndex = observedIndexes[index - 1];
      const nextFrameIndex = observedIndexes[index];
      const gapLength = nextFrameIndex - previousFrameIndex - 1;

      if (gapLength <= 0 || gapLength > maxGapFrames || !options.fillGap) {
        continue;
      }

      for (
        let frameIndex = previousFrameIndex + 1;
        frameIndex < nextFrameIndex;
        frameIndex += 1
      ) {
        const frame = frameByIndex.get(frameIndex);
        const previousObservation = observations.get(previousFrameIndex);
        const nextObservation = observations.get(nextFrameIndex);
        const interpolationAmount =
          (frameIndex - previousFrameIndex) /
          (nextFrameIndex - previousFrameIndex);
        const targetPlayer =
          frame?.playerDetections.find(
            (player) => String(player.id) === playerId,
          ) ??
          interpolatePlayerDetection(
            previousObservation?.player,
            nextObservation?.player,
            interpolationAmount,
          );
        const sourceFrameIndexes = [previousFrameIndex, nextFrameIndex].sort(
          (left, right) =>
            Math.abs(frameIndex - left) - Math.abs(frameIndex - right),
        );
        let filledHead;
        let sourceObservation;

        if (!frame || !targetPlayer) continue;

        for (const sourceFrameIndex of sourceFrameIndexes) {
          const candidate = observations.get(sourceFrameIndex);

          if (!candidate) continue;
          const candidateHead = options.fillGap({
            frame,
            sourceHead: candidate.head,
            sourcePlayer: candidate.player,
            targetPlayer,
          });

          if (!candidateHead?.mask || !candidateHead.rect) continue;
          filledHead = candidateHead;
          sourceObservation = candidate;
          break;
        }

        if (!filledHead || !sourceObservation) continue;
        observations.set(frameIndex, {
          head: filledHead,
          normalizedTopCenterDistance:
            sourceObservation.normalizedTopCenterDistance,
          player: targetPlayer,
          relativeCenter: sourceObservation.relativeCenter,
          synthetic: true,
        });
        gapFilledHeadCount += 1;
      }
    }

    const orderedFrameIndexes = [...observations.keys()].sort(
      (left, right) => left - right,
    );
    const stabilizedRects = createTemporallyStabilizedRects(
      orderedFrameIndexes.map((frameIndex) => ({
        frameIndex,
        rect: observations.get(frameIndex).head.rect,
      })),
      {
        maxGapFrames,
        padding: cropPadding,
        smoothing: cropSmoothing,
      },
    );

    for (const frameIndex of orderedFrameIndexes) {
      const observation = observations.get(frameIndex);

      if (!observation.head.mask || !observation.head.rect) continue;

      const rawMaskRect = observation.head.rect;
      const rect = stabilizedRects.get(frameIndex);
      if (!rect) continue;
      const detection = {
        ...observation.head,
        id: `head:${playerId}`,
        metadata: {
          ...observation.head.metadata,
          association: associationAlgorithm,
          headObservation: observation.synthetic ? "gap-filled" : "observed",
          matchedPlayerClassName: observation.player.className,
          matchedPlayerDetectionId: observation.player.id,
          normalizedTopCenterDistance: observation.normalizedTopCenterDistance,
          rawMaskRect,
        },
        polygon: undefined,
        rect,
        sourceId: options.sourceId,
        trackerId: trackerIds.get(playerId),
      };

      detectionsByFrame.get(frameIndex).push(detection);
      observedHeadCount += observation.synthetic ? 0 : 1;
      continuedLowConfidenceHeadCount +=
        !observation.synthetic &&
        (observation.head.confidence ?? 0) < startConfidence
          ? 1
          : 0;
    }
  }

  for (const detections of detectionsByFrame.values()) {
    detections.sort((left, right) => left.trackerId - right.trackerId);
  }

  return {
    detectionsByFrame,
    summary: {
      ...associationSummary,
      continuedLowConfidenceHeadCount,
      gapFilledHeadCount,
      observedHeadCount,
      trackCount,
    },
  };
}

/**
 * Creates acausal, locally stable crop rectangles while keeping every current
 * semantic mask inside its crop. A local maximum anticipates a larger mask
 * before it arrives and delays shrinking afterwards; forward/backward EMA
 * prevents causal lag from becoming visible as crop breathing.
 */
export function createTemporallyStabilizedRects(observations, options = {}) {
  const maxGapFrames = options.maxGapFrames ?? DEFAULT_HEAD_MAX_GAP_FRAMES;
  const padding = options.padding ?? DEFAULT_HEAD_CROP_PADDING_PIXELS;
  const smoothing = options.smoothing ?? DEFAULT_HEAD_CROP_SMOOTHING;
  const windowRadius = options.windowRadius ?? DEFAULT_HEAD_CROP_WINDOW_RADIUS;
  const result = new Map();
  let segment = [];

  const flushSegment = () => {
    if (segment.length === 0) return;
    const padded = segment.map(({ rect }) => ({
      height: rect.height + padding * 2,
      width: rect.width + padding * 2,
      x: rect.x,
      y: rect.y,
    }));
    const smoothed = bidirectionalSmoothRects(padded, smoothing);

    for (let index = 0; index < segment.length; index += 1) {
      const start = Math.max(0, index - windowRadius);
      const end = Math.min(segment.length, index + windowRadius + 1);
      const local = padded.slice(start, end);
      const current = padded[index];
      const width = Math.max(
        smoothed[index].width,
        ...local.map((rect) => rect.width),
      );
      const height = Math.max(
        smoothed[index].height,
        ...local.map((rect) => rect.height),
      );
      const x = clamp(
        smoothed[index].x,
        current.x + current.width / 2 - width / 2,
        current.x - current.width / 2 + width / 2,
      );
      const y = clamp(
        smoothed[index].y,
        current.y + current.height / 2 - height / 2,
        current.y - current.height / 2 + height / 2,
      );

      result.set(segment[index].frameIndex, {
        height: round(height, 1),
        width: round(width, 1),
        x: round(x, 1),
        y: round(y, 1),
      });
    }

    segment = [];
  };

  for (const observation of observations) {
    const previous = segment.at(-1);
    if (
      previous &&
      observation.frameIndex - previous.frameIndex > maxGapFrames + 1
    ) {
      flushSegment();
    }
    segment.push(observation);
  }
  flushSegment();

  return result;
}

export function createContainedSmoothedRect(rect, previous, options = {}) {
  const padding = options.padding ?? DEFAULT_HEAD_CROP_PADDING_PIXELS;
  const smoothing = options.smoothing ?? DEFAULT_HEAD_CROP_SMOOTHING;
  const padded = {
    left: rect.x - rect.width / 2 - padding,
    right: rect.x + rect.width / 2 + padding,
    top: rect.y - rect.height / 2 - padding,
    bottom: rect.y + rect.height / 2 + padding,
  };

  if (!previous) {
    return boundsToCenterRect(padded);
  }

  const desired = {
    height: lerp(previous.height, rect.height + padding * 2, smoothing),
    width: lerp(previous.width, rect.width + padding * 2, smoothing),
    x: lerp(previous.x, rect.x, smoothing),
    y: lerp(previous.y, rect.y, smoothing),
  };

  return boundsToCenterRect({
    bottom: Math.max(desired.y + desired.height / 2, padded.bottom),
    left: Math.min(desired.x - desired.width / 2, padded.left),
    right: Math.max(desired.x + desired.width / 2, padded.right),
    top: Math.min(desired.y - desired.height / 2, padded.top),
  });
}

function boundsToCenterRect({ bottom, left, right, top }) {
  return {
    height: round(bottom - top, 1),
    width: round(right - left, 1),
    x: round((left + right) / 2, 1),
    y: round((top + bottom) / 2, 1),
  };
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function assignHeadCandidates(candidates, headCount, playerCount) {
  if (headCount === 0 || playerCount === 0 || candidates.length === 0) {
    return [];
  }

  const selected = [];
  const usedHeads = new Set();
  const usedPlayers = new Set();

  for (const candidate of candidates.filter(
    ({ sameMaskAsPrevious }) => sameMaskAsPrevious,
  )) {
    if (
      usedHeads.has(candidate.headIndex) ||
      usedPlayers.has(candidate.playerIndex)
    ) {
      continue;
    }
    usedHeads.add(candidate.headIndex);
    usedPlayers.add(candidate.playerIndex);
    selected.push(candidate);
  }

  const remainingHeads = [...Array(headCount).keys()].filter(
    (index) => !usedHeads.has(index),
  );
  const remainingPlayers = [...Array(playerCount).keys()].filter(
    (index) => !usedPlayers.has(index),
  );
  if (remainingHeads.length === 0 || remainingPlayers.length === 0) {
    return selected;
  }

  const candidateByPair = new Map(
    candidates
      .filter(
        (candidate) =>
          !usedHeads.has(candidate.headIndex) &&
          !usedPlayers.has(candidate.playerIndex),
      )
      .map((candidate) => [
        `${candidate.playerIndex}:${candidate.headIndex}`,
        candidate,
      ]),
  );
  const unmatchedCost = 1_000;
  const invalidCost = 1_000_000;
  const costs = remainingPlayers.map((playerIndex) => [
    ...remainingHeads.map(
      (headIndex) =>
        candidateByPair.get(`${playerIndex}:${headIndex}`)?.score ??
        invalidCost,
    ),
    ...remainingPlayers.map((_, dummyIndex) =>
      dummyIndex === remainingPlayers.indexOf(playerIndex)
        ? unmatchedCost
        : invalidCost,
    ),
  ]);
  const assignment = solveRectangularAssignment(costs);

  for (let rowIndex = 0; rowIndex < assignment.length; rowIndex += 1) {
    const columnIndex = assignment[rowIndex];
    if (columnIndex < 0 || columnIndex >= remainingHeads.length) continue;
    const candidate = candidateByPair.get(
      `${remainingPlayers[rowIndex]}:${remainingHeads[columnIndex]}`,
    );
    if (candidate) selected.push(candidate);
  }

  return selected.sort(
    (left, right) =>
      left.playerIndex - right.playerIndex || left.headIndex - right.headIndex,
  );
}

function solveRectangularAssignment(costs) {
  const rowCount = costs.length;
  const columnCount = costs[0]?.length ?? 0;
  if (rowCount === 0) return [];
  if (columnCount < rowCount) {
    throw new Error("Assignment requires at least as many columns as rows.");
  }

  const rowPotential = new Array(rowCount + 1).fill(0);
  const columnPotential = new Array(columnCount + 1).fill(0);
  const matchedRowByColumn = new Array(columnCount + 1).fill(0);
  const previousColumn = new Array(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row += 1) {
    matchedRowByColumn[0] = row;
    let column = 0;
    const minimum = new Array(columnCount + 1).fill(Infinity);
    const used = new Array(columnCount + 1).fill(false);

    do {
      used[column] = true;
      const currentRow = matchedRowByColumn[column];
      let delta = Infinity;
      let nextColumn = 0;

      for (
        let candidateColumn = 1;
        candidateColumn <= columnCount;
        candidateColumn += 1
      ) {
        if (used[candidateColumn]) continue;
        const current =
          costs[currentRow - 1][candidateColumn - 1] -
          rowPotential[currentRow] -
          columnPotential[candidateColumn];
        if (current < minimum[candidateColumn]) {
          minimum[candidateColumn] = current;
          previousColumn[candidateColumn] = column;
        }
        if (minimum[candidateColumn] < delta) {
          delta = minimum[candidateColumn];
          nextColumn = candidateColumn;
        }
      }

      for (
        let candidateColumn = 0;
        candidateColumn <= columnCount;
        candidateColumn += 1
      ) {
        if (used[candidateColumn]) {
          rowPotential[matchedRowByColumn[candidateColumn]] += delta;
          columnPotential[candidateColumn] -= delta;
        } else {
          minimum[candidateColumn] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRowByColumn[column] !== 0);

    do {
      const nextColumn = previousColumn[column];
      matchedRowByColumn[column] = matchedRowByColumn[nextColumn];
      column = nextColumn;
    } while (column !== 0);
  }

  const assignment = new Array(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column += 1) {
    const row = matchedRowByColumn[column];
    if (row > 0) assignment[row - 1] = column - 1;
  }
  return assignment;
}

function bidirectionalSmoothRects(rects, amount) {
  const forward = smoothRects(rects, amount);
  const backward = smoothRects([...rects].reverse(), amount).reverse();
  return rects.map((_, index) => ({
    height: Math.exp(
      (Math.log(forward[index].height) + Math.log(backward[index].height)) / 2,
    ),
    width: Math.exp(
      (Math.log(forward[index].width) + Math.log(backward[index].width)) / 2,
    ),
    x: (forward[index].x + backward[index].x) / 2,
    y: (forward[index].y + backward[index].y) / 2,
  }));
}

function smoothRects(rects, amount) {
  const result = [];
  for (const rect of rects) {
    const previous = result.at(-1);
    result.push(
      previous
        ? {
            height: Math.exp(
              lerp(Math.log(previous.height), Math.log(rect.height), amount),
            ),
            width: Math.exp(
              lerp(Math.log(previous.width), Math.log(rect.width), amount),
            ),
            x: lerp(previous.x, rect.x, amount),
            y: lerp(previous.y, rect.y, amount),
          }
        : { ...rect },
    );
  }
  return result;
}

function maskSignature(detection) {
  const mask = detection?.mask;
  return mask
    ? `${mask.width ?? ""}x${mask.height ?? ""}:${mask.counts}`
    : undefined;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function interpolatePlayerDetection(previous, next, amount) {
  if (!previous?.rect || !next?.rect) return undefined;

  return {
    ...previous,
    className: next.className ?? previous.className,
    rect: {
      height: lerp(previous.rect.height, next.rect.height, amount),
      width: lerp(previous.rect.width, next.rect.width, amount),
      x: lerp(previous.rect.x, next.rect.x, amount),
      y: lerp(previous.rect.y, next.rect.y, amount),
    },
  };
}

/**
 * Normalizes one raw pose detection (model-native values) into a
 * supervision-js `Detection` with keypoint geometry.
 */
export function normalizePoseDetection(rawDetection, options) {
  const {
    frameIndex,
    personIndex,
    className = "person",
    sourceId = "pose",
    zIndexBase = 100,
    visibleConfidence = DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE,
    edgesOneBased = COCO_SKELETON_EDGES_ONE_BASED,
  } = options;
  const rect = xyxyToCenterRect(rawDetection.xyxy);

  if (!rect) {
    return undefined;
  }

  const rawPoints = rawDetection.keypoints?.xy ?? [];
  const confidences = rawDetection.keypoints?.confidence ?? [];
  const points = rawPoints.map(([x, y]) => ({
    x: round(x, 1),
    y: round(y, 1),
  }));
  const visibility = points.map((_, index) =>
    (confidences[index] ?? 0) >= visibleConfidence
      ? KEYPOINT_VISIBILITY_VISIBLE
      : KEYPOINT_VISIBILITY_NOT_LABELED,
  );

  if (!visibility.includes(KEYPOINT_VISIBILITY_VISIBLE)) {
    return undefined;
  }

  const edges = convertOneBasedEdges(edgesOneBased, points.length).filter(
    ([from, to]) =>
      visibility[from] === KEYPOINT_VISIBILITY_VISIBLE &&
      visibility[to] === KEYPOINT_VISIBILITY_VISIBLE,
  );

  return {
    className,
    confidence: rawDetection.confidence,
    id: `pose:${frameIndex}:${personIndex}`,
    keypoints: { edges, points, visibility },
    rect,
    sourceId,
    zIndex: zIndexBase + personIndex,
  };
}

/**
 * Attaches pose geometry to class detections using deterministic one-to-one
 * rectangle IoU matching. Standalone pose detections are intentionally not
 * returned: the class detection remains authoritative for identity, label,
 * confidence, box, mask, and polygon.
 */
export function attachPoseKeypointsToDetections(
  detections,
  poseDetections,
  options,
) {
  const minimumIou = options.minimumIou ?? DEFAULT_POSE_MATCH_IOU;
  const targetClassNames = new Set(options.targetClassNames);

  if (!(minimumIou >= 0 && minimumIou <= 1)) {
    throw new Error("minimumIou must be between 0 and 1.");
  }

  const targetIndexes = detections.flatMap((detection, detectionIndex) =>
    detection.rect && targetClassNames.has(detection.className)
      ? [detectionIndex]
      : [],
  );
  const candidates = targetIndexes.flatMap((detectionIndex) =>
    poseDetections.flatMap((poseDetection, poseIndex) => {
      if (!poseDetection.rect || !poseDetection.keypoints) return [];

      const score = rectIntersectionOverUnion(
        detections[detectionIndex].rect,
        poseDetection.rect,
      );

      return score >= minimumIou ? [{ detectionIndex, poseIndex, score }] : [];
    }),
  );

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.detectionIndex - right.detectionIndex ||
      left.poseIndex - right.poseIndex,
  );

  const matches = new Map();
  const matchedPoseIndexes = new Set();

  for (const candidate of candidates) {
    if (
      matches.has(candidate.detectionIndex) ||
      matchedPoseIndexes.has(candidate.poseIndex)
    ) {
      continue;
    }

    matches.set(candidate.detectionIndex, candidate);
    matchedPoseIndexes.add(candidate.poseIndex);
  }

  return {
    detections: detections.map((detection, detectionIndex) => {
      const match = matches.get(detectionIndex);

      if (!match) return detection;

      const poseDetection = poseDetections[match.poseIndex];

      return {
        ...detection,
        keypoints: poseDetection.keypoints,
        metadata: {
          ...detection.metadata,
          poseDetection: {
            confidence: poseDetection.confidence,
            id: poseDetection.id,
            matchIou: round(match.score, 4),
            sourceId: poseDetection.sourceId,
          },
        },
      };
    }),
    matchedPoseCount: matchedPoseIndexes.size,
    unmatchedPoseCount: poseDetections.length - matchedPoseIndexes.size,
    unmatchedTargetCount: targetIndexes.length - matches.size,
  };
}

/**
 * Selects a deterministic continuation for a single-object trajectory.
 *
 * Semantic model ids are not assumed to persist between frames. A candidate
 * must be reachable from the previous accepted center under the configured
 * speed bound; otherwise it is rejected instead of creating a misleading
 * long segment. Ties prefer the nearest center, then higher confidence, then
 * source order.
 */
export function selectMotionGatedDetection(
  detections,
  previousObservation,
  mediaTime,
  options = {},
) {
  const maxSpeedPixelsPerSecond =
    options.maxSpeedPixelsPerSecond ??
    DEFAULT_TRAJECTORY_MAX_SPEED_PIXELS_PER_SECOND;
  const positionTolerancePixels =
    options.positionTolerancePixels ??
    DEFAULT_TRAJECTORY_POSITION_TOLERANCE_PIXELS;
  const candidates = detections.flatMap((detection, index) =>
    detection.rect ? [{ detection, index }] : [],
  );

  if (candidates.length === 0) return undefined;

  if (!previousObservation) {
    return [...candidates].sort(
      (left, right) =>
        right.detection.confidence - left.detection.confidence ||
        left.index - right.index,
    )[0]?.detection;
  }

  const elapsedSeconds = mediaTime - previousObservation.mediaTime;

  if (!(elapsedSeconds > 0)) return undefined;

  const maximumDistance =
    maxSpeedPixelsPerSecond * elapsedSeconds + positionTolerancePixels;

  return candidates
    .map(({ detection, index }) => ({
      detection,
      distance: Math.hypot(
        detection.rect.x - previousObservation.x,
        detection.rect.y - previousObservation.y,
      ),
      index,
    }))
    .filter(({ distance }) => distance <= maximumDistance)
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        right.detection.confidence - left.detection.confidence ||
        left.index - right.index,
    )[0]?.detection;
}

/** Counts detection geometry by type for fixture summaries. */
export function summarizeFrameGeometry(frames) {
  const geometry = {
    boxDetectionCount: 0,
    keypointDetectionCount: 0,
    maskDetectionCount: 0,
    polygonDetectionCount: 0,
    polylineDetectionCount: 0,
  };

  for (const frame of frames) {
    for (const detection of frame.detections) {
      geometry.boxDetectionCount += detection.rect ? 1 : 0;
      geometry.keypointDetectionCount += detection.keypoints ? 1 : 0;
      geometry.maskDetectionCount += detection.mask ? 1 : 0;
      geometry.polygonDetectionCount += detection.polygon ? 1 : 0;
      geometry.polylineDetectionCount += detection.polyline ? 1 : 0;
    }
  }

  return geometry;
}

function rectIntersectionOverUnion(left, right) {
  const leftX1 = left.x - left.width / 2;
  const leftY1 = left.y - left.height / 2;
  const leftX2 = left.x + left.width / 2;
  const leftY2 = left.y + left.height / 2;
  const rightX1 = right.x - right.width / 2;
  const rightY1 = right.y - right.height / 2;
  const rightX2 = right.x + right.width / 2;
  const rightY2 = right.y + right.height / 2;
  const intersectionWidth = Math.max(
    0,
    Math.min(leftX2, rightX2) - Math.max(leftX1, rightX1),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftY2, rightY2) - Math.max(leftY1, rightY1),
  );
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea =
    left.width * left.height + right.width * right.height - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

function simplifyClosedRing(points, tolerance) {
  if (points.length <= 3) {
    return points;
  }

  // Split the ring at its two mutually furthest anchor points so RDP keeps
  // the overall silhouette instead of collapsing a closed loop to a segment.
  const anchorIndex = findFurthestPointIndex(points, points[0]);
  const firstArc = points.slice(0, anchorIndex + 1);
  const secondArc = [...points.slice(anchorIndex), points[0]];
  const simplifiedFirst = simplifyOpenPath(firstArc, tolerance);
  const simplifiedSecond = simplifyOpenPath(secondArc, tolerance);

  return [...simplifiedFirst.slice(0, -1), ...simplifiedSecond.slice(0, -1)];
}

function simplifyOpenPath(points, tolerance) {
  if (points.length <= 2) {
    return points;
  }

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const ranges = [[0, points.length - 1]];

  while (ranges.length > 0) {
    const [startIndex, endIndex] = ranges.pop();
    let maxDistance = -1;
    let maxIndex = -1;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = distanceToSegment(
        points[index],
        points[startIndex],
        points[endIndex],
      );

      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }

    if (maxDistance > tolerance) {
      keep[maxIndex] = true;
      ranges.push([startIndex, maxIndex], [maxIndex, endIndex]);
    }
  }

  return points.filter((_, index) => keep[index]);
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) /
              lengthSquared,
          ),
        );
  const projectedX = start.x + t * dx;
  const projectedY = start.y + t * dy;

  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function findFurthestPointIndex(points, origin) {
  let maxDistance = -1;
  let maxIndex = 1;

  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.hypot(
      points[index].x - origin.x,
      points[index].y - origin.y,
    );

    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = index;
    }
  }

  return maxIndex;
}

function decimateToCount(points, maxPoints) {
  const step = points.length / maxPoints;

  return Array.from(
    { length: maxPoints },
    (_, index) => points[Math.floor(index * step)],
  );
}

function dedupeConsecutivePoints(points) {
  const deduped = [];

  for (const point of points) {
    const previous = deduped[deduped.length - 1];

    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      deduped.push(point);
    }
  }

  const first = deduped[0];
  const last = deduped[deduped.length - 1];

  if (deduped.length > 1 && first.x === last.x && first.y === last.y) {
    deduped.pop();
  }

  return deduped;
}

function round(value, decimals) {
  const factor = 10 ** decimals;

  return Math.round(value * factor) / factor;
}
