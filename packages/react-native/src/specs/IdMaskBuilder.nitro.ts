import type { HybridObject } from "react-native-nitro-modules";

/**
 * Media-space bounding box of one serialized live detection.
 */
export interface IdMaskDetectionBBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * One serialized live detection handed to the native ID-mask fill loop.
 *
 * `mask` is a row-major byte mask of `maskWidth * maskHeight` where any
 * non-zero byte marks a covered pixel, exactly like the JS fallback builder.
 */
export interface IdMaskDetection {
  bbox: IdMaskDetectionBBox;
  className?: string;
  color: number;
  confidence?: number;
  mask: ArrayBuffer;
  maskHeight: number;
  maskWidth: number;
}

/**
 * Build input for one live ID-mask artifact.
 *
 * `maxPaletteEntries` and `maxStrokeWidth` mirror the core
 * `MAX_ID_MASK_PALETTE_ENTRIES` / `MAX_ID_MASK_STROKE_WIDTH` constants so the
 * native loop cannot drift from the JS semantics when core limits change.
 */
export interface IdMaskBuildOptions {
  borderWidth: number;
  detections: IdMaskDetection[];
  fillOpacity: number;
  frameHeight: number;
  frameWidth: number;
  maxPaletteEntries: number;
  maxPixels: number;
  maxSide: number;
  maxStrokeWidth: number;
}

/**
 * Native build output matching the JS live artifact byte-for-byte.
 *
 * `data` is `width * height` Alpha_8 detection-ID bytes. `fillPalette` and
 * `strokePalette` are Float32 RGBA entries (`maxPaletteEntries * 4` floats)
 * and `strokeWidths` is `maxPaletteEntries` Float32 values, matching the JS
 * shader uniform layout. `maskCount === 0` means no detection produced any
 * visible mask and callers should treat the artifact as absent.
 */
export interface IdMaskBuildArtifact {
  data: ArrayBuffer;
  /**
   * Half of the largest model-mask cell size in artifact texels, clamped to
   * [1, 12]. Drives the shader's edge feather radius.
   */
  edgeFeatherTexels: number;
  /**
   * Milliseconds the native fill loop itself took, excluding JSI argument and
   * result conversion. Lets callers separate fill cost from bridging cost.
   */
  fillMs: number;
  fillPalette: ArrayBuffer;
  hasStroke: boolean;
  height: number;
  maskCount: number;
  maxStrokeWidth: number;
  opacity: number;
  scale: number;
  strokePalette: ArrayBuffer;
  strokeWidths: ArrayBuffer;
  width: number;
}

/**
 * Experimental native builder for live detection-indexed Alpha_8 ID masks.
 *
 * iOS-only for now; Android intentionally stays unimplemented so callers fall
 * back to the JS builder.
 */
export interface IdMaskBuilder extends HybridObject<{ ios: "swift" }> {
  createArtifact(options: IdMaskBuildOptions): IdMaskBuildArtifact;
}
