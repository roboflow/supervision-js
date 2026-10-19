import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";

/** Packs width and alignment scalars within the fragment uniform budget. */
export const ID_MASK_STROKE_WIDTH_LANES = MAX_ID_MASK_PALETTE_ENTRIES / 4;

export const idMaskPaletteGlsl = `
uniform vec4 uFillPalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec4 uStrokePalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec4 uStrokeWidths[${ID_MASK_STROKE_WIDTH_LANES}];
uniform vec4 uStrokeAlignments[${ID_MASK_STROKE_WIDTH_LANES}];

int paletteIndex(float maskId) {
  return int(clamp(maskId, 0.0, float(${MAX_ID_MASK_PALETTE_ENTRIES - 1})));
}

vec4 readFill(float maskId) {
  return uFillPalette[paletteIndex(maskId)];
}

vec4 readStroke(float maskId) {
  return uStrokePalette[paletteIndex(maskId)];
}

float readStrokeWidth(float maskId) {
  int index = paletteIndex(maskId);

  return uStrokeWidths[index / 4][index % 4];
}

float readStrokeAlignment(float maskId) {
  int index = paletteIndex(maskId);
  return uStrokeAlignments[index / 4][index % 4];
}
`;

export const idMaskFillPaletteWgslField = `uFillPalette: array<vec4<f32>, ${MAX_ID_MASK_PALETTE_ENTRIES}>,`;

export const idMaskStrokePaletteWgslField = `uStrokePalette: array<vec4<f32>, ${MAX_ID_MASK_PALETTE_ENTRIES}>,`;

export const idMaskStrokeWidthsWgslField = `uStrokeWidths: array<vec4<f32>, ${ID_MASK_STROKE_WIDTH_LANES}>,`;
export const idMaskStrokeAlignmentsWgslField = `uStrokeAlignments: array<vec4<f32>, ${ID_MASK_STROKE_WIDTH_LANES}>,`;

/** Reads the uniform group a fragment stage must bind under the name maskUniforms. */
export const idMaskPaletteWgsl = `
fn paletteIndex(maskId: f32) -> i32 {
  return i32(clamp(maskId, 0.0, ${MAX_ID_MASK_PALETTE_ENTRIES - 1}.0));
}

fn readFill(maskId: f32) -> vec4<f32> {
  return maskUniforms.uFillPalette[paletteIndex(maskId)];
}

fn readStroke(maskId: f32) -> vec4<f32> {
  return maskUniforms.uStrokePalette[paletteIndex(maskId)];
}

fn readStrokeWidth(maskId: f32) -> f32 {
  let index = paletteIndex(maskId);

  return maskUniforms.uStrokeWidths[index / 4][index % 4];
}

fn readStrokeAlignment(maskId: f32) -> f32 {
  let index = paletteIndex(maskId);
  return maskUniforms.uStrokeAlignments[index / 4][index % 4];
}
`;
