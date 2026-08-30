import type { MaskDrawInstruction } from "#types/mask-style";
import { decodeCompressedRleCounts } from "#utils/detection-frames";

/**
 * Palette slots an id raster can name, one of them the background. A GLSL
 * fragment stage is guaranteed only 224 uniform vectors, and a palette entry
 * costs 2.25 of them, so this stays a multiple of four and well inside that
 * budget; past it a frame draws from the RGBA composite instead.
 */
export const MAX_ID_MASK_PALETTE_ENTRIES = 80;
export const MAX_ID_MASK_STROKE_WIDTH = 16;

export interface IdMaskInstruction extends MaskDrawInstruction {
  readonly detectionIndex: number;
}

export interface IdMaskFrame {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly fillPalette: Float32Array<ArrayBuffer>;
  readonly hasStroke: boolean;
  readonly height: number;
  readonly maxStrokeWidth: number;
  /** The frame-wide mask width every stroke on this raster is scaled against. */
  readonly sourceWidth: number;
  readonly strokePalette: Float32Array<ArrayBuffer>;
  readonly strokeWidths: Float32Array<ArrayBuffer>;
  readonly width: number;
}

export interface IdMaskFrameOptions {
  /**
   * Widest raster to cook. A value at or above the instructions' own width
   * cooks at their width, and a smaller one keeps their aspect ratio.
   */
  readonly maxWidth?: number;
}

export function createIdMaskFrame(
  instructions: readonly IdMaskInstruction[],
  options: IdMaskFrameOptions = {},
): IdMaskFrame | undefined {
  if (instructions.length === 0) {
    return undefined;
  }

  const maskWidth = Math.max(...instructions.map(({ mask }) => mask.width));
  const maskHeight = Math.max(...instructions.map(({ mask }) => mask.height));
  const width = resolveRasterWidth(maskWidth, options.maxWidth);
  const height =
    width === maskWidth
      ? maskHeight
      : Math.max(1, Math.round((width * maskHeight) / maskWidth));
  const scaledAxes =
    width === maskWidth
      ? undefined
      : createScaledMaskAxes({ height, maskHeight, maskWidth, width });
  const data = new Uint8Array(new ArrayBuffer(width * height));
  const fillPalette = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4 * 4),
  );
  const strokePalette = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4 * 4),
  );
  const strokeWidths = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4),
  );
  let hasStroke = false;
  let maxStrokeWidth = 0;

  for (const instruction of instructions) {
    const detectionMaskId = resolveIdMaskPaletteId(instruction.detectionIndex);

    if (detectionMaskId === undefined) {
      return undefined;
    }

    writeIdMaskPaletteEntry(
      fillPalette,
      detectionMaskId,
      instruction.color,
      instruction.alpha,
    );

    if (instruction.stroke && instruction.stroke.width > 0) {
      const strokeWidth = resolveIdMaskStrokeTexels(
        instruction.stroke.width,
        maskWidth,
        width,
      );

      hasStroke = true;
      strokeWidths[detectionMaskId] = strokeWidth;
      maxStrokeWidth = Math.max(maxStrokeWidth, strokeWidth);
      writeIdMaskPaletteEntry(
        strokePalette,
        detectionMaskId,
        instruction.stroke.color,
        instruction.stroke.alpha,
      );
    }

    if (scaledAxes) {
      writeScaledMaskRuns(data, scaledAxes, instruction.mask, detectionMaskId);
    } else {
      writeMaskRuns(data, width, instruction.mask, detectionMaskId);
    }
  }

  return {
    data,
    fillPalette,
    hasStroke,
    height,
    maxStrokeWidth,
    sourceWidth: maskWidth,
    strokePalette,
    strokeWidths,
    width,
  };
}

/**
 * Compressed RLE counts runs down each column in turn, so a foreground run is
 * a contiguous walk down one column that wraps into the next.
 */
function writeMaskRuns(
  data: Uint8Array,
  frameWidth: number,
  mask: IdMaskInstruction["mask"],
  detectionMaskId: number,
) {
  const counts = decodeCompressedRleCounts(mask.counts);
  const maskWidth = mask.width;
  const maskHeight = mask.height;
  let maskOffset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index] ?? 0;

    if (index % 2 === 0 || runLength <= 0) {
      maskOffset += runLength;
      continue;
    }

    let x = Math.floor(maskOffset / maskHeight);
    let y = maskOffset - x * maskHeight;
    let frameOffset = y * frameWidth + x;

    for (let step = 0; step < runLength; step += 1) {
      if (x >= maskWidth) {
        break;
      }

      data[frameOffset] = detectionMaskId;
      y += 1;
      frameOffset += frameWidth;

      if (y === maskHeight) {
        y = 0;
        x += 1;
        frameOffset = x;
      }
    }

    maskOffset += runLength;
  }
}

/**
 * The scaled twin of writeMaskRuns. Every source pixel marks the texel it lands
 * in, so a mask keeps every part of itself the smaller raster can hold and
 * gains up to a texel at its edges.
 */
function writeScaledMaskRuns(
  data: Uint8Array,
  axes: ScaledMaskAxes,
  mask: IdMaskInstruction["mask"],
  detectionMaskId: number,
) {
  const counts = decodeCompressedRleCounts(mask.counts);
  const maskWidth = mask.width;
  const maskHeight = mask.height;
  let maskOffset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index] ?? 0;

    if (index % 2 === 0 || runLength <= 0) {
      maskOffset += runLength;
      continue;
    }

    let x = Math.floor(maskOffset / maskHeight);
    let y = maskOffset - x * maskHeight;
    let column = axes.columns[x];

    for (let step = 0; step < runLength; step += 1) {
      if (x >= maskWidth) {
        break;
      }

      data[axes.rows[y] + column] = detectionMaskId;
      y += 1;

      if (y === maskHeight) {
        y = 0;
        x += 1;
        column = axes.columns[x];
      }
    }

    maskOffset += runLength;
  }
}

function resolveRasterWidth(maskWidth: number, maxWidth: number | undefined) {
  return maxWidth !== undefined && maxWidth > 0 && maxWidth < maskWidth
    ? Math.max(1, Math.floor(maxWidth))
    : maskWidth;
}

/**
 * A stroke is measured in texels of the raster it is drawn on, so a coarser
 * raster measures it in coarser texels. A stroke of a texel or more keeps at
 * least one, the thinnest line the shader can draw; a narrower one keeps its
 * own width, which the shader draws as an inner boundary at any scale. The
 * ceiling is the widest neighbourhood the shaders scan, so a wider stroke would
 * be drawn at the ceiling anyway and every layer drawing the same annotation
 * has to arrive at the same width.
 */
export function resolveIdMaskStrokeTexels(
  strokeWidth: number,
  maskWidth: number,
  rasterWidth: number,
) {
  const scale = maskWidth > 0 ? rasterWidth / maskWidth : 1;

  return Math.min(
    Math.max(strokeWidth * scale, Math.min(strokeWidth, 1)),
    MAX_ID_MASK_STROKE_WIDTH,
  );
}

interface ScaledMaskAxes {
  readonly columns: Int32Array;
  readonly rows: Int32Array;
}

function createScaledMaskAxes(frame: {
  readonly height: number;
  readonly maskHeight: number;
  readonly maskWidth: number;
  readonly width: number;
}): ScaledMaskAxes {
  return {
    columns: createMaskAxisMap(frame.maskWidth, frame.width, 1),
    rows: createMaskAxisMap(frame.maskHeight, frame.height, frame.width),
  };
}

/** Rows hold their destination offset, so writing a run is two lookups. */
function createMaskAxisMap(
  sourceLength: number,
  targetLength: number,
  stride: number,
) {
  const map = new Int32Array(sourceLength);
  const scale = targetLength / sourceLength;

  for (let index = 0; index < sourceLength; index += 1) {
    map[index] = Math.min(targetLength - 1, Math.floor(index * scale)) * stride;
  }

  return map;
}

/**
 * The palette slot a detection index names, or undefined when the palette has
 * no slot for it. Slot zero is the background, so the ids start at one and the
 * last detection the palette can name sits one index below the last slot.
 */
export function resolveIdMaskPaletteId(detectionIndex: number) {
  const detectionMaskId = detectionIndex + 1;

  return detectionMaskId > 0 && detectionMaskId < MAX_ID_MASK_PALETTE_ENTRIES
    ? detectionMaskId
    : undefined;
}

export function writeIdMaskPaletteEntry(
  palette: Float32Array,
  detectionMaskId: number,
  color: number,
  alpha: number,
) {
  const offset = detectionMaskId * 4;

  palette[offset] = ((color >> 16) & 0xff) / 255;
  palette[offset + 1] = ((color >> 8) & 0xff) / 255;
  palette[offset + 2] = (color & 0xff) / 255;
  palette[offset + 3] = Math.max(0, Math.min(alpha, 1));
}
