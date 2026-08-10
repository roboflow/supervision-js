import type { AnnotationRenderer } from "#types/annotation-renderer";
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

  if (!renderers || renderers.length === 0) {
    return presentation;
  }

  const resolved = {
    boxStyle: presentation.boxStyle,
    keypointStyle: presentation.keypointStyle,
    labelStyle: presentation.labelStyle,
    maskStyle: presentation.maskStyle,
    polygonStyle: presentation.polygonStyle,
    polylineStyle: presentation.polylineStyle,
  };
  const rendererIds = new Set<string>();

  for (const renderer of renderers) {
    if (rendererIds.has(renderer.id)) {
      throw new RangeError(
        `MediaRendererPresentation.renderers contains duplicate renderer id "${renderer.id}".`,
      );
    }
    rendererIds.add(renderer.id);
    applyRendererStyle(resolved, renderer);
  }

  return {
    ...presentation,
    ...resolved,
  };
}

function applyRendererStyle(
  presentation: ResolvedAnnotationRendererStyles,
  renderer: AnnotationRenderer,
) {
  switch (renderer.kind) {
    case "box":
      if (renderer.style !== undefined) presentation.boxStyle = renderer.style;
      break;
    case "keypoints":
      if (renderer.style !== undefined) {
        presentation.keypointStyle = renderer.style;
      }
      break;
    case "label":
      if (renderer.style !== undefined)
        presentation.labelStyle = renderer.style;
      break;
    case "mask":
      if (renderer.style !== undefined) presentation.maskStyle = renderer.style;
      break;
    case "polygon":
      if (renderer.style !== undefined) {
        presentation.polygonStyle = renderer.style;
      }
      break;
    case "polyline":
      if (renderer.style !== undefined) {
        presentation.polylineStyle = renderer.style;
      }
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
