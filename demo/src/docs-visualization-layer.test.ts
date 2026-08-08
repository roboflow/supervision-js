import { describe, expect, it } from "vitest";
import { defaultDemoPresentationSettings } from "./presentation/demo-presentation";
import {
  createDocsVisualizationLayerPresentation,
  createDocsVisualizationLayerSnippet,
  docsVisualizationLayerIds,
  parseDocsVisualizationLayer,
} from "./docs-visualization-layer";

describe("docs visualization layers", () => {
  it("isolates each requested presentation layer", () => {
    for (const layer of docsVisualizationLayerIds) {
      const presentation = createDocsVisualizationLayerPresentation(layer);
      const enabled = Object.entries(presentation)
        .filter(([key, value]) => key.endsWith("Enabled") && value)
        .map(([key]) => key);

      expect(enabled).toEqual([
        layer === "keypoints" ? "keypointsEnabled" : `${layer}Enabled`,
      ]);
    }
  });

  it("falls back to boxes for unknown layer ids", () => {
    expect(parseDocsVisualizationLayer("masks")).toBe("masks");
    expect(parseDocsVisualizationLayer("unknown")).toBe("boxes");
  });

  it("keeps live values in the focused snippet", () => {
    expect(
      createDocsVisualizationLayerSnippet("boxes", {
        ...defaultDemoPresentationSettings,
        boxFillAlpha: 0.27,
        boxStrokeWidth: 6,
      }),
    ).toContain("fill: { alpha: 0.27 }");
    expect(
      createDocsVisualizationLayerSnippet("boxes", {
        ...defaultDemoPresentationSettings,
        boxFillAlpha: 0.27,
        boxStrokeWidth: 6,
      }),
    ).toContain("stroke: { width: 6 }");
    expect(
      createDocsVisualizationLayerSnippet("polylines", {
        ...defaultDemoPresentationSettings,
        polylineStrokeWidth: 7,
      }),
    ).toContain("stroke: { width: 7 }");
  });
});
