/**
 * Frame-index stamping: the ground truth a generated clip carries in its own
 * pixels, so a reader can name the frame it is looking at without trusting any
 * timestamp arithmetic.
 *
 * Every frame gets three marks:
 *
 * - A row of 16 blocks along the top edge. Block `i` is white when bit `i` of
 *   the zero-based frame index is set and black when it is clear, bit 0
 *   leftmost. Sixteen blocks address frame indexes 0..65535; past that the
 *   stamp wraps, which `MAX_STAMPED_FRAME_INDEX` names.
 * - The same index in decimal below the blocks, for a human reading a
 *   screenshot.
 * - A white marker square in the bottom-right corner. It says "this is a
 *   stamped clip" and it is the white reference the block reader thresholds
 *   against, so a squashed or shifted luma range cannot silently invert a bit.
 *
 * Blocks are large flat maximum-contrast areas, which is what survives lossy
 * compression, chroma subsampling and rescaling.
 */

export const BIT_BLOCK_COUNT = 16;
export const MAX_STAMPED_FRAME_INDEX = 2 ** BIT_BLOCK_COUNT - 1;

/**
 * Below this a block is too few pixels wide for its centre sample to stay clear
 * of the neighbouring block's ringing, and the decimal row stops being legible.
 */
export const MIN_STAMP_WIDTH = 128;
export const MIN_STAMP_HEIGHT = 64;

const DIGIT_GLYPH_WIDTH = 5;
const DIGIT_GLYPH_HEIGHT = 7;
const DIGIT_GLYPHS = [
  [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
];

export function isStampable({ width, height }) {
  return width >= MIN_STAMP_WIDTH && height >= MIN_STAMP_HEIGHT;
}

/**
 * Block heights are forced even so the row never straddles a chroma pair in a
 * 4:2:0 clip.
 */
export function blockHeightFor(height) {
  return Math.max(8, 2 * Math.round(height / 40));
}

export function digitScaleFor(height) {
  return Math.min(12, Math.max(2, Math.floor(height / 60)));
}

/**
 * Sample points are fractions of the frame, not pixels, so a consumer reading a
 * scaled or letterboxed copy multiplies by whatever dimensions it actually has.
 * Bit `i` sits at the horizontal centre of its block, `(i + 0.5) / 16`, which
 * stays inside the block at any width the stamp is allowed at.
 */
export function stampGeometry({ width, height }) {
  if (!isStampable({ width, height })) {
    throw new Error(
      `${width}x${height} is below the ${MIN_STAMP_WIDTH}x${MIN_STAMP_HEIGHT} minimum a frame stamp needs.`,
    );
  }

  const blockHeight = blockHeightFor(height);
  const markerSize = blockHeight;

  return {
    bitBlockCount: BIT_BLOCK_COUNT,
    blockHeight,
    markerSize,
    maxStampedFrameIndex: MAX_STAMPED_FRAME_INDEX,
    samplePoints: {
      bits: Array.from({ length: BIT_BLOCK_COUNT }, (_unused, index) => ({
        bit: index,
        x: (index + 0.5) / BIT_BLOCK_COUNT,
        y: blockHeight / 2 / height,
      })),
      marker: {
        x: (width - markerSize / 2) / width,
        y: (height - markerSize / 2) / height,
      },
    },
  };
}

export function frameIndexToBits(frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error(
      `Frame index must be a non-negative integer, got ${frameIndex}.`,
    );
  }

  const wrapped = frameIndex % (MAX_STAMPED_FRAME_INDEX + 1);

  return Array.from(
    { length: BIT_BLOCK_COUNT },
    (_unused, bit) => ((wrapped >> bit) & 1) === 1,
  );
}

export function bitsToFrameIndex(bits) {
  if (bits.length !== BIT_BLOCK_COUNT) {
    throw new Error(
      `A frame stamp has ${BIT_BLOCK_COUNT} bits, got ${bits.length}.`,
    );
  }

  return bits.reduce((total, set, bit) => (set ? total + 2 ** bit : total), 0);
}

/** Overwrites the stamp regions of an already-populated RGB24 frame. */
export function applyFrameStamp(rgb, { width, height, frameIndex }) {
  const expectedLength = width * height * 3;

  if (rgb.length !== expectedLength) {
    throw new Error(
      `A ${width}x${height} RGB24 frame is ${expectedLength} bytes, got ${rgb.length}.`,
    );
  }

  const geometry = stampGeometry({ width, height });

  drawDecimalIndex(rgb, { frameIndex, geometry, height, width });
  drawBitBlocks(rgb, { frameIndex, geometry, height, width });
  drawMarker(rgb, { geometry, height, width });

  return rgb;
}

export function drawSyntheticFrame(rgb, { width, height, frameIndex }) {
  drawMovingContent(rgb, { frameIndex, height, width });

  return applyFrameStamp(rgb, { frameIndex, height, width });
}

/**
 * Stand-in content for the one axis no real source can serve cheaply: a frame
 * count near the engine's ceiling, which has to be generated at a tiny
 * resolution. A shifting gradient and a travelling square, so motion estimation
 * and long GOPs still have residual to work on.
 */
function drawMovingContent(rgb, { frameIndex, height, width }) {
  for (let y = 0; y < height; y += 1) {
    const value = (y * 4 + frameIndex * 3) & 255;
    const rowStart = y * width * 3;

    rgb[rowStart] = value >> 2;
    rgb[rowStart + 1] = value >> 1;
    rgb[rowStart + 2] = value;

    for (let x = 1; x < width; x += 1) {
      rgb.copyWithin(rowStart + x * 3, rowStart, rowStart + 3);
    }
  }

  const side = Math.max(8, Math.round(Math.min(width, height) / 6));
  const travel = Math.max(1, width - side);
  const left = (frameIndex * 7) % travel;
  const top = Math.max(0, Math.round((height - side) / 2));

  fillRect(rgb, width, {
    b: 40,
    g: 210,
    height: Math.min(side, height - top),
    left,
    r: 240,
    top,
    width: Math.min(side, width - left),
  });
}

function drawDecimalIndex(rgb, { frameIndex, geometry, height, width }) {
  const scale = digitScaleFor(height);
  const digits = String(frameIndex % (MAX_STAMPED_FRAME_INDEX + 1)).split("");
  const advance = (DIGIT_GLYPH_WIDTH + 1) * scale;
  const textTop = geometry.blockHeight + scale;
  const textHeight = DIGIT_GLYPH_HEIGHT * scale;
  const textWidth = Math.min(width, digits.length * advance + scale);

  if (textTop + textHeight > height) {
    return;
  }

  fillRect(rgb, width, {
    b: 0,
    g: 0,
    height: textHeight + scale,
    left: 0,
    r: 0,
    top: geometry.blockHeight,
    width: textWidth,
  });

  digits.forEach((digit, position) => {
    const glyph = DIGIT_GLYPHS[Number(digit)];
    const glyphLeft = position * advance + scale;

    for (let row = 0; row < DIGIT_GLYPH_HEIGHT; row += 1) {
      for (let column = 0; column < DIGIT_GLYPH_WIDTH; column += 1) {
        const lit = (glyph[row] >> (DIGIT_GLYPH_WIDTH - 1 - column)) & 1;

        if (!lit) {
          continue;
        }

        fillRect(rgb, width, {
          b: 255,
          g: 255,
          height: scale,
          left: glyphLeft + column * scale,
          r: 255,
          top: textTop + row * scale,
          width: scale,
        });
      }
    }
  });
}

function drawBitBlocks(rgb, { frameIndex, geometry, width }) {
  const bits = frameIndexToBits(frameIndex);

  bits.forEach((set, bit) => {
    const left = Math.round((bit * width) / BIT_BLOCK_COUNT);
    const right = Math.round(((bit + 1) * width) / BIT_BLOCK_COUNT);
    const level = set ? 255 : 0;

    fillRect(rgb, width, {
      b: level,
      g: level,
      height: geometry.blockHeight,
      left,
      r: level,
      top: 0,
      width: right - left,
    });
  });
}

function drawMarker(rgb, { geometry, height, width }) {
  fillRect(rgb, width, {
    b: 255,
    g: 255,
    height: geometry.markerSize,
    left: width - geometry.markerSize,
    r: 255,
    top: height - geometry.markerSize,
    width: geometry.markerSize,
  });
}

function fillRect(
  rgb,
  width,
  { b, g, height, left, r, top, width: rectWidth },
) {
  for (let y = top; y < top + height; y += 1) {
    const rowStart = (y * width + left) * 3;

    for (let x = 0; x < rectWidth; x += 1) {
      rgb[rowStart + x * 3] = r;
      rgb[rowStart + x * 3 + 1] = g;
      rgb[rowStart + x * 3 + 2] = b;
    }
  }
}

function lumaAt(rgb, { fraction, height, width }) {
  const x = Math.min(width - 1, Math.floor(fraction.x * width));
  const y = Math.min(height - 1, Math.floor(fraction.y * height));
  const offset = (y * width + x) * 3;

  return (
    0.299 * rgb[offset] + 0.587 * rgb[offset + 1] + 0.114 * rgb[offset + 2]
  );
}

/**
 * Reads a decoded RGB24 frame back. The marker is the white reference: a frame
 * whose marker is not bright was never stamped, or was cropped, rotated or
 * letterboxed on the way here, and reporting that is more useful than returning
 * an index derived from whatever happened to be at those coordinates.
 */
export function readFrameStamp(rgb, { width, height }) {
  const geometry = stampGeometry({ width, height });
  const markerLuma = lumaAt(rgb, {
    fraction: geometry.samplePoints.marker,
    height,
    width,
  });

  const blockLuma = geometry.samplePoints.bits.map((point) =>
    lumaAt(rgb, { fraction: point, height, width }),
  );

  if (markerLuma < 128) {
    return {
      blockLuma,
      frameIndex: null,
      markerLuma,
      reason: `marker luma ${markerLuma.toFixed(1)} is below 128; this frame does not read as stamped`,
    };
  }

  const threshold = Math.max(32, markerLuma / 2);
  const bits = blockLuma.map((luma) => luma >= threshold);

  return {
    bits,
    blockLuma,
    frameIndex: bitsToFrameIndex(bits),
    markerLuma,
    threshold,
  };
}
