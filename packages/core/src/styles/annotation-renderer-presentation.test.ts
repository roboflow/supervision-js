import { describe, expect, it } from "vitest";

import { annotationRenderers } from "#types/annotation-renderer";
import { BaseBoxStyle } from "#styles/box-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { resolveAnnotationRendererPresentation } from "#styles/annotation-renderer-presentation";
import { createSourceAwarePresentation } from "#styles/source-presentation";
import type { DetectionFrame } from "#types/detections";

const frame: DetectionFrame = { detections: [], mediaTime: 0 };

describe("annotation renderer presentation", () => {
  it("preserves the current presentation when no renderers are configured", () => {
    const presentation = { boxStyle: new BaseBoxStyle() };

    expect(resolveAnnotationRendererPresentation(presentation)).toBe(
      presentation,
    );
  });

  it("uses a renderer list as the authoritative built-in layer selection", () => {
    const legacyLabelStyle = new BaseLabelStyle({ text: "legacy label" });
    const rendererBoxStyle = new BaseBoxStyle({
      stroke: { color: 0x8b5cf6, width: 3 },
    });

    const presentation = resolveAnnotationRendererPresentation({
      boxStyle: new BaseBoxStyle({ stroke: { color: 0x22c55e, width: 1 } }),
      labelStyle: legacyLabelStyle,
      renderers: [annotationRenderers.box({ style: rendererBoxStyle })],
    });

    expect(presentation.boxStyle).toBe(rendererBoxStyle);
    expect(presentation.labelStyle).toBeNull();
  });

  it("allows a renderer to disable its established layer", () => {
    const presentation = resolveAnnotationRendererPresentation({
      maskStyle: new BaseMaskStyle(),
      renderers: [annotationRenderers.mask({ style: null })],
    });

    expect(presentation.maskStyle).toBeNull();
  });

  it("rejects duplicate renderer identities instead of silently discarding a style", () => {
    expect(() =>
      resolveAnnotationRendererPresentation({
        renderers: [annotationRenderers.box(), annotationRenderers.box()],
      }),
    ).toThrow('duplicate renderer id "box"');
  });

  it("rejects duplicate renderer kinds with distinct identities", () => {
    expect(() =>
      resolveAnnotationRendererPresentation({
        renderers: [
          { id: "first-box", kind: "box" },
          { id: "second-box", kind: "box" },
        ],
      }),
    ).toThrow('duplicate renderer kind "box"');
  });

  it("disables every built-in layer when the renderer list is empty", () => {
    const presentation = resolveAnnotationRendererPresentation({
      boxStyle: new BaseBoxStyle(),
      labelStyle: new BaseLabelStyle(),
      maskStyle: new BaseMaskStyle(),
      renderers: [],
    });

    expect(presentation).toMatchObject({
      boxStyle: null,
      keypointStyle: null,
      labelStyle: null,
      maskStyle: null,
      polygonStyle: null,
      polylineStyle: null,
    });
  });

  it("keeps the legacy/default style when a renderer has no explicit style", () => {
    const boxStyle = new BaseBoxStyle();

    const presentation = resolveAnnotationRendererPresentation({
      boxStyle,
      renderers: [annotationRenderers.box()],
    });

    expect(presentation.boxStyle).toBe(boxStyle);
  });

  it("uses the canonical style when a listed renderer has no configured style", () => {
    const presentation = resolveAnnotationRendererPresentation({
      renderers: [annotationRenderers.box()],
    });

    expect(presentation.boxStyle).toBeInstanceOf(BaseBoxStyle);
  });

  it("keeps source-specific style overrides after renderer normalization", () => {
    const globalBoxStyle = new BaseBoxStyle({
      stroke: { color: 0x8b5cf6, width: 2 },
    });
    const sourceBoxStyle = new BaseBoxStyle({
      stroke: { color: 0x22c55e, width: 4 },
    });
    const presentation = createSourceAwarePresentation(
      resolveAnnotationRendererPresentation({
        renderers: [annotationRenderers.box({ style: globalBoxStyle })],
      }),
      [{ id: "draft", presentation: { boxStyle: sourceBoxStyle } }],
    );
    const context = { detectionIndex: 0, frame, mediaTime: 0 };

    expect(
      presentation.boxStyle?.resolve(
        { rect: { height: 8, width: 8, x: 4, y: 4 } },
        context,
      )?.stroke,
    ).toMatchObject({ color: 0x8b5cf6, width: 2 });
    expect(
      presentation.boxStyle?.resolve(
        {
          rect: { height: 8, width: 8, x: 4, y: 4 },
          sourceId: "draft",
        },
        context,
      )?.stroke,
    ).toMatchObject({ color: 0x22c55e, width: 4 });
  });
});
