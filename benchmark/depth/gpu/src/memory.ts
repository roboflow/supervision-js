import { resolveDepthClipOptions } from "../../../../packages/web/src/render-preparation/depth/options";
import type { Resolution } from "./upload-render";

/**
 * The library's depth budgets for a 30 fps clip. The byte budgets scale with
 * the clip's resolution; `resolveDepthClipOptions` is the one place they are
 * set.
 */
export const DEPTH_BUDGET_DEFAULTS = {
  exactNeighborFrameCount: 2,
  frameRate: 30,
  lutBytes: 256 * 4,
  previewPrefetchSeconds: 1,
  previewRetainSeconds: 0.25,
  textureRingSlots: 3,
} as const;

export interface MemoryCase {
  readonly resolution: string;
  readonly maxExactCacheBytes: number;
  readonly maxPreviewCacheBytes: number;
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
  const budgets = resolveDepthClipOptions({
    exactFrameBytes,
    frameRate: DEPTH_BUDGET_DEFAULTS.frameRate,
    previewFrameBytes,
  });
  const maxExactCacheBytes = budgets.exact.maxCacheBytes;
  const maxPreviewCacheBytes = budgets.preview.maxCacheBytes;
  const previewWindowFrames = Math.floor(
    maxPreviewCacheBytes / previewFrameBytes,
  );

  return {
    confidenceFrameBytes: pixels,
    decodeTransientBytes: (resolution.width * 2 + 1) * resolution.height,
    exactCacheFrames: Math.floor(maxExactCacheBytes / exactFrameBytes),
    exactCacheFramesWithConfidence: Math.floor(
      maxExactCacheBytes / (exactFrameBytes + pixels),
    ),
    exactFrameBytes,
    maxExactCacheBytes,
    maxPreviewCacheBytes,
    gpuLutBytes: DEPTH_BUDGET_DEFAULTS.lutBytes,
    // One ring of exact textures and one of preview textures.
    gpuRingBytes:
      DEPTH_BUDGET_DEFAULTS.textureRingSlots *
      (exactFrameBytes + previewFrameBytes),
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
