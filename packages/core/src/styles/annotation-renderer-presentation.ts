import {
  annotationRendererRegistry,
  type AnnotationRendererStyleField,
} from "#styles/annotation-renderer-registry";
import type {
  AnnotationRenderer,
  AnnotationRendererKind,
} from "#types/annotation-renderer";
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
    keypointStyle: null,
    labelStyle: null,
    maskStyle: null,
    polygonStyle: null,
    polylineStyle: null,
  };
  const rendererIds = new Set<string>();
  const rendererKinds = new Set<AnnotationRendererKind>();

  for (const renderer of renderers) {
    if (rendererIds.has(renderer.id)) {
      throw new RangeError(
        `MediaRendererPresentation.renderers contains duplicate renderer id "${renderer.id}".`,
      );
    }
    rendererIds.add(renderer.id);
    if (rendererKinds.has(renderer.kind)) {
      throw new RangeError(
        `MediaRendererPresentation.renderers contains duplicate renderer kind "${renderer.kind}".`,
      );
    }
    rendererKinds.add(renderer.kind);
    applyRendererStyle(resolved, presentation, renderer);
  }

  return {
    ...presentation,
    ...resolved,
  };
}

function applyRendererStyle(
  resolved: ResolvedAnnotationRendererStyles,
  configured: MediaRendererPresentation,
  renderer: AnnotationRenderer,
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
