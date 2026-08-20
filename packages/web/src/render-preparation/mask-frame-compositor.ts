import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import type { MaskStrokeStyle } from "supervision-js-core";
import {
  createIdMaskFrame,
  decodeDetectionMask,
  encodeBinaryMask,
  rasterizePolygonToMask,
  type IdMaskInstruction,
  type IdMaskFrame,
} from "supervision-js-core";
export {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
  createIdMaskFrame,
  type IdMaskFrame,
} from "supervision-js-core";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface DecodedMaskPixels {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

interface RgbaColor {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

export interface CompositedMaskFrame {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly height: number;
  readonly width: number;
}

export interface PngIdMaskFrame extends IdMaskFrame {
  readonly png: Uint8Array<ArrayBuffer>;
}

export function compositeMaskFrame(
  instructions: readonly SerializableMaskInstruction[],
): CompositedMaskFrame | undefined {
  const maskInstructions = materializeMaskInstructions(instructions);

  if (maskInstructions.length === 0) {
    return undefined;
  }

  const width = Math.max(...maskInstructions.map(({ mask }) => mask.width));
  const height = Math.max(...maskInstructions.map(({ mask }) => mask.height));
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  for (const instruction of maskInstructions) {
    compositeInstruction(data, width, instruction);
  }

  return { data, height, width };
}

export function createMaskIdFrame(
  instructions: readonly SerializableMaskInstruction[],
) {
  return createIdMaskFrame(materializeMaskInstructions(instructions));
}

export async function createPngIdMaskFrame(
  instructions: readonly SerializableMaskInstruction[],
): Promise<PngIdMaskFrame | undefined> {
  const frame = createMaskIdFrame(instructions);

  if (!frame) {
    return undefined;
  }

  return {
    ...frame,
    png: await encodeGrayscalePng({
      height: frame.height,
      pixels: frame.data,
      width: frame.width,
    }),
  };
}

function compositeInstruction(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  instruction: IdMaskInstruction,
) {
  const decodedMask = decodeDetectionMask(instruction.mask);
  const fill = resolveRgbaColor(instruction.color, instruction.alpha);

  compositeMaskFill(rgba, canvasWidth, decodedMask, fill);

  if (instruction.stroke) {
    compositeMaskStroke(rgba, canvasWidth, decodedMask, instruction.stroke);
  }
}

function materializeMaskInstructions(
  instructions: readonly SerializableMaskInstruction[],
): IdMaskInstruction[] {
  return instructions.map((instruction) => {
    if (instruction.mask) {
      return instruction;
    }

    const { height, points, width } = instruction.polygon;

    return {
      alpha: instruction.alpha,
      color: instruction.color,
      detectionIndex: instruction.detectionIndex,
      mask: encodeBinaryMask(
        rasterizePolygonToMask(points, { height, width }),
        width,
        height,
      ),
      stroke: instruction.stroke,
    };
  });
}

function compositeMaskFill(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  decodedMask: DecodedMaskPixels,
  fill: RgbaColor,
) {
  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      const maskOffset = y * decodedMask.width + x;

      if (!decodedMask.data[maskOffset]) {
        continue;
      }

      writePixel(rgba, canvasWidth, x, y, fill);
    }
  }
}

function compositeMaskStroke(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  decodedMask: DecodedMaskPixels,
  stroke: MaskStrokeStyle,
) {
  const width = Math.round(stroke.width);

  if (width <= 0) {
    return;
  }

  const strokeColor = resolveRgbaColor(stroke.color, stroke.alpha);

  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      if (
        !isMaskPixel(decodedMask, x, y) ||
        !isBoundaryPixel(decodedMask, x, y)
      ) {
        continue;
      }

      for (let offsetY = -width; offsetY <= width; offsetY += 1) {
        for (let offsetX = -width; offsetX <= width; offsetX += 1) {
          const strokeX = x + offsetX;
          const strokeY = y + offsetY;

          if (
            isOutsideMaskBounds(decodedMask, strokeX, strokeY) ||
            isMaskPixel(decodedMask, strokeX, strokeY)
          ) {
            continue;
          }

          writePixel(rgba, canvasWidth, strokeX, strokeY, strokeColor);
        }
      }
    }
  }
}

function isBoundaryPixel(mask: DecodedMaskPixels, x: number, y: number) {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) {
        continue;
      }

      const neighborX = x + offsetX;
      const neighborY = y + offsetY;

      if (
        isOutsideMaskBounds(mask, neighborX, neighborY) ||
        !isMaskPixel(mask, neighborX, neighborY)
      ) {
        return true;
      }
    }
  }

  return false;
}

function isMaskPixel(mask: DecodedMaskPixels, x: number, y: number) {
  return mask.data[y * mask.width + x] === 1;
}

function isOutsideMaskBounds(mask: DecodedMaskPixels, x: number, y: number) {
  return x < 0 || y < 0 || x >= mask.width || y >= mask.height;
}

function resolveRgbaColor(color: number, alpha: number): RgbaColor {
  return {
    alpha: Math.round(Math.max(0, Math.min(alpha, 1)) * 255),
    blue: color & 0xff,
    green: (color >> 8) & 0xff,
    red: (color >> 16) & 0xff,
  };
}

function writePixel(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  x: number,
  y: number,
  color: RgbaColor,
) {
  const rgbaOffset = (y * canvasWidth + x) * 4;

  rgba[rgbaOffset] = color.red;
  rgba[rgbaOffset + 1] = color.green;
  rgba[rgbaOffset + 2] = color.blue;
  rgba[rgbaOffset + 3] = color.alpha;
}

async function encodeGrayscalePng(options: {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly width: number;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream is required to encode PNG ID masks.");
  }

  const rawScanlines = createFilterlessPngScanlines(options);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);

  ihdrView.setUint32(0, options.width);
  ihdrView.setUint32(4, options.height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = new Uint8Array(
    await new Response(
      new Blob([rawScanlines])
        .stream()
        .pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

  return concatUint8Arrays([
    PNG_SIGNATURE,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", new Uint8Array(0)),
  ]);
}

function createFilterlessPngScanlines(options: {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly width: number;
}) {
  const rowStride = options.width + 1;
  const scanlines = new Uint8Array(rowStride * options.height);

  for (let y = 0; y < options.height; y += 1) {
    const sourceOffset = y * options.width;
    const targetOffset = y * rowStride;

    scanlines[targetOffset] = 0;
    scanlines.set(
      options.pixels.subarray(sourceOffset, sourceOffset + options.width),
      targetOffset + 1,
    );
  }

  return scanlines;
}

function createPngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(concatUint8Arrays([typeBytes, data])));

  return chunk;
}

const crc32Table = createCrc32Table();

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function concatUint8Arrays(
  chunks: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
