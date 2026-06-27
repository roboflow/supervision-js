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

export function copySortedDetectionFrames(
  detectionFrames: readonly DetectionFrame[] | undefined,
): DetectionFrame[] {
  validateDetectionFrames(detectionFrames ?? []);

  return (detectionFrames ?? [])
    .map((frame) => ({
      detections: frame.detections.map((detection) => ({
        ...detection,
        mask: detection.mask ? { ...detection.mask } : undefined,
        metadata: detection.metadata ? { ...detection.metadata } : undefined,
        rect: detection.rect ? { ...detection.rect } : undefined,
      })),
      endTime: frame.endTime,
      frameIndex: frame.frameIndex,
      mediaTime: frame.mediaTime,
    }))
    .sort((left, right) => left.mediaTime - right.mediaTime);
}

export function validateDetectionFrames(
  detectionFrames: readonly DetectionFrame[],
): void {
  for (const [frameOffset, frame] of detectionFrames.entries()) {
    validateNumber(frame.mediaTime, `frames[${frameOffset}].mediaTime`, {
      min: 0,
    });

    if (frame.endTime !== undefined) {
      validateNumber(frame.endTime, `frames[${frameOffset}].endTime`, {
        exclusiveMin: frame.mediaTime,
      });
    }

    if (frame.frameIndex !== undefined) {
      validateNumber(frame.frameIndex, `frames[${frameOffset}].frameIndex`, {
        integer: true,
        min: 0,
      });
    }

    for (const [detectionOffset, detection] of frame.detections.entries()) {
      const detectionPath = `frames[${frameOffset}].detections[${detectionOffset}]`;

      if (detection.confidence !== undefined) {
        validateNumber(detection.confidence, `${detectionPath}.confidence`, {
          max: 1,
          min: 0,
        });
      }

      if (
        detection.sourceId !== undefined &&
        typeof detection.sourceId !== "string"
      ) {
        throw new Error(`${detectionPath}.sourceId must be a string.`);
      }

      if (detection.sourceDetectionIndex !== undefined) {
        validateNumber(
          detection.sourceDetectionIndex,
          `${detectionPath}.sourceDetectionIndex`,
          {
            integer: true,
            min: 0,
          },
        );
      }

      if (detection.rect) {
        validateNumber(detection.rect.x, `${detectionPath}.rect.x`);
        validateNumber(detection.rect.y, `${detectionPath}.rect.y`);
        validateNumber(detection.rect.width, `${detectionPath}.rect.width`, {
          exclusiveMin: 0,
        });
        validateNumber(detection.rect.height, `${detectionPath}.rect.height`, {
          exclusiveMin: 0,
        });
      }

      if (detection.mask) {
        validateNumber(detection.mask.width, `${detectionPath}.mask.width`, {
          integer: true,
          exclusiveMin: 0,
        });
        validateNumber(detection.mask.height, `${detectionPath}.mask.height`, {
          integer: true,
          exclusiveMin: 0,
        });

        if (detection.mask.counts.length === 0) {
          throw new Error(`${detectionPath}.mask.counts must not be empty.`);
        }
      }
    }
  }
}

function validateNumber(
  value: number,
  path: string,
  options: {
    readonly exclusiveMin?: number;
    readonly integer?: boolean;
    readonly max?: number;
    readonly min?: number;
  } = {},
) {
  if (!Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer.`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`${path} must be greater than or equal to ${options.min}.`);
  }

  if (options.exclusiveMin !== undefined && value <= options.exclusiveMin) {
    throw new Error(`${path} must be greater than ${options.exclusiveMin}.`);
  }

  if (options.max !== undefined && value > options.max) {
    throw new Error(`${path} must be less than or equal to ${options.max}.`);
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
      options.frameIndexOriginTime,
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

    if (frame.mediaTime <= mediaTime) {
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

function selectNearestFrameIndexDetectionFrame(
  detectionFrames: readonly DetectionFrame[],
  mediaTime: number,
  frameRate: number | undefined,
  frameIndexOriginTime: number | undefined,
): NearestFrameIndexSelection {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) {
    return { frame: undefined, isApplicable: false };
  }

  const firstIndexedFrame = detectionFrames.find(
    (frame) => frame.frameIndex !== undefined,
  );

  if (!firstIndexedFrame || firstIndexedFrame.frameIndex === undefined) {
    return { frame: undefined, isApplicable: false };
  }

  const originTime =
    frameIndexOriginTime !== undefined
      ? frameIndexOriginTime
      : firstIndexedFrame.mediaTime - firstIndexedFrame.frameIndex / frameRate;
  const targetFrameIndex = Math.round((mediaTime - originTime) * frameRate);
  let nearestFrame: DetectionFrame | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const frame of detectionFrames) {
    if (frame.frameIndex === undefined) {
      continue;
    }

    const distance = Math.abs(frame.frameIndex - targetFrameIndex);

    if (
      distance < nearestDistance ||
      (distance === nearestDistance &&
        nearestFrame?.frameIndex !== undefined &&
        frame.frameIndex > nearestFrame.frameIndex)
    ) {
      nearestFrame = frame;
      nearestDistance = distance;
    }
  }

  return {
    frame: nearestDistance <= 1 ? nearestFrame : undefined,
    isApplicable: true,
  };
}

function isDetectionFrameActive(frame: DetectionFrame, mediaTime: number) {
  return (
    frame.mediaTime <= mediaTime &&
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

function decodeCompressedRleCounts(counts: string) {
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
