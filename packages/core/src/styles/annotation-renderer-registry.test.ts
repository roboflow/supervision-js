import { describe, expect, it } from "vitest";

import {
  annotationRendererRegistry,
  resolveAnnotationRendererStyleFields,
  type AnnotationRendererStyleField,
  type AnnotationRendererStyleFieldFor,
} from "#styles/annotation-renderer-registry";
import { BaseBoxStyle } from "#styles/box-style";
import { createDefaultAnnotationPresentation } from "#styles/default-annotation-presentation";
import { BaseKeypointStyle } from "#styles/keypoint-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { BasePolygonStyle } from "#styles/polygon-style";
import { BasePolylineStyle } from "#styles/polyline-style";
import {
  annotationRendererKinds,
  annotationRenderers,
  type AnnotationRendererKind,
} from "#types/annotation-renderer";

type IsExact<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

const expectedStyleFields = {
  box: "boxStyle",
  keypoints: "keypointStyle",
  label: "labelStyle",
  mask: "maskStyle",
  polygon: "polygonStyle",
  polyline: "polylineStyle",
} as const satisfies Record<
  AnnotationRendererKind,
  AnnotationRendererStyleField
>;

/**
 * The registry pairing is derived from the style contracts, so this compiles
 * only while each kind still owns its documented presentation field.
 */
const styleFieldPairingIsExact: {
  [TKind in AnnotationRendererKind]: IsExact<
    AnnotationRendererStyleFieldFor<TKind>,
    (typeof expectedStyleFields)[TKind]
  >;
} = {
  box: true,
  keypoints: true,
  label: true,
  mask: true,
  polygon: true,
  polyline: true,
};

const expectedCanonicalStyles = {
  box: BaseBoxStyle,
  keypoints: BaseKeypointStyle,
  label: BaseLabelStyle,
  mask: BaseMaskStyle,
  polygon: BasePolygonStyle,
  polyline: BasePolylineStyle,
} as const satisfies Record<AnnotationRendererKind, unknown>;

describe("annotation renderer registry", () => {
  it("owns presentation metadata for every renderer kind", () => {
    expect(Object.keys(annotationRendererRegistry).sort()).toEqual(
      [...annotationRendererKinds].sort(),
    );
    expect(styleFieldPairingIsExact).toBeTruthy();

    for (const kind of annotationRendererKinds) {
      expect(annotationRendererRegistry[kind].styleField).toBe(
        expectedStyleFields[kind],
      );
    }
  });

  it("creates each canonical default style on demand", () => {
    const defaultPresentation = createDefaultAnnotationPresentation();

    for (const kind of annotationRendererKinds) {
      const { createCanonicalStyle, styleField } =
        annotationRendererRegistry[kind];
      const style = createCanonicalStyle();

      expect(style).toBeInstanceOf(expectedCanonicalStyles[kind]);
      expect(style).not.toBe(createCanonicalStyle());
      expect(defaultPresentation[styleField]).toBeInstanceOf(
        expectedCanonicalStyles[kind],
      );
    }
  });

  it("resolves the presentation fields of the requested kinds", () => {
    expect(
      resolveAnnotationRendererStyleFields([...annotationRendererKinds]),
    ).toEqual(annotationRendererKinds.map((kind) => expectedStyleFields[kind]));
    expect(resolveAnnotationRendererStyleFields(["mask", "box"])).toEqual([
      "maskStyle",
      "boxStyle",
    ]);
  });

  it("builds a descriptor whose id and kind match the vocabulary", () => {
    for (const kind of annotationRendererKinds) {
      expect(annotationRenderers[kind]()).toEqual({ id: kind, kind });
    }
  });
});
