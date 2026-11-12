import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  StrokeAlignment,
  type MaskDrawInstruction,
} from "supervision-js-core";
import type { PixiIdMaskPaint } from "./pixi-id-mask-shader";
import type { PreparedPackedMaskCoverage } from "#render-preparation/packed-mask-coverage";

/** ID 1 denotes this unit's foreground; detection identity remains on the coverage entry. */
export function createPackedMaskPaint(
  coverage: PreparedPackedMaskCoverage,
  instruction: MaskDrawInstruction,
  mediaWidth: number,
  viewportScale: number,
  opacity = 1,
  previous?: PixiIdMaskPaint,
): PixiIdMaskPaint {
  const fillPalette =
    previous?.fillPalette ?? new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  const strokePalette =
    previous?.strokePalette ??
    new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  const strokeWidths =
    previous?.strokeWidths ?? new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  const strokeAlignments =
    previous?.strokeAlignments ?? new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  // Pixi's mesh tint already premultiplies its own alpha. Keep this mesh opaque
  // and apply the public mask-style opacity once, alongside the paint alpha.
  paint(fillPalette, instruction.color, instruction.alpha * opacity);
  const stroke = instruction.stroke;
  const alignment =
    stroke?.alignment === StrokeAlignment.Inside
      ? 1
      : stroke?.alignment === StrokeAlignment.Center
        ? 0.5
        : 0;
  const width =
    stroke?.widthUnit === "mask"
      ? (2 * stroke.width * mediaWidth * viewportScale) / coverage.sourceWidth
      : (stroke?.width ?? 0);
  paint(strokePalette, stroke?.color ?? 0, (stroke?.alpha ?? 0) * opacity);
  strokeWidths[1] = width;
  strokeAlignments[1] = alignment;
  return {
    fillPalette,
    strokeOverFill: stroke?.widthUnit !== undefined,
    strokePalette,
    strokeWidths,
    strokeAlignments,
    hasStroke: Boolean(stroke && stroke.alpha * opacity > 0 && width > 0),
    height: coverage.height,
    width: coverage.width,
    maxStrokeWidth: width * (1 - alignment),
  };
}

function paint(palette: Float32Array, color: number, alpha: number) {
  palette[4] = ((color >> 16) & 255) / 255;
  palette[5] = ((color >> 8) & 255) / 255;
  palette[6] = (color & 255) / 255;
  palette[7] = Math.max(0, Math.min(1, alpha));
}

/**
 * Paint for one id-raster detection drawn on its own: its palette slot moves to
 * ID 1, and the public mask-style opacity is applied once, as for a styled unit.
 */
export function createPaletteSlotPaint(
  frame: PixiIdMaskPaint,
  coverage: PreparedPackedMaskCoverage,
  opacity: number,
  previous?: PixiIdMaskPaint,
): PixiIdMaskPaint {
  const id = coverage.detectionIndex + 1;
  const fillPalette =
    previous?.fillPalette ?? new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  const strokePalette =
    previous?.strokePalette ??
    new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  const strokeWidths =
    previous?.strokeWidths ?? new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  const strokeAlignments =
    previous?.strokeAlignments ?? new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  fillPalette.set(frame.fillPalette.subarray(id * 4, id * 4 + 4), 4);
  strokePalette.set(frame.strokePalette.subarray(id * 4, id * 4 + 4), 4);
  fillPalette[7] = fillPalette[7]! * opacity;
  strokePalette[7] = strokePalette[7]! * opacity;
  const width = frame.strokeWidths[id] ?? 0;
  const alignment = frame.strokeAlignments?.[id] ?? 0;
  strokeWidths[1] = width;
  strokeAlignments[1] = alignment;
  return {
    fillPalette,
    strokePalette,
    strokeWidths,
    strokeAlignments,
    hasStroke: width > 0 && strokePalette[7]! > 0,
    height: coverage.height,
    width: coverage.width,
    maxStrokeWidth: width * (1 - alignment),
  };
}

/** The frame's paint with these detections drawing nothing from the raster. */
export function clearPaletteDetections(
  frame: PixiIdMaskPaint,
  detectionIndices: Iterable<number>,
): PixiIdMaskPaint {
  const fillPalette = frame.fillPalette.slice();
  const strokePalette = frame.strokePalette.slice();
  const strokeWidths = frame.strokeWidths.slice();
  for (const detectionIndex of detectionIndices) {
    const id = detectionIndex + 1;
    fillPalette[id * 4 + 3] = 0;
    strokePalette[id * 4 + 3] = 0;
    strokeWidths[id] = 0;
  }
  return {
    fillPalette,
    hasStroke: frame.hasStroke,
    height: frame.height,
    maxStrokeWidth: frame.maxStrokeWidth,
    strokeAlignments: frame.strokeAlignments,
    strokeOverFill: frame.strokeOverFill,
    strokePalette,
    strokeWidths,
    width: frame.width,
  };
}
