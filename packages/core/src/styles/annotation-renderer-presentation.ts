import {
  annotationRendererRegistry,
  isStyleBackedAnnotationRendererKind,
  type AnnotationRendererStyleField,
} from "#styles/annotation-renderer-registry";
import type {
  AnnotationRenderer,
  AnnotationRendererKind,
  DepthAnnotationRenderer,
  HeatmapAnnotationRenderer,
} from "#types/annotation-renderer";
import { DepthQuantity, DepthSampling } from "#types/depth-map";
import { isDepthColormap } from "#utils/depth-colormaps";
import type { MediaRendererPresentation } from "#types/media-rendering";

/**
 * Resolves built-in renderer descriptors into the existing specialized style
 * fields. The browser backend deliberately keeps ownership of its box, mask,
 * label, polygon, polyline, and keypoint pipelines; this normalizer only
 * supplies those pipelines with their configured style.
 */
export function resolveAnnotationRendererPresentation(
  presentation: MediaRendererPresentation,
): MediaRendererPresentation {
  const renderers = presentation.renderers;

  if (renderers === undefined) {
    return presentation;
  }

  const resolved: ResolvedAnnotationRendererStyles = {
    boxStyle: null,
    boxCornerStyle: null,
    ellipseStyle: null,
    keypointStyle: null,
    labelStyle: null,
    maskHaloStyle: null,
    maskStyle: null,
    markerStyle: null,
    orientedBoxStyle: null,
    percentageBarStyle: null,
    polygonStyle: null,
    polylineStyle: null,
  };
  const rendererIds = new Set<string>();
  const rendererKinds = new Set<AnnotationRendererKind>();

  for (const renderer of renderers) {
    if (renderer.kind === "heatmap") {
      validateHeatmapRenderer(renderer);
    }
    if (renderer.kind === "depth") {
      validateDepthRenderer(renderer);
    }
    if (rendererIds.has(renderer.id)) {
      throw new RangeError(
        `MediaRendererPresentation.renderers contains duplicate renderer id "${renderer.id}".`,
      );
    }
    rendererIds.add(renderer.id);
    if (
      annotationRendererRegistry[renderer.kind].cardinality === "singleton" &&
      rendererKinds.has(renderer.kind)
    ) {
      throw new RangeError(
        `MediaRendererPresentation.renderers contains duplicate renderer kind "${renderer.kind}".`,
      );
    }
    rendererKinds.add(renderer.kind);
    if (isStyleBackedAnnotationRenderer(renderer)) {
      applyRendererStyle(resolved, presentation, renderer);
    }
  }

  return {
    ...presentation,
    ...resolved,
  };
}

function validateHeatmapRenderer(renderer: HeatmapAnnotationRenderer): void {
  const stops = renderer.colorStops;
  if (
    (renderer.maximumScore !== undefined &&
      (!Number.isFinite(renderer.maximumScore) ||
        renderer.maximumScore <= 0)) ||
    (renderer.thresholdScale !== undefined &&
      (!Number.isFinite(renderer.thresholdScale) ||
        renderer.thresholdScale < 0)) ||
    (renderer.opacity !== undefined && !Number.isFinite(renderer.opacity)) ||
    (renderer.minimumAlpha !== undefined &&
      !Number.isFinite(renderer.minimumAlpha)) ||
    (stops !== undefined &&
      (!Array.isArray(stops) ||
        stops.length === 0 ||
        stops.some(
          (stop, index) =>
            !Number.isFinite(stop.position) ||
            stop.position < 0 ||
            stop.position > 1 ||
            !Number.isInteger(stop.color) ||
            stop.color < 0 ||
            stop.color > 0xffffff ||
            (index > 0 && stop.position < stops[index - 1].position),
        )))
  ) {
    throw new RangeError(
      `Invalid heatmap renderer settings for "${renderer.id}".`,
    );
  }
}

const depthQuantities: ReadonlySet<unknown> = new Set(
  Object.values(DepthQuantity),
);
const depthSamplings: ReadonlySet<unknown> = new Set(
  Object.values(DepthSampling),
);

function validateDepthRenderer(renderer: DepthAnnotationRenderer): void {
  const { colormap, noDepthColor, opacity, quantity, range, sampling, wipe } =
    renderer;

  if (
    (colormap !== undefined && !isDepthColormap(colormap)) ||
    (quantity !== undefined && !depthQuantities.has(quantity)) ||
    (sampling !== undefined && !depthSamplings.has(sampling)) ||
    (range !== undefined &&
      range !== "clip" &&
      range !== "auto" &&
      (typeof range !== "object" ||
        range === null ||
        !Number.isFinite(range.min) ||
        !Number.isFinite(range.max) ||
        range.min >= range.max)) ||
    (opacity !== undefined && !Number.isFinite(opacity)) ||
    (wipe !== undefined &&
      !(Number.isFinite(wipe) && wipe >= 0 && wipe <= 1)) ||
    (noDepthColor !== undefined &&
      noDepthColor !== null &&
      !(
        Number.isInteger(noDepthColor) &&
        noDepthColor >= 0 &&
        noDepthColor <= 0xffffff
      ))
  ) {
    throw new RangeError(
      `Invalid depth renderer settings for "${renderer.id}".`,
    );
  }
}

function isStyleBackedAnnotationRenderer(
  renderer: AnnotationRenderer,
): renderer is Extract<AnnotationRenderer, { style?: unknown }> {
  return isStyleBackedAnnotationRendererKind(renderer.kind);
}

function applyRendererStyle(
  resolved: ResolvedAnnotationRendererStyles,
  configured: MediaRendererPresentation,
  renderer: Extract<AnnotationRenderer, { style?: unknown }>,
) {
  const { createCanonicalStyle, styleField } =
    annotationRendererRegistry[renderer.kind];
  const configuredStyle = configured[styleField];
  const style =
    renderer.style !== undefined
      ? renderer.style
      : configuredStyle !== undefined
        ? configuredStyle
        : createCanonicalStyle();

  // The registry pairs each kind with the presentation field holding the same
  // style contract, but TypeScript cannot correlate that pairing across a
  // lookup on a union, so the write is asserted once here.
  resolved[styleField] = style as never;
}

type ResolvedAnnotationRendererStyles = {
  -readonly [
    TField in AnnotationRendererStyleField
  ]-?: MediaRendererPresentation[TField];
};
