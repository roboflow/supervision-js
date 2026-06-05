/**
 * Axis-aligned rectangle in media pixel coordinates.
 *
 * This is semantic detection geometry, not a renderer shape. Presentation
 * details such as stroke, fill, corner radius, or opacity belong to box styles.
 */
export interface Rect {
  /**
   * Left coordinate in media pixels.
   */
  readonly x: number;
  /**
   * Top coordinate in media pixels.
   */
  readonly y: number;
  /**
   * Width in media pixels. Must be greater than 0.
   */
  readonly width: number;
  /**
   * Height in media pixels. Must be greater than 0.
   */
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
  /**
   * Mask width in mask pixels.
   */
  readonly width: number;
  /**
   * Mask height in mask pixels.
   */
  readonly height: number;
  /**
   * Compressed RLE counts string.
   *
   * This matches the compact binary-mask representation commonly emitted by CV
   * tooling. The renderer may prepare it into an ID-mask artifact before drawing.
   */
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
  /**
   * Optional stable identity for picking, interaction, and host app metadata.
   */
  readonly id?: string | number;
  /**
   * Optional semantic class name, such as `person`, `vehicle`, or `basketball`.
   */
  readonly className?: string;
  /**
   * Optional confidence score from 0 to 1.
   */
  readonly confidence?: number;
  /**
   * Optional axis-aligned media-pixel rectangle.
   */
  readonly rect?: Rect;
  /**
   * Optional binary mask in semantic cold-storage form.
   */
  readonly mask?: DetectionMask;
  /**
   * Caller-owned metadata. The renderer does not interpret this field.
   */
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
  /**
   * Optional inference frame index for frame-grid synchronized detections.
   */
  readonly frameIndex?: number;
  /**
   * Media timeline time in seconds.
   */
  readonly mediaTime: number;
  /**
   * Exclusive end time in seconds. Omit for point-in-time frames.
   */
  readonly endTime?: number;
  /**
   * Detections active for this frame interval.
   */
  readonly detections: readonly Detection[];
}
