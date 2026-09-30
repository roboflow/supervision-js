import type { Resolution } from "./upload-render";

const MIB = 1024 * 1024;

/** The render-preparation defaults the build plan proposes (P6 tunes them). */
export const DEPTH_BUDGET_DEFAULTS = {
  exactNeighborFrameCount: 2,
  frameRate: 30,
  lutBytes: 256 * 4,
  maxExactCacheBytes: 128 * MIB,
  maxPreviewCacheBytes: 96 * MIB,
  previewRetainSeconds: 0.25,
  textureRingSlots: 3,
} as const;

export interface MemoryCase {
  readonly resolution: string;
  readonly exactFrameBytes: number;
  readonly confidenceFrameBytes: number;
  readonly previewFrameBytes: number;
  /** Exact frames the default cache holds, with and without confidence. */
  readonly exactCacheFrames: number;
  readonly exactCacheFramesWithConfidence: number;
  /** A still image: one exact map plus its confidence plane. */
  readonly stillImageCpuBytes: number;
  /** Peak extra CPU memory while one PNG decodes: the inflated rows. */
  readonly decodeTransientBytes: number;
  readonly previewWindowFrames: number;
  /** Seconds of preview ahead of the playhead the default budget allows. */
  readonly previewLeadSeconds: number;
  /** Ring slots at exact size plus one colour table per colormap in use. */
  readonly gpuRingBytes: number;
  readonly gpuLutBytes: number;
  /** The samples go up as their own bytes: no upload copy on little-endian hosts. */
  readonly uploadCopyBytes: number;
}

/**
 * CPU and GPU bytes at the proposed default budgets. These are computed from
 * the formats (2 bytes per exact sample, 1 per preview code or confidence
 * value), not read from the browser, which exposes no per-texture memory.
 */
export function computeMemoryCase(resolution: Resolution): MemoryCase {
  const pixels = resolution.width * resolution.height;
  const exactFrameBytes = pixels * 2;
  const previewFrameBytes = pixels;
  const previewWindowFrames = Math.floor(
    DEPTH_BUDGET_DEFAULTS.maxPreviewCacheBytes / previewFrameBytes,
  );

  return {
    confidenceFrameBytes: pixels,
    decodeTransientBytes: (resolution.width * 2 + 1) * resolution.height,
    exactCacheFrames: Math.floor(
      DEPTH_BUDGET_DEFAULTS.maxExactCacheBytes / exactFrameBytes,
    ),
    exactCacheFramesWithConfidence: Math.floor(
      DEPTH_BUDGET_DEFAULTS.maxExactCacheBytes / (exactFrameBytes + pixels),
    ),
    exactFrameBytes,
    gpuLutBytes: DEPTH_BUDGET_DEFAULTS.lutBytes,
    gpuRingBytes: DEPTH_BUDGET_DEFAULTS.textureRingSlots * exactFrameBytes,
    previewFrameBytes,
    previewLeadSeconds:
      previewWindowFrames / DEPTH_BUDGET_DEFAULTS.frameRate -
      DEPTH_BUDGET_DEFAULTS.previewRetainSeconds,
    previewWindowFrames,
    resolution: resolution.label,
    stillImageCpuBytes: exactFrameBytes + pixels,
    uploadCopyBytes: 0,
  };
}
