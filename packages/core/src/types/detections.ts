/**
 * Axis-aligned rectangle in media pixel coordinates.
 *
 * This is semantic detection geometry, not a renderer shape. Presentation
 * details such as stroke, fill, corner radius, or opacity belong to box styles.
 * `x` and `y` identify the rectangle center.
 */
export interface Rect {
  /**
   * Center X coordinate in media pixels.
   */
  readonly x: number;
  /**
   * Center Y coordinate in media pixels.
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

/** A media-space point in pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Explicit top-left rectangle for renderer and canvas layout boundaries. */
export interface TopLeftRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PolygonGeometry {
  readonly points: readonly Point[];
}

export interface PolylineGeometry {
  readonly points: readonly Point[];
}

/** COCO-compatible keypoint visibility values. */
export enum KeypointVisibility {
  NotLabeled = 0,
  Occluded = 1,
  Visible = 2,
}

export type KeypointEdge = readonly [fromIndex: number, toIndex: number];

export interface KeypointGeometry {
  readonly points: readonly Point[];
  readonly edges: readonly KeypointEdge[];
  readonly visibility?: readonly KeypointVisibility[];
}

export interface SkeletonVertexDefinition {
  readonly id: number;
  readonly name: string;
  readonly color?: number;
}

export interface SkeletonEdgeDefinition {
  readonly from: number;
  readonly to: number;
  readonly color?: number;
}

export interface SkeletonDefinition {
  readonly vertices: readonly SkeletonVertexDefinition[];
  readonly edges: readonly SkeletonEdgeDefinition[];
}

export type SkeletonDefinitions = Readonly<Record<string, SkeletonDefinition>>;

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
   * Optional temporal identity assigned by a tracking post-processor.
   * This is separate from `id`, which remains the annotation/picking identity.
   */
  readonly trackerId?: number;
  /**
   * Optional provenance for detections copied from a composed source.
   *
   * This is renderer-neutral source identity, not product workflow state.
   */
  readonly sourceId?: string;
  /**
   * Optional source-local detection index before composition.
   */
  readonly sourceDetectionIndex?: number;
  /**
   * Optional semantic class name, such as `person`, `vehicle`, or `basketball`.
   */
  readonly className?: string;
  /**
   * Optional confidence score from 0 to 1.
   */
  readonly confidence?: number;
  /** Optional host-owned annotation attributes. */
  readonly attributes?: readonly string[];
  /** Optional per-annotation render and pick order. Higher values are on top. */
  readonly zIndex?: number;
  /** Optional host editing lock. Renderers may still present locked records. */
  readonly locked?: boolean;
  /**
   * Optional axis-aligned media-pixel rectangle.
   */
  readonly rect?: Rect;
  /** Optional closed polygon in media-pixel coordinates. */
  readonly polygon?: PolygonGeometry;
  /** Optional open path in media-pixel coordinates. */
  readonly polyline?: PolylineGeometry;
  /** Optional keypoints and skeleton edges in media-pixel coordinates. */
  readonly keypoints?: KeypointGeometry;
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
