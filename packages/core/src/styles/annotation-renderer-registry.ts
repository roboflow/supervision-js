import {
  createDefaultBoxStyle,
  createDefaultBoxCornerStyle,
  createDefaultEllipseStyle,
  createDefaultMaskHaloStyle,
  createDefaultKeypointStyle,
  createDefaultLabelStyle,
  createDefaultMaskStyle,
  createDefaultMarkerStyle,
  createDefaultPolygonStyle,
  createDefaultPolylineStyle,
} from "#styles/default-annotation-presentation";
import type {
  AnnotationRendererKind,
  AnnotationRendererOfKind,
} from "#types/annotation-renderer";
import type { MediaRendererPresentation } from "#types/media-rendering";

/** The style contract configured by one renderer kind. */
export const styledAnnotationRendererKinds = [
  "box",
  "box-corners",
  "ellipse",
  "keypoints",
  "label",
  "mask",
  "maskHalo",
  "marker",
  "polygon",
  "polyline",
] as const;

export type StyledAnnotationRendererKind =
  (typeof styledAnnotationRendererKinds)[number];

export type AnnotationRendererStyle<
  TKind extends StyledAnnotationRendererKind,
> = NonNullable<AnnotationRendererOfKind<TKind>["style"]>;

/**
 * The presentation field that carries a renderer kind's style.
 *
 * The pairing is derived from the style contracts themselves, so a registry
 * entry that points a kind at the wrong presentation field does not compile.
 */
export type AnnotationRendererStyleFieldFor<
  TKind extends StyledAnnotationRendererKind,
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
  [
    TKind in StyledAnnotationRendererKind
  ]: AnnotationRendererStyleFieldFor<TKind>;
}[StyledAnnotationRendererKind];

export interface AnnotationRendererKindMetadata<
  TKind extends StyledAnnotationRendererKind,
> {
  readonly cardinality: "singleton";
  /** Presentation field this kind reads its configured style from. */
  readonly styleField: AnnotationRendererStyleFieldFor<TKind>;
  /**
   * Builds this kind's canonical default style on demand, so resolving one
   * listed renderer never constructs the styles of the other kinds.
   */
  readonly createCanonicalStyle: () => AnnotationRendererStyle<TKind>;
}

export interface DirectAnnotationRendererKindMetadata {
  readonly cardinality: "multiple";
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
  ]: TKind extends StyledAnnotationRendererKind
    ? AnnotationRendererKindMetadata<TKind>
    : DirectAnnotationRendererKindMetadata;
};

export const annotationRendererRegistry: AnnotationRendererRegistry = {
  box: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultBoxStyle,
    styleField: "boxStyle",
  },
  "box-corners": {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultBoxCornerStyle,
    styleField: "boxCornerStyle",
  },
  ellipse: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultEllipseStyle,
    styleField: "ellipseStyle",
  },
  keypoints: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultKeypointStyle,
    styleField: "keypointStyle",
  },
  label: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultLabelStyle,
    styleField: "labelStyle",
  },
  mask: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultMaskStyle,
    styleField: "maskStyle",
  },
  maskHalo: {
    cardinality: "singleton",
    createCanonicalStyle: () => createDefaultMaskHaloStyle(),
    styleField: "maskHaloStyle",
  },
  marker: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultMarkerStyle,
    styleField: "markerStyle",
  },
  polygon: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultPolygonStyle,
    styleField: "polygonStyle",
  },
  polyline: {
    cardinality: "singleton",
    createCanonicalStyle: createDefaultPolylineStyle,
    styleField: "polylineStyle",
  },
  region: { cardinality: "multiple" },
};

export function isStyleBackedAnnotationRendererKind(
  kind: AnnotationRendererKind,
): kind is StyledAnnotationRendererKind {
  return annotationRendererRegistry[kind].cardinality === "singleton";
}

/** Presentation fields owned by the given renderer kinds, in the same order. */
export function resolveAnnotationRendererStyleFields(
  kinds: readonly AnnotationRendererKind[],
): readonly AnnotationRendererStyleField[] {
  return kinds.flatMap((kind) => {
    const metadata = annotationRendererRegistry[kind];
    return "styleField" in metadata ? [metadata.styleField] : [];
  });
}
