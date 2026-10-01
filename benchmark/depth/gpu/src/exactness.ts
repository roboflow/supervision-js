import type { DepthMap, DepthPreviewLevels } from "supervision-js-core";
import { createDepthDraw, createLut } from "./depth-draw";
import type { BenchBackend } from "./pixi-backend";

/** Reserved codes typical of a preview track, and its top code, per level. */
const PREVIEW_CODES = {
  full: { reservedMax: 15, top: 255 },
  tv: { reservedMax: 31, top: 235 },
} as const;
const NO_DEPTH_COLOR = 0x0000ff;

export interface ExactnessCase {
  readonly backend: string;
  readonly name: string;
  readonly encoding: "scaled16" | "preview8";
  readonly width: number;
  readonly height: number;
  /** Texels per uploaded row, larger than `width` when WebGL rows are padded. */
  readonly textureWidth: number;
  /** Draws needed to see every code in the colour path's 8-bit output. */
  readonly passes: number;
  /** Distinct stored codes whose exact value came back. */
  readonly codesVerified: number;
  readonly codesInMap: number;
  readonly texelsChecked: number;
  readonly mismatches: number;
  readonly firstMismatches: readonly string[];
  readonly pass: boolean;
}

/**
 * Proves that every stored code reaches the shader exactly, through the
 * library's own upload (rg8 or r8, padded for WebGL where needed) and its own
 * depth shader, colour path included.
 *
 * The shader's output is 8 bits per channel, so one draw cannot show 16 bits.
 * Each draw therefore colours a window of 256 codes: with a scale of 1 the
 * value is the stored code, the range is `[256j, 256j + 255]`, and an identity
 * colour table puts `code - 256j` in red. Codes below the window read 0 and
 * codes above it 255, both checked too, and "no depth" paints pure blue. A
 * code that arrived off by one lands in the wrong red value of its own window.
 */
export async function runExactnessProbe(
  backend: BenchBackend,
): Promise<ExactnessCase[]> {
  const lut = createLut((index) => [index, index, 0]);
  const cases: ExactnessCase[] = [];

  try {
    cases.push(
      await probe(
        backend,
        lut,
        "rg8 every code, 256x256",
        scaledMap(256, 256, (i) => i),
      ),
      await probe(
        backend,
        lut,
        "rg8 odd width, 1279x52",
        scaledMap(1279, 52, (i) => (i * 40_503) & 0xffff),
      ),
      await probe(backend, lut, "r8 preview codes, 256x4", previewMap(256, 4)),
      await probe(
        backend,
        lut,
        "r8 preview codes, odd width 1279x3",
        previewMap(1279, 3),
      ),
      await probe(
        backend,
        lut,
        "r8 TV-range preview codes, 256x4",
        previewMap(256, 4, "tv"),
      ),
    );
  } finally {
    lut.destroy();
  }

  return cases;
}

async function probe(
  backend: BenchBackend,
  lut: ReturnType<typeof createLut>,
  name: string,
  map: DepthMap,
): Promise<ExactnessCase> {
  const draw = createDepthDraw(
    backend,
    { height: map.height, width: map.width },
    1,
  );
  const samples = map.samples;
  const values = samples.values;
  const texelCount = map.width * map.height;
  // Codes above the top code read as the top of the range.
  const expectedValue = (index: number) =>
    samples.encoding === "preview8"
      ? Math.min(values[index], samples.range.max + samples.reservedMax + 1) -
        samples.reservedMax -
        1
      : values[index];
  const isValid = (index: number) =>
    samples.encoding === "preview8"
      ? values[index] > samples.reservedMax
      : values[index] > 0;
  let maxValue = 0;

  for (let i = 0; i < texelCount; i += 1) {
    if (isValid(i)) maxValue = Math.max(maxValue, expectedValue(i));
  }

  const passes = Math.floor(maxValue / 256) + 1;
  const verified = new Set<number>();
  const firstMismatches: string[] = [];
  let mismatches = 0;
  let textureWidth = map.width;

  try {
    for (let window = 0; window < passes; window += 1) {
      const lo = window * 256;

      draw.draw(map, lut, {
        noDepthColor: NO_DEPTH_COLOR,
        range: { max: lo + 255, min: lo },
      });
      textureWidth = draw.ring.acquire(map).textureWidth;

      const pixels = await backend.readPixels(draw.target);

      for (let i = 0; i < texelCount; i += 1) {
        const p = i * 4;
        let expected: readonly [number, number, number, number];

        if (!isValid(i)) {
          expected = [0, 0, 255, 255];
        } else {
          const red = Math.min(255, Math.max(0, expectedValue(i) - lo));

          expected = [red, red, 0, 255];
        }

        if (
          pixels[p] !== expected[0] ||
          pixels[p + 1] !== expected[1] ||
          pixels[p + 2] !== expected[2] ||
          pixels[p + 3] !== expected[3]
        ) {
          mismatches += 1;
          if (firstMismatches.length < 5) {
            firstMismatches.push(
              `window ${window} texel (${i % map.width}, ${Math.floor(i / map.width)}) stored ${values[i]}: expected ${expected.join(",")}, got ${Array.from(pixels.subarray(p, p + 4)).join(",")}`,
            );
          }
        } else if (
          !isValid(i) ||
          (expectedValue(i) >= lo && expectedValue(i) <= lo + 255)
        ) {
          verified.add(values[i]);
        }
      }
    }
  } finally {
    draw.destroy();
  }

  return {
    backend: backend.description.rendererName,
    codesInMap: new Set(values).size,
    codesVerified: verified.size,
    encoding: map.samples.encoding,
    firstMismatches,
    height: map.height,
    mismatches,
    name,
    pass: mismatches === 0 && verified.size === new Set(values).size,
    passes,
    texelsChecked: texelCount * passes,
    textureWidth,
    width: map.width,
  };
}

function scaledMap(
  width: number,
  height: number,
  code: (index: number) => number,
): DepthMap {
  return {
    height,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      // A scale of 1 makes the value the shader colours the stored code.
      scale: 1,
      values: Uint16Array.from({ length: width * height }, (_, i) => code(i)),
    },
    width,
  };
}

function previewMap(
  width: number,
  height: number,
  levels: DepthPreviewLevels = "full",
): DepthMap {
  const { reservedMax, top } = PREVIEW_CODES[levels];
  const span = top - reservedMax - 1;

  return {
    height,
    kind: "disparity_px",
    samples: {
      encoding: "preview8",
      levels,
      // Code c stands for c - T - 1, so valid codes colour as 0..span.
      range: { max: span, min: 0 },
      reservedMax,
      values: Uint8Array.from({ length: width * height }, (_, i) => i & 0xff),
    },
    width,
  };
}
