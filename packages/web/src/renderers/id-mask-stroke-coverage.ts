import { MAX_ID_MASK_STROKE_WIDTH } from "supervision-js-core";

const coverageBody = `
  return clamp(0.5 + (width * (1.0 - alignment) - distance) / pixelWidth, 0.0, 1.0)
    - clamp(0.5 - (width * alignment + distance) / pixelWidth, 0.0, 1.0);
`;
const distanceBody = `
  return max(max(offset - position, position - offset - 1.0), 0.0);
`;
const radiusBody = `
  if (maxWidth < 0.0) {
    return 0.0;
  }
  return min(ceil(maxWidth + pixelWidth * 0.5), ${MAX_ID_MASK_STROKE_WIDTH + 1}.0);
`;

export const idMaskStrokeCoverageGlsl = `
float sampleMaskIdCell(ivec2 cell) {
  int x = clamp(cell.x, 0, int(uTextureSize.x) - 1);
  int y = clamp(cell.y, 0, int(uTextureSize.y) - 1);
  return floor(texelFetch(uTexture, ivec2(x, y), 0).r * 255.0 + 0.5);
}

float subtexelStrokeCoverage(float distance, float width, float alignment, float pixelWidth) {
  ${coverageBody}
}

float neighborCellDistance(float offset, float position) {
  ${distanceBody}
}

float strokeScanRadius(float maxWidth, float pixelWidth) {
  ${radiusBody}
}

float strokeWidthInTexels(float maskId, float pixelWidth) {
  float alignment = readStrokeAlignment(maskId);
  float sideFraction = max(alignment, 1.0 - alignment);
  return min(readStrokeWidth(maskId) * pixelWidth * uStrokePixelRatio, ${MAX_ID_MASK_STROKE_WIDTH}.0 / sideFraction);
}

float innerStrokeCoverage(float centerId, ivec2 sourceCell, vec2 cell, float width, float pixelWidth) {
  if (width <= 0.0) return 0.0;
  float alignment = readStrokeAlignment(centerId);
  int radius = int(strokeScanRadius(width * alignment, pixelWidth));
  float nearestDistance = width * alignment + pixelWidth * 0.5;
  float minimumDistance = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));

  for (int offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (int offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }
      float distance = max(
        neighborCellDistance(float(offsetX), cell.x),
        neighborCellDistance(float(offsetY), cell.y)
      );
      if (distance >= nearestDistance) {
        continue;
      }
      float maskId = sampleMaskIdCell(sourceCell + ivec2(offsetX, offsetY));
      if (differs(maskId, centerId)) {
        nearestDistance = distance;
        if (distance <= minimumDistance) {
          return subtexelStrokeCoverage(-distance, width, alignment, pixelWidth);
        }
      }
    }
  }
  return subtexelStrokeCoverage(-nearestDistance, width, alignment, pixelWidth);
}

// Descending offsets give the outer border its palette priority.
vec2 findNeighborStroke(float centerId, ivec2 sourceCell, vec2 cell, float pixelWidth) {
  float maxWidth = min(uMaxStrokeWidth * pixelWidth * uStrokePixelRatio, ${MAX_ID_MASK_STROKE_WIDTH}.0);
  int radius = int(strokeScanRadius(maxWidth, pixelWidth));
  vec2 stroke = vec2(0.0);
  float nearestDistance = maxWidth + pixelWidth * 0.5;
  float minimumDistance = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
  if (uBorderEnabled <= 0.5) return stroke;

  for (int offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (int offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      float distance = max(
        neighborCellDistance(float(offsetX), cell.x),
        neighborCellDistance(float(offsetY), cell.y)
      );
      if (distance >= nearestDistance) {
        continue;
      }
      float maskId = sampleMaskIdCell(sourceCell + ivec2(offsetX, offsetY));
      if (maskId < 0.5 || !differs(maskId, centerId) ||
          (stroke.x > 0.5 && differs(maskId, stroke.x))) {
        continue;
      }

      float width = strokeWidthInTexels(maskId, pixelWidth);
      if (width > 0.0 && readStroke(maskId).a > 0.0) {
        float coverage = subtexelStrokeCoverage(distance, width, readStrokeAlignment(maskId), pixelWidth);
        if (coverage > 0.0) {
          stroke = vec2(maskId, coverage);
          nearestDistance = distance;
          if (distance <= minimumDistance) {
            return stroke;
          }
        }
      }
    }
  }

  return stroke;
}
`;

export const idMaskStrokeCoverageWgsl = `
fn sampleMaskIdCell(cell: vec2<i32>) -> f32 {
  let x = clamp(cell.x, 0, i32(maskUniforms.uTextureSize.x) - 1);
  let y = clamp(cell.y, 0, i32(maskUniforms.uTextureSize.y) - 1);
  return floor(textureLoad(uTexture, vec2<i32>(x, y), 0).r * 255.0 + 0.5);
}

fn subtexelStrokeCoverage(distance: f32, width: f32, alignment: f32, pixelWidth: f32) -> f32 {
  ${coverageBody}
}

fn neighborCellDistance(offset: f32, position: f32) -> f32 {
  ${distanceBody}
}

fn strokeScanRadius(maxWidth: f32, pixelWidth: f32) -> f32 {
  ${radiusBody}
}

fn strokeWidthInTexels(maskId: f32, pixelWidth: f32) -> f32 {
  let alignment = readStrokeAlignment(maskId);
  let sideFraction = max(alignment, 1.0 - alignment);
  return min(readStrokeWidth(maskId) * pixelWidth * maskUniforms.uStrokePixelRatio, ${MAX_ID_MASK_STROKE_WIDTH}.0 / sideFraction);
}

fn innerStrokeCoverage(centerId: f32, sourceCell: vec2<i32>, cell: vec2<f32>, width: f32, pixelWidth: f32) -> f32 {
  if (width <= 0.0) { return 0.0; }
  let alignment = readStrokeAlignment(centerId);
  let radius = i32(strokeScanRadius(width * alignment, pixelWidth));
  var nearestDistance = width * alignment + pixelWidth * 0.5;
  let minimumDistance = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));

  for (var offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (var offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }
      let distance = max(
        neighborCellDistance(f32(offsetX), cell.x),
        neighborCellDistance(f32(offsetY), cell.y)
      );
      if (distance >= nearestDistance) {
        continue;
      }
      let maskId = sampleMaskIdCell(sourceCell + vec2<i32>(offsetX, offsetY));
      if (differs(maskId, centerId)) {
        nearestDistance = distance;
        if (distance <= minimumDistance) {
          return subtexelStrokeCoverage(-distance, width, alignment, pixelWidth);
        }
      }
    }
  }
  return subtexelStrokeCoverage(-nearestDistance, width, alignment, pixelWidth);
}

// Descending offsets give the outer border its palette priority.
fn findNeighborStroke(centerId: f32, sourceCell: vec2<i32>, cell: vec2<f32>, pixelWidth: f32) -> vec2<f32> {
  let maxWidth = min(maskUniforms.uMaxStrokeWidth * pixelWidth * maskUniforms.uStrokePixelRatio, ${MAX_ID_MASK_STROKE_WIDTH}.0);
  let radius = i32(strokeScanRadius(maxWidth, pixelWidth));
  var stroke = vec2<f32>(0.0);
  var nearestDistance = maxWidth + pixelWidth * 0.5;
  let minimumDistance = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
  if (maskUniforms.uBorderEnabled <= 0.5) { return stroke; }

  for (var offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (var offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      let distance = max(
        neighborCellDistance(f32(offsetX), cell.x),
        neighborCellDistance(f32(offsetY), cell.y)
      );
      if (distance >= nearestDistance) {
        continue;
      }
      let maskId = sampleMaskIdCell(sourceCell + vec2<i32>(offsetX, offsetY));
      if (maskId < 0.5 || !differs(maskId, centerId) ||
          (stroke.x > 0.5 && differs(maskId, stroke.x))) {
        continue;
      }

      let width = strokeWidthInTexels(maskId, pixelWidth);
      if (width > 0.0 && readStroke(maskId).a > 0.0) {
        let coverage = subtexelStrokeCoverage(distance, width, readStrokeAlignment(maskId), pixelWidth);
        if (coverage > 0.0) {
          stroke = vec2<f32>(maskId, coverage);
          nearestDistance = distance;
          if (distance <= minimumDistance) {
            return stroke;
          }
        }
      }
    }
  }

  return stroke;
}
`;
