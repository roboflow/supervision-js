import type { AnnotationRenderer } from "#types/annotation-renderer";
import type { MediaRendererPresentation } from "#types/media-rendering";
import { createDefaultAnnotationPresentation } from "#styles/default-annotation-presentation";

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
  const defaultPresentation = createDefaultAnnotationPresentation();
  const rendererIds = new Set<string>();
  const rendererKinds = new Set<AnnotationRenderer["kind"]>();

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
    applyRendererStyle(resolved, presentation, defaultPresentation, renderer);
  }

  return {
    ...presentation,
    ...resolved,
  };
}

function applyRendererStyle(
  presentation: ResolvedAnnotationRendererStyles,
  presentationDefaults: MediaRendererPresentation,
  canonicalDefaults: MediaRendererPresentation,
  renderer: AnnotationRenderer,
) {
  switch (renderer.kind) {
    case "box":
      presentation.boxStyle =
        renderer.style === undefined
          ? presentationDefaults.boxStyle === undefined
            ? (canonicalDefaults.boxStyle ?? null)
            : presentationDefaults.boxStyle
          : renderer.style;
      break;
    case "keypoints":
      presentation.keypointStyle =
        renderer.style === undefined
          ? presentationDefaults.keypointStyle === undefined
            ? (canonicalDefaults.keypointStyle ?? null)
            : presentationDefaults.keypointStyle
          : renderer.style;
      break;
    case "label":
      presentation.labelStyle =
        renderer.style === undefined
          ? presentationDefaults.labelStyle === undefined
            ? (canonicalDefaults.labelStyle ?? null)
            : presentationDefaults.labelStyle
          : renderer.style;
      break;
    case "mask":
      presentation.maskStyle =
        renderer.style === undefined
          ? presentationDefaults.maskStyle === undefined
            ? (canonicalDefaults.maskStyle ?? null)
            : presentationDefaults.maskStyle
          : renderer.style;
      break;
    case "polygon":
      presentation.polygonStyle =
        renderer.style === undefined
          ? presentationDefaults.polygonStyle === undefined
            ? (canonicalDefaults.polygonStyle ?? null)
            : presentationDefaults.polygonStyle
          : renderer.style;
      break;
    case "polyline":
      presentation.polylineStyle =
        renderer.style === undefined
          ? presentationDefaults.polylineStyle === undefined
            ? (canonicalDefaults.polylineStyle ?? null)
            : presentationDefaults.polylineStyle
          : renderer.style;
      break;
  }
}

interface ResolvedAnnotationRendererStyles {
  boxStyle: MediaRendererPresentation["boxStyle"];
  keypointStyle: MediaRendererPresentation["keypointStyle"];
  labelStyle: MediaRendererPresentation["labelStyle"];
  maskStyle: MediaRendererPresentation["maskStyle"];
  polygonStyle: MediaRendererPresentation["polygonStyle"];
  polylineStyle: MediaRendererPresentation["polylineStyle"];
}
