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
  /**
   * Per-point flag for keypoints placed relative to `rect`, such as template
   * points a user has not positioned yet. Resizing the rect scales these
   * points with it; the others keep their coordinates. Dragging a point
   * clears its flag.
   */
  readonly boxRelative?: readonly boolean[];
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
  DenseBitmap = "denseBitmap",
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

/**
 * Uncompressed one-byte-per-pixel binary mask.
 *
 * This is the hot-path representation: a model producer that already holds
 * dense mask bytes can publish them without an encoding pass. RLE remains the
 * cold-storage form, but encoding into it costs a full pass plus a string
 * allocation per mask, which a per-frame live pipeline cannot afford.
 *
 * Consumers that need row-major semantics should call `decodeDetectionMask()`,
 * which normalizes both encodings. Renderers that sample the buffer directly
 * may read `data` and honor `rotatedCw` themselves to stay copy-free.
 *
 * `data` is treated as immutable and is shared, not deep-copied, when
 * detections are copied. Duplicating a full-resolution mask per frame would
 * defeat the reason this encoding exists, so a producer must not mutate a
 * buffer it has already published.
 */
export interface DenseBitmapDetectionMask {
  readonly encoding: DetectionMaskEncoding.DenseBitmap;
  /**
   * Logical mask width in mask pixels.
   */
  readonly width: number;
  /**
   * Logical mask height in mask pixels.
   */
  readonly height: number;
  /**
   * Mask bytes, one per pixel. Non-zero is foreground.
   *
   * Length must be `width * height` regardless of `rotatedCw`.
   */
  readonly data: Uint8Array;
  /**
   * Set when `data` stores the mask rotated 90° clockwise. The stored buffer
   * is then `height` wide and `width` tall, and a logical pixel reads as
   * `data[x * height + (height - 1 - y)]` rather than `data[y * width + x]`.
   *
   * This describes buffer layout only. It lets a producer whose runtime emits
   * a rotated buffer avoid an upright copy per frame; `width` and `height`
   * always describe the logical, upright mask.
   */
  readonly rotatedCw?: boolean;
}

export type DetectionMask =
  CompressedRleDetectionMask | DenseBitmapDetectionMask;

/**
 * One semantic detection for a media frame.
 *
 * A detection may come directly from a model or from a semantic
 * post-processor such as tracking. It stores identity, class, confidence,
 * geometry, mask, and caller metadata, but intentionally does not carry render
 * styling.
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
   * Post-processors may update this derived field in place.
   */
  trackerId?: number;
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
 * Pixel space that a detection frame's vector geometry was produced in.
 *
 * Producers that infer on a resized or transcoded copy of the media can attach
 * this to a `DetectionFrame` instead of scaling geometry themselves. Masks are
 * unaffected: they already carry their own intrinsic `width`/`height`.
 */
export interface DetectionCoordinateSpace {
  /** Source frame width in pixels. Must be greater than 0. */
  readonly width: number;
  /** Source frame height in pixels. Must be greater than 0. */
  readonly height: number;
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
  /**
   * Optional pixel space this frame's rectangles, polygons, polylines, and
   * keypoints were produced in.
   *
   * Omit it when detections are already in media-pixel coordinates. Mask
   * coordinates always use the mask's own intrinsic dimensions and are never
   * rescaled by coordinate-space projection.
   */
  readonly coordinateSpace?: DetectionCoordinateSpace;
}
