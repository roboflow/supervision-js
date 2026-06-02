/**
 * Axis-aligned rectangle in media pixel coordinates.
 *
 * This is semantic detection geometry, not a renderer shape. Presentation
 * details such as stroke, fill, corner radius, or opacity belong to box styles.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export enum DetectionMaskEncoding {
  CompressedRle = "compressedRle",
}

/**
 * Compressed run-length encoded binary mask.
 *
 * RLE is the semantic cold-storage representation. Renderers may convert it
 * into prepared runtime artifacts such as ID masks, textures, or other backend
 * specific resources.
 */
export interface CompressedRleDetectionMask {
  readonly encoding: DetectionMaskEncoding.CompressedRle;
  readonly width: number;
  readonly height: number;
  readonly counts: string;
}

export type DetectionMask = CompressedRleDetectionMask;

/**
 * One model output for a media frame.
 *
 * A detection stores model data only: identity, class, confidence, geometry,
 * mask, and caller metadata. It intentionally does not carry render styling.
 * Styling is resolved through presentation styles so the same detections can be
 * rendered as boxes, masks, labels, or future layers without mutating the
 * underlying annotation data.
 */
export interface Detection {
  readonly id?: string | number;
  readonly className?: string;
  readonly confidence?: number;
  readonly rect?: Rect;
  readonly mask?: DetectionMask;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Detections associated with one media time.
 *
 * `mediaTime` is seconds on the renderer media timeline. `endTime`, when
 * provided, is exclusive. `frameIndex` can be used when detections are produced
 * on a known inference frame grid and the session is configured for nearest
 * frame-index selection.
 */
export interface DetectionFrame {
  readonly frameIndex?: number;
  readonly mediaTime: number;
  readonly endTime?: number;
  readonly detections: readonly Detection[];
}
