import type { BoxStyle } from "#types/box-style";
import type { KeypointStyle } from "#types/keypoint-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type { PolygonStyle } from "#types/polygon-style";
import type { PolylineStyle } from "#types/polyline-style";

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

export interface AnnotationRendererFactory {
  box(
    options?: RendererStyleOptions<BoxAnnotationRenderer>,
  ): BoxAnnotationRenderer;
  keypoints(
    options?: RendererStyleOptions<KeypointAnnotationRenderer>,
  ): KeypointAnnotationRenderer;
  label(
    options?: RendererStyleOptions<LabelAnnotationRenderer>,
  ): LabelAnnotationRenderer;
  mask(
    options?: RendererStyleOptions<MaskAnnotationRenderer>,
  ): MaskAnnotationRenderer;
  polygon(
    options?: RendererStyleOptions<PolygonAnnotationRenderer>,
  ): PolygonAnnotationRenderer;
  polyline(
    options?: RendererStyleOptions<PolylineAnnotationRenderer>,
  ): PolylineAnnotationRenderer;
}

type RendererStyleOptions<TRenderer extends AnnotationRenderer> = Pick<
  TRenderer,
  "style"
>;

/**
 * Creates built-in annotation renderer descriptors for
 * `MediaRendererPresentation.renderers`.
 *
 * The currently supported renderers retain their established scene ordering:
 * masks, polygons, vectors, labels. A later renderer kind may add a new
 * composition capability without changing that ordering for existing scenes.
 */
export const annotationRenderers: AnnotationRendererFactory = {
  box: (options = {}) => ({ id: "box", kind: "box", ...options }),
  keypoints: (options = {}) => ({
    id: "keypoints",
    kind: "keypoints",
    ...options,
  }),
  label: (options = {}) => ({ id: "label", kind: "label", ...options }),
  mask: (options = {}) => ({ id: "mask", kind: "mask", ...options }),
  polygon: (options = {}) => ({
    id: "polygon",
    kind: "polygon",
    ...options,
  }),
  polyline: (options = {}) => ({
    id: "polyline",
    kind: "polyline",
    ...options,
  }),
};
