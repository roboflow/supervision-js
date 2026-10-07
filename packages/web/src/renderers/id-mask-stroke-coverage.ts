import { MAX_ID_MASK_STROKE_WIDTH } from "supervision-js-core";

const coverageBody = `
  return clamp(0.5 + (width - distance) / pixelWidth, 0.0, 1.0)
    - clamp(0.5 - (width + distance) / pixelWidth, 0.0, 1.0);
`;
const distanceBody = `
  return max(max(offset - position, position - offset - 1.0), 0.0);
`;
const radiusBody = `
  if (fractionalWidth > 0.0) {
    return min(max(floor(maxWidth), ceil(fractionalWidth + pixelWidth * 0.5)), ${MAX_ID_MASK_STROKE_WIDTH}.0);
  }
  return min(floor(maxWidth), ${MAX_ID_MASK_STROKE_WIDTH}.0);
`;

export const idMaskStrokeCoverageGlsl = `
float subtexelStrokeCoverage(float distance, float width, float pixelWidth) {
  ${coverageBody}
}

float neighborCellDistance(float offset, float position) {
  ${distanceBody}
}

float strokeScanRadius(float maxWidth, float fractionalWidth, float pixelWidth) {
  ${radiusBody}
}

bool isBoundary(float centerId, vec2 texel) {
  return
    differs(sampleMaskId(vUV + vec2(texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(vUV + vec2(-texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(vUV + vec2(0.0, texel.y)), centerId) ||
    differs(sampleMaskId(vUV + vec2(0.0, -texel.y)), centerId);
}

float innerStrokeCoverage(float centerId, vec2 texel, vec2 cell, float width, float pixelWidth) {
  if (width >= 1.0) {
    return isBoundary(centerId, texel) ? 1.0 : 0.0;
  }

  float coverage = 0.0;
  if (differs(sampleMaskId(vUV + vec2(texel.x, 0.0)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(1.0 - cell.x, width, pixelWidth));
  }
  if (differs(sampleMaskId(vUV + vec2(-texel.x, 0.0)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(cell.x, width, pixelWidth));
  }
  if (differs(sampleMaskId(vUV + vec2(0.0, texel.y)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(1.0 - cell.y, width, pixelWidth));
  }
  if (differs(sampleMaskId(vUV + vec2(0.0, -texel.y)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(cell.y, width, pixelWidth));
  }
  return coverage;
}

// Descending offsets give the outer border its palette priority.
vec2 findNeighborStroke(float centerId, vec2 texel, vec2 cell, float pixelWidth) {
  int radius = int(strokeScanRadius(uMaxStrokeWidth, uMaxFractionalStrokeWidth, pixelWidth));

  for (int offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (int offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      float maskId = sampleMaskId(vUV + vec2(float(offsetX), float(offsetY)) * texel);
      if (maskId < 0.5 || !differs(maskId, centerId)) {
        continue;
      }

      float width = readStrokeWidth(maskId);
      if (width >= 1.0) {
        float distance = max(abs(float(offsetX)), abs(float(offsetY)));
        if (width >= distance && readStroke(maskId).a > 0.0) {
          return vec2(maskId, 1.0);
        }
      } else if (width > 0.0 && readStroke(maskId).a > 0.0) {
        float distance = max(
          neighborCellDistance(float(offsetX), cell.x),
          neighborCellDistance(float(offsetY), cell.y)
        );
        float coverage = subtexelStrokeCoverage(distance, width, pixelWidth);
        if (coverage > 0.0) {
          return vec2(maskId, coverage);
        }
      }
    }
  }

  return vec2(0.0);
}
`;

export const idMaskStrokeCoverageWgsl = `
fn subtexelStrokeCoverage(distance: f32, width: f32, pixelWidth: f32) -> f32 {
  ${coverageBody}
}

fn neighborCellDistance(offset: f32, position: f32) -> f32 {
  ${distanceBody}
}

fn strokeScanRadius(maxWidth: f32, fractionalWidth: f32, pixelWidth: f32) -> f32 {
  ${radiusBody}
}

fn isBoundary(uv: vec2<f32>, centerId: f32, texel: vec2<f32>) -> bool {
  return
    differs(sampleMaskId(uv + vec2<f32>(texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(uv + vec2<f32>(-texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(uv + vec2<f32>(0.0, texel.y)), centerId) ||
    differs(sampleMaskId(uv + vec2<f32>(0.0, -texel.y)), centerId);
}

fn innerStrokeCoverage(uv: vec2<f32>, centerId: f32, texel: vec2<f32>, cell: vec2<f32>, width: f32, pixelWidth: f32) -> f32 {
  if (width >= 1.0) {
    if (isBoundary(uv, centerId, texel)) {
      return 1.0;
    }
    return 0.0;
  }

  var coverage = 0.0;
  if (differs(sampleMaskId(uv + vec2<f32>(texel.x, 0.0)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(1.0 - cell.x, width, pixelWidth));
  }
  if (differs(sampleMaskId(uv + vec2<f32>(-texel.x, 0.0)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(cell.x, width, pixelWidth));
  }
  if (differs(sampleMaskId(uv + vec2<f32>(0.0, texel.y)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(1.0 - cell.y, width, pixelWidth));
  }
  if (differs(sampleMaskId(uv + vec2<f32>(0.0, -texel.y)), centerId)) {
    coverage = max(coverage, subtexelStrokeCoverage(cell.y, width, pixelWidth));
  }
  return coverage;
}

// Descending offsets give the outer border its palette priority.
fn findNeighborStroke(uv: vec2<f32>, centerId: f32, texel: vec2<f32>, cell: vec2<f32>, pixelWidth: f32) -> vec2<f32> {
  let radius = i32(strokeScanRadius(maskUniforms.uMaxStrokeWidth, maskUniforms.uMaxFractionalStrokeWidth, pixelWidth));

  for (var offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (var offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      let maskId = sampleMaskId(uv + vec2<f32>(f32(offsetX), f32(offsetY)) * texel);
      if (maskId < 0.5 || !differs(maskId, centerId)) {
        continue;
      }

      let width = readStrokeWidth(maskId);
      if (width >= 1.0) {
        let distance = max(abs(f32(offsetX)), abs(f32(offsetY)));
        if (width >= distance && readStroke(maskId).a > 0.0) {
          return vec2<f32>(maskId, 1.0);
        }
      } else if (width > 0.0 && readStroke(maskId).a > 0.0) {
        let distance = max(
          neighborCellDistance(f32(offsetX), cell.x),
          neighborCellDistance(f32(offsetY), cell.y)
        );
        let coverage = subtexelStrokeCoverage(distance, width, pixelWidth);
        if (coverage > 0.0) {
          return vec2<f32>(maskId, coverage);
        }
      }
    }
  }

  return vec2<f32>(0.0);
}
`;
