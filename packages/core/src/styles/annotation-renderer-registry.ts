import {
  createDefaultBoxStyle,
  createDefaultKeypointStyle,
  createDefaultLabelStyle,
  createDefaultMaskStyle,
  createDefaultPolygonStyle,
  createDefaultPolylineStyle,
} from "#styles/default-annotation-presentation";
import type {
  AnnotationRendererKind,
  AnnotationRendererOfKind,
} from "#types/annotation-renderer";
import type { MediaRendererPresentation } from "#types/media-rendering";

/** The style contract configured by one renderer kind. */
export type AnnotationRendererStyle<TKind extends AnnotationRendererKind> =
  NonNullable<AnnotationRendererOfKind<TKind>["style"]>;

/**
 * The presentation field that carries a renderer kind's style.
 *
 * The pairing is derived from the style contracts themselves, so a registry
 * entry that points a kind at the wrong presentation field does not compile.
 */
export type AnnotationRendererStyleFieldFor<
  TKind extends AnnotationRendererKind,
> = {
  [
    TField in keyof MediaRendererPresentation
  ]-?: AnnotationRendererStyle<TKind> extends NonNullable<
    MediaRendererPresentation[TField]
  >
    ? NonNullable<
        MediaRendererPresentation[TField]
      > extends AnnotationRendererStyle<TKind>
      ? TField
      : never
    : never;
}[keyof MediaRendererPresentation];

/** Every presentation field owned by a built-in renderer kind. */
export type AnnotationRendererStyleField = {
  [TKind in AnnotationRendererKind]: AnnotationRendererStyleFieldFor<TKind>;
}[AnnotationRendererKind];

export interface AnnotationRendererKindMetadata<
  TKind extends AnnotationRendererKind,
> {
  /** Presentation field this kind reads its configured style from. */
  readonly styleField: AnnotationRendererStyleFieldFor<TKind>;
  /**
   * Builds this kind's canonical default style on demand, so resolving one
   * listed renderer never constructs the styles of the other kinds.
   */
  readonly createCanonicalStyle: () => AnnotationRendererStyle<TKind>;
}

/**
 * The single source of built-in renderer presentation metadata.
 *
 * Adding a kind to {@link annotationRendererKinds} without a complete entry
 * here is a compile error, and every consumer of renderer metadata reads this
 * registry instead of repeating the kind-to-style mapping.
 */
export type AnnotationRendererRegistry = {
  readonly [
    TKind in AnnotationRendererKind
  ]: AnnotationRendererKindMetadata<TKind>;
};

export const annotationRendererRegistry: AnnotationRendererRegistry = {
  box: { createCanonicalStyle: createDefaultBoxStyle, styleField: "boxStyle" },
  keypoints: {
    createCanonicalStyle: createDefaultKeypointStyle,
    styleField: "keypointStyle",
  },
  label: {
    createCanonicalStyle: createDefaultLabelStyle,
    styleField: "labelStyle",
  },
  mask: {
    createCanonicalStyle: createDefaultMaskStyle,
    styleField: "maskStyle",
  },
  polygon: {
    createCanonicalStyle: createDefaultPolygonStyle,
    styleField: "polygonStyle",
  },
  polyline: {
    createCanonicalStyle: createDefaultPolylineStyle,
    styleField: "polylineStyle",
  },
};

/** Presentation fields owned by the given renderer kinds, in the same order. */
export function resolveAnnotationRendererStyleFields(
  kinds: readonly AnnotationRendererKind[],
): readonly AnnotationRendererStyleField[] {
  return kinds.map((kind) => annotationRendererRegistry[kind].styleField);
}
