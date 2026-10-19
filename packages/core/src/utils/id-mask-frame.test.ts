import { describe, expect, it } from "vitest";

import { DetectionMaskEncoding } from "#types/detections";
import { StrokeAlignment } from "#types/paint-style";
import { encodeCompressedRleCounts } from "#utils/detection-frames";
import { rasterizePolygonToMask } from "#utils/detection-conversions";
import { encodeBinaryMask } from "#utils/detection-masks";
import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
  createIdMaskFrame,
  resolveIdMaskStrokeTexels,
  type IdPolygonInstruction,
} from "#utils/id-mask-frame";

describe("id mask frame artifacts", () => {
  it("keeps fractional polygon edges on the same pixel grid", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        polygon: {
          height: 5,
          width: 5,
          points: [
            { x: 0.75, y: 1.25 },
            { x: 3.25, y: 1.25 },
            { x: 3.25, y: 3.75 },
            { x: 0.75, y: 3.75 },
          ],
        },
      },
    ]);

    expect(frame!.data).toEqual(
      Uint8Array.from([
        0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0,
        0,
      ]),
    );
  });

  it.each([undefined, 7, 3])(
    "matches encoded polygon coverage, overlap and strokes at raster width %s",
    (maxWidth) => {
      const polygons: IdPolygonInstruction[] = [
        {
          alpha: 0.25,
          color: 0x00ff00,
          detectionIndex: 1,
          polygon: {
            height: 9,
            width: 12,
            points: [
              { x: -2.25, y: 1.25 },
              { x: 10.75, y: 1.25 },
              { x: 10.75, y: 3.25 },
              { x: 2.25, y: 3.25 },
              { x: 2.25, y: 12.25 },
              { x: -2.25, y: 12.25 },
            ],
          },
          stroke: { alpha: 0.75, color: 0xffffff, width: 2.5 },
        },
        {
          alpha: 0.5,
          color: 0x0000ff,
          detectionIndex: 2,
          polygon: {
            height: 6,
            width: 8,
            points: [
              { x: 0.5, y: 0.25 },
              { x: 7.5, y: 5.75 },
              { x: 0.5, y: 5.75 },
              { x: 7.5, y: 0.25 },
            ],
          },
          stroke: { alpha: 1, color: 0xff0000, width: 0.5 },
        },
        {
          alpha: 1,
          color: 0xffffff,
          detectionIndex: 3,
          polygon: {
            height: 9,
            width: 12,
            points: [
              { x: 10.25, y: -1 },
              { x: 11.25, y: 10 },
              { x: 10.25, y: 10 },
            ],
          },
        },
      ];
      const encoded = polygons.map(({ polygon, ...instruction }) => ({
        ...instruction,
        mask: encodeBinaryMask(
          rasterizePolygonToMask(polygon.points, polygon),
          polygon.width,
          polygon.height,
        ),
      }));
      const background = maskInstruction(0, 12, 9, (x, y) => x + y > 6);
      const options = { maxWidth };

      expect(createIdMaskFrame([background, ...polygons], options)).toEqual(
        createIdMaskFrame([background, ...encoded], options),
      );
      expect(createIdMaskFrame([...polygons, background], options)).toEqual(
        createIdMaskFrame([...encoded, background], options),
      );
    },
  );

  it("rejects noninteger polygon media dimensions", () => {
    expect(() =>
      createIdMaskFrame([
        {
          alpha: 1,
          color: 0xffffff,
          detectionIndex: 0,
          polygon: {
            height: 4.5,
            width: 8,
            points: [
              { x: 0, y: 0 },
              { x: 8, y: 0 },
              { x: 0, y: 4 },
            ],
          },
        },
      ]),
    ).toThrow("Media dimensions must be positive integers.");
  });

  it("encodes detection ids and lets later detections render on top", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 2]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
      },
      {
        alpha: 0.25,
        color: 0x00ff00,
        detectionIndex: 1,
        mask: {
          counts: encodeCompressedRleCounts([1, 1, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect([...frame!.data]).toEqual([1, 2, 0]);
    expect([...frame!.fillPalette.slice(4, 12)]).toEqual([
      1, 0, 0, 0.5, 0, 1, 0, 0.25,
    ]);
  });

  it("preserves CSS stroke widths until the display density is known", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 1,
        color: 0x336699,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 1,
        },
        stroke: {
          alpha: 0.75,
          color: 0xffffff,
          width: MAX_ID_MASK_STROKE_WIDTH + 10,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect(frame!.hasStroke).toBe(true);
    expect(frame!.maxStrokeWidth).toBe(MAX_ID_MASK_STROKE_WIDTH + 10);
    expect(frame!.strokeWidths[1]).toBe(MAX_ID_MASK_STROKE_WIDTH + 10);
    expect(frame!.strokeAlignments![1]).toBe(0);
    expect([...frame!.strokePalette.slice(4, 8)]).toEqual([1, 1, 1, 0.75]);
  });

  it("cooks at the instructions' own resolution for a width it already fits", () => {
    const instructions = [
      maskInstruction(0, 16, 12, (x, y) => x >= 4 && y >= 3),
    ];
    const native = createIdMaskFrame(instructions);
    const asked = createIdMaskFrame(instructions, { maxWidth: 64 });
    const exact = createIdMaskFrame(instructions, { maxWidth: 16 });

    expect(asked!.width).toBe(16);
    expect(asked!.height).toBe(12);
    expect([...asked!.data]).toEqual([...native!.data]);
    expect([...exact!.data]).toEqual([...native!.data]);
  });

  it("fits a narrower raster inside the asked width and keeps the aspect", () => {
    const frame = createIdMaskFrame(
      [maskInstruction(0, 16, 12, (x, y) => x >= 4 && y >= 3)],
      { maxWidth: 8 },
    );

    expect(frame!.width).toBe(8);
    expect(frame!.height).toBe(6);
    expect(frame!.data.length).toBe(48);
  });

  it.each([undefined, 4])(
    "uses integer mask dimensions throughout a raster capped at %s",
    (maxWidth) => {
      const instruction = {
        alpha: 1,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 32]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 4,
          width: 8,
        },
      };
      const expected = createIdMaskFrame([instruction], { maxWidth })!;

      for (const [width, height] of [
        [8, 4.5],
        [8.5, 4],
        [8.5, 4.5],
      ]) {
        const actual = createIdMaskFrame(
          [{ ...instruction, mask: { ...instruction.mask, height, width } }],
          { maxWidth },
        )!;

        expect(actual.width).toBe(expected.width);
        expect(actual.height).toBe(expected.height);
        expect([...actual.data]).toEqual([...expected.data]);
        expect(actual.data.some((id) => id !== 0)).toBe(true);
      }
    },
  );

  it("keeps every masked pixel of the native cook inside the narrower one", () => {
    const instructions = [
      maskInstruction(0, 16, 12, (x, y) => x + y >= 6 && x + y <= 9),
      maskInstruction(1, 16, 12, (x, y) => x >= 12 && y <= 2),
    ];
    const native = createIdMaskFrame(instructions)!;
    const scaled = createIdMaskFrame(instructions, { maxWidth: 8 })!;
    const missing: string[] = [];

    for (let x = 0; x < native.width; x += 1) {
      for (let y = 0; y < native.height; y += 1) {
        const id = native.data[y * native.width + x];
        const scaledX = Math.floor((x * scaled.width) / native.width);
        const scaledY = Math.floor((y * scaled.height) / native.height);

        if (id > 0 && scaled.data[scaledY * scaled.width + scaledX] === 0) {
          missing.push(`${x},${y}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("hands a detection thinner than a texel to whichever instruction is last", () => {
    const frame = createIdMaskFrame(
      [
        maskInstruction(0, 16, 12, (x) => x === 0),
        maskInstruction(1, 16, 12, (x) => x === 1),
      ],
      { maxWidth: 8 },
    )!;

    expect([...frame.data]).not.toContain(1);
    expect([...frame.data]).toContain(2);
  });

  it("keeps CSS widths independent of preview raster reduction", () => {
    const strokeWidths = (maxWidth: number | undefined, width: number) =>
      createIdMaskFrame(
        [
          {
            ...maskInstruction(0, 16, 12, (x, y) => x >= 4 && y >= 3),
            stroke: { alpha: 1, color: 0xffffff, width },
          },
        ],
        { maxWidth },
      )!.strokeWidths[1];

    expect(strokeWidths(undefined, 2)).toBe(2);
    expect(strokeWidths(8, 2)).toBe(2);
    expect(strokeWidths(4, 2)).toBe(2);
    expect(strokeWidths(8, 4)).toBe(4);
    expect(strokeWidths(undefined, 0.5)).toBe(0.5);
    expect(strokeWidths(8, 0.5)).toBe(0.5);
  });

  it("keeps categorical ids and colors when only fractional border width changes", () => {
    const instruction = {
      ...maskInstruction(0, 16, 12, (x, y) => x >= 4 && y >= 3),
      stroke: { alpha: 0.75, color: 0xffffff, width: 2 },
    };
    const thin = createIdMaskFrame([instruction], { maxWidth: 4 })!;
    const wider = createIdMaskFrame(
      [{ ...instruction, stroke: { ...instruction.stroke, width: 4 } }],
      { maxWidth: 4 },
    )!;

    expect(thin.strokeWidths[1]).toBe(2);
    expect(wider.strokeWidths[1]).toBe(4);
    expect(thin.data).toEqual(wider.data);
    expect(thin.fillPalette).toEqual(wider.fillPalette);
    expect(thin.strokePalette).toEqual(wider.strokePalette);
  });

  it("stores total width and alignment without changing categorical coverage", () => {
    const instruction = maskInstruction(0, 16, 12, (x) => x >= 4);
    const frames = [
      StrokeAlignment.Outside,
      StrokeAlignment.Center,
      StrokeAlignment.Inside,
    ].map((alignment) =>
      createIdMaskFrame([
        {
          ...instruction,
          stroke: { alpha: 1, color: 0xffffff, width: 4, alignment },
        },
      ])!,
    );
    expect(frames.map((frame) => frame.strokeWidths[1])).toEqual([4, 4, 4]);
    expect(frames.map((frame) => frame.strokeAlignments![1])).toEqual([
      0, 0.5, 1,
    ]);
    expect(frames.map((frame) => frame.maxStrokeWidth)).toEqual([4, 2, 0]);
    expect(frames.every((frame) => frame.hasStroke)).toBe(true);
    expect(frames[1]!.data).toEqual(frames[0]!.data);
    expect(frames[2]!.data).toEqual(frames[0]!.data);
  });

  it("bounds each side after converting total CSS width to raster texels", () => {
    expect(resolveIdMaskStrokeTexels(3, 500, 1000)).toBe(6);
    expect(
      resolveIdMaskStrokeTexels(4, 500, 1000, StrokeAlignment.Center),
    ).toBe(8);
    expect(resolveIdMaskStrokeTexels(40, 500, 1000)).toBe(16);
    expect(
      resolveIdMaskStrokeTexels(40, 500, 1000, StrokeAlignment.Center),
    ).toBe(32);
    expect(resolveIdMaskStrokeTexels(0, 500, 1000)).toBe(0);
  });

  it("rejects artifacts that exceed the shader palette capacity", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 1,
        color: 0xffffff,
        detectionIndex: MAX_ID_MASK_PALETTE_ENTRIES,
        mask: {
          counts: encodeCompressedRleCounts([0, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 1,
        },
      },
    ]);

    expect(frame).toBeUndefined();
  });

  it("takes the last palette slot and refuses the one past it", () => {
    const paletteEntry = (detectionIndex: number) => ({
      alpha: 1,
      color: 0xffffff,
      detectionIndex,
      mask: {
        counts: encodeCompressedRleCounts([0, 1]),
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 1,
        width: 1,
      },
    });
    // Mask id zero is the background, so the last detection the palette can
    // name sits one index below the last slot.
    const lastNamedDetection = MAX_ID_MASK_PALETTE_ENTRIES - 2;
    const accepted = createIdMaskFrame([paletteEntry(lastNamedDetection)]);

    expect(accepted?.data[0]).toBe(MAX_ID_MASK_PALETTE_ENTRIES - 1);
    expect(accepted?.fillPalette).toHaveLength(MAX_ID_MASK_PALETTE_ENTRIES * 4);
    expect(
      createIdMaskFrame([paletteEntry(lastNamedDetection + 1)]),
    ).toBeUndefined();
  });

  it("cooks a frame of 65 detections rather than handing it to the compositor", () => {
    const frame = createIdMaskFrame(
      Array.from({ length: 65 }, (_unused, detectionIndex) =>
        maskInstruction(detectionIndex, 1, 1, () => true),
      ),
    );

    expect(frame?.data[0]).toBe(65);
  });

  it("keeps the palette a multiple of the four-wide stroke lanes the shaders read", () => {
    expect(MAX_ID_MASK_PALETTE_ENTRIES % 4).toBe(0);
  });
});

function maskInstruction(
  detectionIndex: number,
  width: number,
  height: number,
  isMasked: (x: number, y: number) => boolean,
) {
  return {
    alpha: 1,
    color: 0xffffff,
    detectionIndex,
    mask: {
      counts: encodeCompressedRleCounts(
        encodeColumnMajorRuns(width, height, isMasked),
      ),
      encoding: DetectionMaskEncoding.CompressedRle,
      height,
      width,
    },
  };
}

/** Compressed RLE alternates background and foreground runs down each column. */
function encodeColumnMajorRuns(
  width: number,
  height: number,
  isMasked: (x: number, y: number) => boolean,
) {
  const runs: number[] = [];
  let runLength = 0;
  let isForeground = false;

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      if (isMasked(x, y) === isForeground) {
        runLength += 1;
        continue;
      }

      runs.push(runLength);
      runLength = 1;
      isForeground = !isForeground;
    }
  }

  runs.push(runLength);

  return runs;
}
