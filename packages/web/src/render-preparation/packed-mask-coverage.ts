import type { SerializableMaskInstruction } from "./mask-preparation-worker-protocol";
import {
  computeDetectionMaskRect,
  decodeCompressedRleCounts,
  MAX_ID_MASK_STROKE_WIDTH,
  type DetectionMask,
} from "supervision-js-core";

/** Independent coverage; eight horizontal pixels per byte, least-significant bit first. */
export interface PreparedPackedMaskCoverage {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly detectionIndex: number;
  readonly height: number;
  readonly width: number;
  /** Four-byte-aligned R8 texture row width. */
  readonly textureWidth: number;
  readonly sourceHeight: number;
  readonly sourceWidth: number;
  readonly x: number;
  readonly y: number;
}

/** Crops before allocating and walks COCO runs without materializing a full pixel plane. */
export function createPackedMaskCoverage(
  mask: DetectionMask,
  detectionIndex: number,
): PreparedPackedMaskCoverage | undefined {
  const bounds = computeDetectionMaskRect(mask);
  if (!bounds) return undefined;
  // The existing outline shader scans at most this far outside foreground.
  const padding = MAX_ID_MASK_STROKE_WIDTH + 1;
  const x = Math.max(0, bounds.x - bounds.width / 2 - padding);
  const y = Math.max(0, bounds.y - bounds.height / 2 - padding);
  const width = Math.min(mask.width, bounds.x + bounds.width / 2 + padding) - x;
  const height =
    Math.min(mask.height, bounds.y + bounds.height / 2 + padding) - y;
  const textureWidth = Math.ceil(Math.ceil(width / 8) / 4) * 4;
  const data = new Uint8Array(new ArrayBuffer(textureWidth * height));
  const counts = decodeCompressedRleCounts(mask.counts);
  let offset = 0;

  function fillRect(left: number, right: number, top: number, bottom: number) {
    if (left >= right || top >= bottom) return;
    const first = (left - x) >> 3;
    const last = (right - 1 - x) >> 3;
    const firstMask = (255 << ((left - x) & 7)) & 255;
    const lastMask = (1 << (((right - 1 - x) & 7) + 1)) - 1;
    for (let row = top - y; row < bottom - y; row += 1) {
      const start = row * textureWidth;
      if (first === last) data[start + first]! |= firstMask & lastMask;
      else {
        data[start + first]! |= firstMask;
        data.fill(255, start + first + 1, start + last);
        data[start + last]! |= lastMask;
      }
    }
  }

  for (let index = 0; index < counts.length; index += 1) {
    const start = offset;
    offset = Math.min(mask.width * mask.height, offset + counts[index]!);
    if (index % 2 === 0 || start >= offset) continue;
    let column = Math.floor(start / mask.height);
    const row = start % mask.height;
    const firstEnd = Math.min(offset, (column + 1) * mask.height);
    fillRect(column, column + 1, row, row + firstEnd - start);
    column += 1;
    const fullColumns = Math.floor((offset - firstEnd) / mask.height);
    fillRect(column, column + fullColumns, 0, mask.height);
    column += fullColumns;
    fillRect(column, column + 1, 0, (offset - firstEnd) % mask.height);
  }

  return {
    data,
    detectionIndex,
    height,
    width,
    textureWidth,
    sourceHeight: mask.height,
    sourceWidth: mask.width,
    x,
    y,
  };
}

/** Reads mask-space coverage, including holes and masks hidden by later detections. */
export function readPackedMaskCoverage(
  coverage: PreparedPackedMaskCoverage,
  x: number,
  y: number,
): boolean {
  const column = Math.floor(x) - coverage.x;
  const row = Math.floor(y) - coverage.y;
  if (
    column < 0 ||
    row < 0 ||
    column >= coverage.width ||
    row >= coverage.height
  )
    return false;
  return Boolean(
    coverage.data[row * coverage.textureWidth + (column >> 3)]! &
    (1 << (column & 7)),
  );
}

/** Keeps each visible semantic mask independent through the normal frame cook. */
export function createPackedMaskCoverageEntries(
  instructions: readonly SerializableMaskInstruction[],
): readonly PreparedPackedMaskCoverage[] {
  return instructions.flatMap((instruction) => {
    if (!instruction.mask || instruction.visible === false) return [];
    const entry = createPackedMaskCoverage(
      instruction.mask,
      instruction.detectionIndex,
    );
    return entry ? [entry] : [];
  });
}
