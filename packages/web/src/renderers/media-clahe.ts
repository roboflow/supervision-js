const BINS = 256;
const TILE_COUNT = 8;
const CLIP_LIMIT = 2;

export function computeMediaClahe(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const tilesX = Math.min(TILE_COUNT, width);
  const tilesY = Math.min(TILE_COUNT, height);
  const luts = new Uint8Array(tilesX * tilesY * BINS);
  const histogram = new Uint32Array(BINS);

  for (let ty = 0; ty < tilesY; ty++) {
    const y0 = Math.floor((ty * height) / tilesY);
    const y1 = Math.floor(((ty + 1) * height) / tilesY);
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.floor((tx * width) / tilesX);
      const x1 = Math.floor(((tx + 1) * width) / tilesX);
      histogram.fill(0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const pixel = (y * width + x) * 4;
          const luma = Math.round(
            0.299 * rgba[pixel]! +
              0.587 * rgba[pixel + 1]! +
              0.114 * rgba[pixel + 2]!,
          );
          histogram[luma]!++;
        }
      }

      const area = (x1 - x0) * (y1 - y0);
      const limit = Math.max(1, Math.floor((CLIP_LIMIT * area) / BINS));
      let excess = 0;
      for (let i = 0; i < BINS; i++) {
        if (histogram[i]! > limit) {
          excess += histogram[i]! - limit;
          histogram[i] = limit;
        }
      }
      const perBin = Math.floor(excess / BINS);
      let residual = excess - perBin * BINS;
      for (let i = 0; i < BINS; i++) histogram[i]! += perBin;
      const residualStep = Math.max(
        Math.floor(BINS / Math.max(residual, 1)),
        1,
      );
      for (let i = 0; i < BINS && residual > 0; i += residualStep, residual--) {
        histogram[i]!++;
      }

      const offset = (ty * tilesX + tx) * BINS;
      let cumulative = 0;
      for (let i = 0; i < BINS; i++) {
        cumulative += histogram[i]!;
        luts[offset + i] = Math.round((cumulative * (BINS - 1)) / area);
      }
    }
  }

  return { luts, tilesX, tilesY };
}
