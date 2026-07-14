import type { Detection } from "#types/detections";
import type { AnnotationVisibility } from "#types/media-rendering";
import type { AnnotationStyleContext } from "#types/style";

export function resolveAnnotationStyleState(
  detection: Detection,
  visibility: AnnotationVisibility | undefined,
): Pick<
  AnnotationStyleContext,
  "hidden" | "loading" | "ephemeral" | "isCreating"
> {
  const id = detection.id;
  return {
    hidden:
      visibility?.annotationsHidden === true ||
      (detection.className !== undefined &&
        includes(visibility?.hiddenClasses, detection.className)) ||
      (id !== undefined && includes(visibility?.hiddenDetectionIds, id)),
    loading: id !== undefined && includes(visibility?.loadingDetectionIds, id),
    ephemeral:
      id !== undefined && includes(visibility?.ephemeralDetectionIds, id),
    isCreating: id !== undefined && visibility?.creatingDetectionId === id,
  };
}

function includes<T>(
  values: ReadonlySet<T> | readonly T[] | undefined,
  value: T,
) {
  if (!values) return false;
  return Array.isArray(values)
    ? values.includes(value)
    : (values as ReadonlySet<T>).has(value);
}
