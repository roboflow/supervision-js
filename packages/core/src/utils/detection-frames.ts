import {
  DetectionMaskEncoding,
  type DetectionFrame,
  type DetectionMask,
} from "#types/detections";
import {
  DetectionFrameSelectionMode,
  type DetectionFrameSelectionOptions,
} from "#types/detection-timeline";

export interface DecodedDetectionMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

interface NearestFrameIndexSelection {
  readonly isApplicable: boolean;
  readonly frame: DetectionFrame | undefined;
}

type IndexedDetectionFrame = DetectionFrame & { readonly frameIndex: number };

/**
 * A playhead compared by time can arrive perturbed by whatever plane it crossed
 * to get here: a producer that publishes whole milliseconds reports a source
 * frame at 5.033333s as 5.033s, and even an exact producer loses a bit to a
 * seconds-to-milliseconds-and-back trip. A frame starting within that reach may
 * already be on screen while one starting past it cannot.
 *
 * Selection by identity carries none of this, which is why it lives in its own
 * function and not in a smaller number here.
 */
const PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS = 0.0005;

export function copySortedDetectionFrames(
  detectionFrames: readonly DetectionFrame[] | undefined,
): DetectionFrame[] {
  validateDetectionFrames(detectionFrames ?? []);

  return (detectionFrames ?? [])
    .map(copyDetectionFrame)
    .sort((left, right) => left.mediaTime - right.mediaTime);
}

/**
 * One frame's deep copy, for a caller that already knows which frames it is
 * keeping and only needs the ones it does not hold.
 */
export function copyDetectionFrame(frame: DetectionFrame): DetectionFrame {
  return {
    detections: frame.detections.map((detection) => ({
      ...detection,
      attributes: detection.attributes ? [...detection.attributes] : undefined,
      keypoints: detection.keypoints
        ? {
            boxRelative: detection.keypoints.boxRelative
              ? [...detection.keypoints.boxRelative]
              : undefined,
            edges: detection.keypoints.edges.map(
              (edge) => [edge[0], edge[1]] as const,
            ),
            points: detection.keypoints.points.map((point) => ({ ...point })),
            visibility: detection.keypoints.visibility
              ? [...detection.keypoints.visibility]
              : undefined,
          }
        : undefined,
      mask: detection.mask ? { ...detection.mask } : undefined,
      metadata: detection.metadata
        ? copyDetectionMetadata(detection.metadata)
        : undefined,
      polygon: detection.polygon
        ? {
            points: detection.polygon.points.map((point) => ({ ...point })),
          }
        : undefined,
      polyline: detection.polyline
        ? {
            points: detection.polyline.points.map((point) => ({ ...point })),
          }
        : undefined,
      rect: detection.rect ? { ...detection.rect } : undefined,
    })),
    coordinateSpace: frame.coordinateSpace
      ? { ...frame.coordinateSpace }
      : undefined,
    endTime: frame.endTime,
    frameIndex: frame.frameIndex,
    mediaTime: frame.mediaTime,
  };
}

/** Returned by the plain copier when it meets a value only structuredClone can
 *  carry, so the caller pays for that only when the metadata needs it. */
const NOT_PLAIN = Symbol("not-plain-metadata");

function copyDetectionMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  // Detection metadata is almost always a handful of strings and numbers, and a
  // window rebuild copies it once per detection, tens of thousands of times a
  // second while scrubbing. structuredClone serialises; walking the object does
  // not, so it is the fallback rather than the default.
  const plain = copyPlainMetadata(metadata);

  if (plain !== NOT_PLAIN) {
    return plain as Record<string, unknown>;
  }

  const clone = (
    globalThis as {
      readonly structuredClone?: <TValue>(value: TValue) => TValue;
    }
  ).structuredClone;

  if (clone) {
    return clone(metadata);
  }

  return copyMetadataValue(metadata) as Record<string, unknown>;
}

function copyPlainMetadata(value: unknown): unknown | typeof NOT_PLAIN {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol"
      ? NOT_PLAIN
      : value;
  }

  if (Array.isArray(value)) {
    const copied: unknown[] = [];

    for (const entry of value) {
      const child = copyPlainMetadata(entry);

      if (child === NOT_PLAIN) {
        return NOT_PLAIN;
      }

      copied.push(child);
    }

    return copied;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return NOT_PLAIN;
  }

  const copied: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    const child = copyPlainMetadata(entry);

    if (child === NOT_PLAIN) {
      return NOT_PLAIN;
    }

    copied[key] = child;
  }

  return copied;
}

function copyMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyMetadataValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        copyMetadataValue(child),
      ]),
    );
  }

  return value;
}

export function validateDetectionFrames(
  detectionFrames: readonly DetectionFrame[],
): void {
  for (
    let frameOffset = 0;
    frameOffset < detectionFrames.length;
    frameOffset += 1
  ) {
    const frame = detectionFrames[frameOffset];
    const framePath = () => `frames[${frameOffset}]`;

    validateNumber(frame.mediaTime, () => `${framePath()}.mediaTime`, {
      min: 0,
    });

    if (frame.endTime !== undefined) {
      validateNumber(frame.endTime, () => `${framePath()}.endTime`, {
        exclusiveMin: frame.mediaTime,
      });
    }

    if (frame.frameIndex !== undefined) {
      validateNumber(frame.frameIndex, () => `${framePath()}.frameIndex`, {
        integer: true,
        min: 0,
      });
    }

    if (frame.coordinateSpace !== undefined) {
      validateNumber(
        frame.coordinateSpace.width,
        () => `${framePath()}.coordinateSpace.width`,
        { exclusiveMin: 0 },
      );
      validateNumber(
        frame.coordinateSpace.height,
        () => `${framePath()}.coordinateSpace.height`,
        { exclusiveMin: 0 },
      );
    }

    for (
      let detectionOffset = 0;
      detectionOffset < frame.detections.length;
      detectionOffset += 1
    ) {
      const detection = frame.detections[detectionOffset];
      const detectionPath = () =>
        `${framePath()}.detections[${detectionOffset}]`;

      if (detection.confidence !== undefined) {
        validateNumber(
          detection.confidence,
          () => `${detectionPath()}.confidence`,
          { max: 1, min: 0 },
        );
      }

      if (detection.zIndex !== undefined) {
        validateNumber(detection.zIndex, () => `${detectionPath()}.zIndex`);
      }

      if (detection.trackerId !== undefined) {
        validateNumber(
          detection.trackerId,
          () => `${detectionPath()}.trackerId`,
          { integer: true, min: 0 },
        );
      }

      if (
        detection.sourceId !== undefined &&
        typeof detection.sourceId !== "string"
      ) {
        throw new Error(`${detectionPath()}.sourceId must be a string.`);
      }

      if (detection.sourceDetectionIndex !== undefined) {
        validateNumber(
          detection.sourceDetectionIndex,
          () => `${detectionPath()}.sourceDetectionIndex`,
          {
            integer: true,
            min: 0,
          },
        );
      }

      if (detection.rect) {
        validateNumber(detection.rect.x, () => `${detectionPath()}.rect.x`);
        validateNumber(detection.rect.y, () => `${detectionPath()}.rect.y`);
        validateNumber(
          detection.rect.width,
          () => `${detectionPath()}.rect.width`,
          { exclusiveMin: 0 },
        );
        validateNumber(
          detection.rect.height,
          () => `${detectionPath()}.rect.height`,
          { exclusiveMin: 0 },
        );
      }
      validatePoints(
        detection.polygon?.points,
        () => `${detectionPath()}.polygon`,
        3,
      );
      validatePoints(
        detection.polyline?.points,
        () => `${detectionPath()}.polyline`,
        2,
      );

      if (detection.keypoints) {
        validatePoints(
          detection.keypoints.points,
          () => `${detectionPath()}.keypoints`,
          1,
        );

        if (
          detection.keypoints.visibility !== undefined &&
          detection.keypoints.visibility.length !==
            detection.keypoints.points.length
        ) {
          throw new Error(
            `${detectionPath()}.keypoints.visibility must match points length.`,
          );
        }

        const edges = detection.keypoints.edges;

        for (let edgeOffset = 0; edgeOffset < edges.length; edgeOffset += 1) {
          const edge = edges[edgeOffset];
          const edgePath = () =>
            `${detectionPath()}.keypoints.edges[${edgeOffset}]`;

          for (
            let endpointOffset = 0;
            endpointOffset < edge.length;
            endpointOffset += 1
          ) {
            const endpoint = edge[endpointOffset];

            validateNumber(endpoint, () => `${edgePath()}[${endpointOffset}]`, {
              integer: true,
              min: 0,
            });

            if (endpoint >= detection.keypoints.points.length) {
              throw new Error(
                `${edgePath()}[${endpointOffset}] is out of range.`,
              );
            }
          }
        }
      }

      if (detection.mask) {
        validateNumber(
          detection.mask.width,
          () => `${detectionPath()}.mask.width`,
          { integer: true, exclusiveMin: 0 },
        );
        validateNumber(
          detection.mask.height,
          () => `${detectionPath()}.mask.height`,
          { integer: true, exclusiveMin: 0 },
        );

        if (detection.mask.counts.length === 0) {
          throw new Error(`${detectionPath()}.mask.counts must not be empty.`);
        }
      }
    }
  }
}

/**
 * Where a rejected value sits, named only when one is rejected. A window of
 * segmentation frames carries hundreds of thousands of polygon points, and
 * naming every one of them costs more than reading them all does.
 */
type ValidationPath = () => string;

function validatePoints(
  points: readonly { readonly x: number; readonly y: number }[] | undefined,
  path: ValidationPath,
  minimumLength: number,
) {
  if (!points) {
    return;
  }

  if (points.length < minimumLength) {
    throw new Error(
      `${path()}.points must contain at least ${minimumLength} points.`,
    );
  }

  for (let pointOffset = 0; pointOffset < points.length; pointOffset += 1) {
    const point = points[pointOffset];

    validateNumber(point.x, () => `${path()}.points[${pointOffset}].x`);
    validateNumber(point.y, () => `${path()}.points[${pointOffset}].y`);
  }
}

const NO_BOUNDS = {} as const;

function validateNumber(
  value: number,
  path: ValidationPath,
  options: {
    readonly exclusiveMin?: number;
    readonly integer?: boolean;
    readonly max?: number;
    readonly min?: number;
  } = NO_BOUNDS,
) {
  if (!Number.isFinite(value)) {
    throw new Error(`${path()} must be a finite number.`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${path()} must be an integer.`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(
      `${path()} must be greater than or equal to ${options.min}.`,
    );
  }

  if (options.exclusiveMin !== undefined && value <= options.exclusiveMin) {
    throw new Error(`${path()} must be greater than ${options.exclusiveMin}.`);
  }

  if (options.max !== undefined && value > options.max) {
    throw new Error(`${path()} must be less than or equal to ${options.max}.`);
  }
}

export function filterDetectionFramesForRange(
  detectionFrames: readonly DetectionFrame[],
  startTime: number,
  endTime: number,
): DetectionFrame[] {
  return detectionFrames.filter((frame) =>
    detectionFrameOverlapsRange(frame, startTime, endTime),
  );
}

export function selectDetectionFrame(
  detectionFrames: readonly DetectionFrame[],
  mediaTime: number,
  options: DetectionFrameSelectionOptions = {},
): DetectionFrame | undefined {
  if (options.selectionMode === DetectionFrameSelectionMode.NearestFrameIndex) {
    const selection = selectNearestFrameIndexDetectionFrame(
      detectionFrames,
      mediaTime,
      options.frameRate,
    );

    if (selection.isApplicable) {
      return selection.frame;
    }
  }

  return selectIntervalDetectionFrame(detectionFrames, mediaTime);
}

export function decodeCompressedRleMask(
  mask: DetectionMask,
): DecodedDetectionMask {
  if (mask.encoding !== DetectionMaskEncoding.CompressedRle) {
    throw new Error(`Unsupported detection mask encoding: ${mask.encoding}`);
  }

  const data = new Uint8Array(mask.width * mask.height);
  const counts = decodeCompressedRleCounts(mask.counts);
  let offset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index] ?? 0;
    const isForeground = index % 2 === 1;

    if (isForeground) {
      for (let runOffset = 0; runOffset < runLength; runOffset += 1) {
        const maskOffset = offset + runOffset;
        const x = Math.floor(maskOffset / mask.height);
        const y = maskOffset % mask.height;
        const rowMajorOffset = y * mask.width + x;

        if (rowMajorOffset < data.length) {
          data[rowMajorOffset] = 1;
        }
      }
    }

    offset += runLength;
  }

  return {
    data,
    height: mask.height,
    width: mask.width,
  };
}

function selectIntervalDetectionFrame(
  detectionFrames: readonly DetectionFrame[],
  mediaTime: number,
) {
  let selectedFrame: DetectionFrame | undefined;
  let low = 0;
  let high = detectionFrames.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const frame = detectionFrames[middle];

    if (hasDetectionFrameStarted(frame, mediaTime)) {
      selectedFrame = frame;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return selectedFrame && isDetectionFrameActive(selectedFrame, mediaTime)
    ? selectedFrame
    : undefined;
}

/**
 * The grid frame a playhead is standing on, or nothing.
 *
 * A frame at index `n` speaks for one step of the inference grid and no more,
 * so it is on screen from its own media time until the next index is due. An
 * index the source never produced leaves that step blank: the frames on either
 * side describe media the playhead is not on, and a source still being written
 * has a playback gate to hold the picture rather than a neighbour to borrow.
 */
function selectNearestFrameIndexDetectionFrame(
  detectionFrames: readonly DetectionFrame[],
  mediaTime: number,
  frameRate: number | undefined,
): NearestFrameIndexSelection {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) {
    return { frame: undefined, isApplicable: false };
  }

  const firstIndexedFrame = findIndexedDetectionFrame(detectionFrames, 1);
  const lastIndexedFrame = findIndexedDetectionFrame(detectionFrames, -1);

  if (!firstIndexedFrame || !lastIndexedFrame) {
    return { frame: undefined, isApplicable: false };
  }

  const gridStep =
    measureGridStep(firstIndexedFrame, lastIndexedFrame) ?? 1 / frameRate;
  const startedFrame = findLastStartedIndexedFrame(detectionFrames, mediaTime);

  return {
    frame:
      startedFrame &&
      mediaTime + PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS <
        startedFrame.mediaTime + gridStep
        ? startedFrame
        : undefined,
    isApplicable: true,
  };
}

/**
 * A grid step read off the frames instead of taken from `frameRate`.
 *
 * `frameRate` is what a manifest or an upload target says the grid is, and a
 * clip whose real rate differs walks a step further out of position for every
 * second that plays. The buffered frames carry the times the media itself
 * reported, and measuring across the widest index span present divides the
 * producer's millisecond rounding by that span.
 */
function measureGridStep(
  firstIndexedFrame: IndexedDetectionFrame,
  lastIndexedFrame: IndexedDetectionFrame,
) {
  const indexSpan = lastIndexedFrame.frameIndex - firstIndexedFrame.frameIndex;
  const step =
    (lastIndexedFrame.mediaTime - firstIndexedFrame.mediaTime) / indexSpan;

  return indexSpan > 0 && Number.isFinite(step) && step > 0 ? step : undefined;
}

function findIndexedDetectionFrame(
  detectionFrames: readonly DetectionFrame[],
  direction: 1 | -1,
) {
  const startOffset = direction === 1 ? 0 : detectionFrames.length - 1;

  for (
    let offset = startOffset;
    offset >= 0 && offset < detectionFrames.length;
    offset += direction
  ) {
    const frame = detectionFrames[offset];

    if (isIndexedDetectionFrame(frame)) {
      return frame;
    }
  }

  return undefined;
}

function findLastStartedIndexedFrame(
  detectionFrames: readonly DetectionFrame[],
  mediaTime: number,
) {
  let low = 0;
  let high = detectionFrames.length - 1;
  let startedOffset = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (hasDetectionFrameStarted(detectionFrames[middle], mediaTime)) {
      startedOffset = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  for (let offset = startedOffset; offset >= 0; offset -= 1) {
    const frame = detectionFrames[offset];

    if (isIndexedDetectionFrame(frame)) {
      return frame;
    }
  }

  return undefined;
}

function isIndexedDetectionFrame(
  frame: DetectionFrame,
): frame is IndexedDetectionFrame {
  return frame.frameIndex !== undefined;
}

function hasDetectionFrameStarted(frame: DetectionFrame, mediaTime: number) {
  return frame.mediaTime - PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS <= mediaTime;
}

function isDetectionFrameActive(frame: DetectionFrame, mediaTime: number) {
  return (
    hasDetectionFrameStarted(frame, mediaTime) &&
    (frame.endTime === undefined || mediaTime < frame.endTime)
  );
}

export function detectionFrameOverlapsRange(
  frame: DetectionFrame,
  startTime: number,
  endTime: number,
) {
  if (frame.endTime === undefined) {
    return frame.mediaTime >= startTime && frame.mediaTime <= endTime;
  }

  return frame.mediaTime <= endTime && frame.endTime > startTime;
}

export function decodeCompressedRleCounts(counts: string) {
  const decoded: number[] = [];
  let index = 0;

  while (index < counts.length) {
    let value = 0;
    let shift = 0;
    let charCode: number;

    do {
      charCode = counts.charCodeAt(index) - 48;
      index += 1;
      value |= (charCode & 0x1f) << shift;
      shift += 5;
    } while (charCode & 0x20);

    if (charCode & 0x10) {
      value |= -1 << shift;
    }

    if (decoded.length > 2) {
      value += decoded[decoded.length - 2] ?? 0;
    }

    decoded.push(value);
  }

  return decoded;
}

export function encodeCompressedRleCounts(counts: readonly number[]) {
  return counts
    .map((count, index) => {
      let value = index > 2 ? count - counts[index - 2]! : count;
      let encoded = "";
      let more = true;

      while (more) {
        let charCode = value & 0x1f;

        value >>= 5;
        more = !(
          (value === 0 && (charCode & 0x10) === 0) ||
          (value === -1 && (charCode & 0x10) !== 0)
        );

        if (more) {
          charCode |= 0x20;
        }

        encoded += String.fromCharCode(charCode + 48);
      }

      return encoded;
    })
    .join("");
}
