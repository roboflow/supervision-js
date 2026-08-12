import type { BoxStyle } from "#types/box-style";
import type { EllipseStyle } from "#types/ellipse-style";
import type { KeypointStyle } from "#types/keypoint-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type { PolygonStyle } from "#types/polygon-style";
import type { PolylineStyle } from "#types/polyline-style";
import type { AnnotationStyleContext } from "#types/style";
import type { Detection } from "#types/detections";

/**
 * The built-in annotation renderer vocabulary.
 *
 * These stay plain string literals so `{ kind: "box" }` remains assignable to
 * the public descriptor union from JavaScript and TypeScript alike.
 */
export const annotationRendererKinds = [
  "box",
  "ellipse",
  "keypoints",
  "label",
  "mask",
  "polygon",
  "polyline",
  "region",
] as const;

/** One supported built-in annotation renderer kind. */
export type AnnotationRendererKind = (typeof annotationRendererKinds)[number];

/**
 * A renderer configured in a media presentation.
 *
 * Renderers are the public unit of annotation visualization. Every renderer
 * consumes semantic detections and contributes to the renderer-owned scene;
 * individual backends decide how to draw or prepare it.
 */
export type AnnotationRenderer =
  | BoxAnnotationRenderer
  | EllipseAnnotationRenderer
  | KeypointAnnotationRenderer
  | LabelAnnotationRenderer
  | MaskAnnotationRenderer
  | PolygonAnnotationRenderer
  | PolylineAnnotationRenderer
  | RegionAnnotationRenderer;

/**
 * The descriptor of one renderer kind.
 *
 * This resolves to `never` for a kind that has no descriptor, which makes an
 * incomplete addition to {@link annotationRendererKinds} fail to compile where
 * the kind's metadata or factory is declared.
 */
export type AnnotationRendererOfKind<TKind extends AnnotationRendererKind> =
  Extract<AnnotationRenderer, { kind: TKind }>;

interface BaseAnnotationRenderer {
  /** Stable identity within one presentation. */
  readonly id: string;
}

export interface BoxAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "box";
  readonly style?: BoxStyle | null;
}

export interface EllipseAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "ellipse";
  readonly style?: EllipseStyle | null;
}

export interface KeypointAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "keypoints";
  readonly style?: KeypointStyle | null;
}

export interface LabelAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "label";
  readonly style?: LabelStyle | null;
}

export interface MaskAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "mask";
  readonly style?: MaskStyle | null;
}

export interface PolygonAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "polygon";
  readonly style?: PolygonStyle | null;
}

export interface PolylineAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "polyline";
  readonly style?: PolylineStyle | null;
}

/** Sources currently supported by a region renderer. */
export const RegionRendererSourceKind = {
  Asset: "asset",
} as const;

export type RegionRendererSourceKind =
  (typeof RegionRendererSourceKind)[keyof typeof RegionRendererSourceKind];

/** Media-space regions currently supported by a region renderer. */
export const RegionRendererRegionKind = {
  Bounds: "bounds",
  KeypointAnchor: "keypoint-anchor",
} as const;

export type RegionRendererRegionKind =
  (typeof RegionRendererRegionKind)[keyof typeof RegionRendererRegionKind];

/** Composition modes currently supported by a region renderer. */
export const RegionRendererComposeMode = {
  Over: "over",
} as const;

export type RegionRendererComposeMode =
  (typeof RegionRendererComposeMode)[keyof typeof RegionRendererComposeMode];

export type RegionRendererTargetValue =
  string | number | readonly (string | number)[];

export type RegionRendererTargetContext = AnnotationStyleContext;

/** Selects detections consumed by a region renderer. All configured fields match. */
export interface RegionRendererTarget {
  readonly id?: RegionRendererTargetValue;
  readonly className?: string | readonly string[];
  readonly sourceId?: string | readonly string[];
  readonly resolve?: (
    detection: Detection,
    context: RegionRendererTargetContext,
  ) => boolean;
}

/** A browser-loadable image or animated GIF. Backend asset types stay private. */
export interface RegionRendererAssetReference {
  readonly src: string;
}

export interface RegionRendererAssetSource {
  readonly kind: typeof RegionRendererSourceKind.Asset;
  readonly asset: RegionRendererAssetReference;
}

export interface RegionRendererBoundsRegion {
  readonly kind: typeof RegionRendererRegionKind.Bounds;
}

/**
 * Resolves one point-sized region from semantic keypoints.
 *
 * A numeric anchor addresses one keypoint index. `"head"` resolves the visible
 * COCO face keypoints (indices 0 through 4) and falls back to the top of the
 * detection bounds when those points are unavailable.
 */
export interface RegionRendererKeypointAnchorRegion {
  readonly kind: typeof RegionRendererRegionKind.KeypointAnchor;
  readonly anchor: number | "head";
}

export type RegionRendererRegion =
  RegionRendererBoundsRegion | RegionRendererKeypointAnchorRegion;

/** Media-space transform applied after a target region is resolved. */
export interface RegionRendererTransform {
  /** Uniform scale relative to the resolved region. Defaults to 1. */
  readonly scale?: number;
  /** Region-relative translation. `{ x: 1, y: 1 }` moves one region size. */
  readonly offset?: { readonly x: number; readonly y: number };
  /** Clockwise rotation in radians. Defaults to 0. */
  readonly rotation?: number;
  /** Sprite opacity from 0 through 1. Defaults to 1. */
  readonly opacity?: number;
}

export interface RegionRendererCompose {
  readonly mode: typeof RegionRendererComposeMode.Over;
  /** Stable ordering among region renderers. Defaults to 0. */
  readonly zIndex?: number;
}

/**
 * Places a browser-loaded asset over a detection-owned region.
 *
 * This descriptor is intentionally semantic and backend-neutral. Asset
 * loading, texture caching, sprites, and teardown remain backend details.
 */
export interface RegionAnnotationRenderer extends BaseAnnotationRenderer {
  readonly kind: "region";
  readonly target: RegionRendererTarget;
  readonly source: RegionRendererAssetSource;
  readonly region: RegionRendererRegion;
  readonly transform?: RegionRendererTransform;
  readonly compose?: RegionRendererCompose;
}

/** Creates the descriptor for every supported renderer kind. */
export type AnnotationRendererFactory = {
  readonly [TKind in Exclude<AnnotationRendererKind, "region">]: (
    options?: AnnotationRendererStyleOptions<TKind>,
  ) => AnnotationRendererOfKind<TKind>;
} & {
  readonly region: (
    options: Omit<RegionAnnotationRenderer, "kind">,
  ) => RegionAnnotationRenderer;
};

type AnnotationRendererStyleOptions<
  TKind extends Exclude<AnnotationRendererKind, "region">,
> = Pick<AnnotationRendererOfKind<TKind>, "style">;

/**
 * Creates built-in annotation renderer descriptors for
 * `MediaRendererPresentation.renderers`.
 *
 * The currently supported renderers retain their established scene ordering:
 * masks, polygons, vectors, labels. A later renderer kind may add a new
 * composition capability without changing that ordering for existing scenes.
 */
export const annotationRenderers: AnnotationRendererFactory = {
  box: (options) => createAnnotationRenderer("box", options),
  ellipse: (options) => createAnnotationRenderer("ellipse", options),
  keypoints: (options) => createAnnotationRenderer("keypoints", options),
  label: (options) => createAnnotationRenderer("label", options),
  mask: (options) => createAnnotationRenderer("mask", options),
  polygon: (options) => createAnnotationRenderer("polygon", options),
  polyline: (options) => createAnnotationRenderer("polyline", options),
  region: (options) => ({ kind: "region", ...options }),
};

function createAnnotationRenderer<
  TKind extends Exclude<AnnotationRendererKind, "region">,
>(
  kind: TKind,
  options: AnnotationRendererStyleOptions<TKind> | undefined,
): AnnotationRendererOfKind<TKind> {
  // Every built-in renderer keeps its kind as its stable id. TypeScript cannot
  // narrow the descriptor union through the generic kind parameter, so the
  // descriptor shape is asserted here and covered by a focused test.
  return { id: kind, kind, ...options } as AnnotationRendererOfKind<TKind>;
}
