import { describe, expect, it } from "vitest";

import {
  annotationRendererRegistry,
  resolveAnnotationRendererStyleFields,
  styledAnnotationRendererKinds,
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
} from "#types/annotation-renderer";

type IsExact<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

const expectedStyleFields = {
  box: "boxStyle",
  ellipse: "ellipseStyle",
  keypoints: "keypointStyle",
  label: "labelStyle",
  mask: "maskStyle",
  polygon: "polygonStyle",
  polyline: "polylineStyle",
} as const satisfies Record<
  (typeof styledAnnotationRendererKinds)[number],
  AnnotationRendererStyleField
>;

/**
 * The registry pairing is derived from the style contracts, so this compiles
 * only while each kind still owns its documented presentation field.
 */
const styleFieldPairingIsExact: {
  [TKind in (typeof styledAnnotationRendererKinds)[number]]: IsExact<
    AnnotationRendererStyleFieldFor<TKind>,
    (typeof expectedStyleFields)[TKind]
  >;
} = {
  box: true,
  ellipse: true,
  keypoints: true,
  label: true,
  mask: true,
  polygon: true,
  polyline: true,
};

const expectedCanonicalStyles = {
  box: BaseBoxStyle,
  // The ellipse's canonical style is a plain resolver object and the
  // capability is opt-in, so it never appears in the default presentation.
  ellipse: null,
  keypoints: BaseKeypointStyle,
  label: BaseLabelStyle,
  mask: BaseMaskStyle,
  polygon: BasePolygonStyle,
  polyline: BasePolylineStyle,
} as const satisfies Record<
  (typeof styledAnnotationRendererKinds)[number],
  unknown
>;

describe("annotation renderer registry", () => {
  it("owns presentation metadata for every renderer kind", () => {
    expect(Object.keys(annotationRendererRegistry).sort()).toEqual(
      [...annotationRendererKinds].sort(),
    );
    expect(styleFieldPairingIsExact).toBeTruthy();

    for (const kind of styledAnnotationRendererKinds) {
      expect(annotationRendererRegistry[kind].styleField).toBe(
        expectedStyleFields[kind],
      );
    }
  });

  it("creates each canonical default style on demand", () => {
    const defaultPresentation = createDefaultAnnotationPresentation();

    for (const kind of styledAnnotationRendererKinds) {
      const { createCanonicalStyle, styleField } =
        annotationRendererRegistry[kind];
      const style = createCanonicalStyle();
      const expectedStyle = expectedCanonicalStyles[kind];

      expect(style).not.toBe(createCanonicalStyle());

      if (expectedStyle === null) {
        expect(style).toHaveProperty("resolve");
        expect(defaultPresentation[styleField]).toBeUndefined();
        continue;
      }

      expect(style).toBeInstanceOf(expectedStyle);
      expect(defaultPresentation[styleField]).toBeInstanceOf(expectedStyle);
    }
  });

  it("resolves the presentation fields of the requested kinds", () => {
    expect(
      resolveAnnotationRendererStyleFields([...annotationRendererKinds]),
    ).toEqual(
      styledAnnotationRendererKinds.map((kind) => expectedStyleFields[kind]),
    );
    expect(
      resolveAnnotationRendererStyleFields(["mask", "region", "box"]),
    ).toEqual(["maskStyle", "boxStyle"]);
  });

  it("builds a descriptor whose id and kind match the vocabulary", () => {
    for (const kind of styledAnnotationRendererKinds) {
      expect(annotationRenderers[kind]()).toEqual({ id: kind, kind });
    }
  });

  it("builds independently identified region renderers", () => {
    expect(
      annotationRenderers.region({
        id: "player-hat",
        region: { anchor: "head", kind: "keypoint-anchor" },
        source: { asset: { src: "/hat.png" }, kind: "asset" },
        target: { className: "person" },
      }),
    ).toEqual({
      id: "player-hat",
      kind: "region",
      region: { anchor: "head", kind: "keypoint-anchor" },
      source: { asset: { src: "/hat.png" }, kind: "asset" },
      target: { className: "person" },
    });
  });
});
