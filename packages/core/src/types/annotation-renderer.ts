import type { BoxStyle } from "#types/box-style";
import type { KeypointStyle } from "#types/keypoint-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type { PolygonStyle } from "#types/polygon-style";
import type { PolylineStyle } from "#types/polyline-style";

/**
 * The built-in annotation renderer vocabulary.
 *
 * These stay plain string literals so `{ kind: "box" }` remains assignable to
 * the public descriptor union from JavaScript and TypeScript alike.
 */
export const annotationRendererKinds = [
  "box",
  "keypoints",
  "label",
  "mask",
  "polygon",
  "polyline",
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
  | KeypointAnnotationRenderer
  | LabelAnnotationRenderer
  | MaskAnnotationRenderer
  | PolygonAnnotationRenderer
  | PolylineAnnotationRenderer;

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

/** Creates the descriptor for every supported renderer kind. */
export type AnnotationRendererFactory = {
  readonly [TKind in AnnotationRendererKind]: (
    options?: AnnotationRendererStyleOptions<TKind>,
  ) => AnnotationRendererOfKind<TKind>;
};

type AnnotationRendererStyleOptions<TKind extends AnnotationRendererKind> =
  Pick<AnnotationRendererOfKind<TKind>, "style">;

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
  keypoints: (options) => createAnnotationRenderer("keypoints", options),
  label: (options) => createAnnotationRenderer("label", options),
  mask: (options) => createAnnotationRenderer("mask", options),
  polygon: (options) => createAnnotationRenderer("polygon", options),
  polyline: (options) => createAnnotationRenderer("polyline", options),
};

function createAnnotationRenderer<TKind extends AnnotationRendererKind>(
  kind: TKind,
  options: AnnotationRendererStyleOptions<TKind> | undefined,
): AnnotationRendererOfKind<TKind> {
  // Every built-in renderer keeps its kind as its stable id. TypeScript cannot
  // narrow the descriptor union through the generic kind parameter, so the
  // descriptor shape is asserted here and covered by a focused test.
  return { id: kind, kind, ...options } as AnnotationRendererOfKind<TKind>;
}
