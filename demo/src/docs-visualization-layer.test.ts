import { describe, expect, it } from "vitest";
import { defaultDemoPresentationSettings } from "./presentation/demo-presentation";
import {
  createDocsVisualizationLayerPresentation,
  createDocsVisualizationLayerSnippet,
  docsVisualizationLayerIds,
  docsVisualizationLayers,
  filterDocsVisualizationLayerFrames,
  parseDocsVisualizationLayer,
} from "./docs-visualization-layer";

describe("docs visualization layers", () => {
  it("isolates each requested presentation layer", () => {
    for (const layer of docsVisualizationLayerIds) {
      const presentation = createDocsVisualizationLayerPresentation(layer);
      const enabled = Object.entries(presentation)
        .filter(([key, value]) => key.endsWith("Enabled") && value)
        .map(([key]) => key);

      expect(enabled).toEqual(
        layer === "polylines"
          ? ["masksEnabled", "polylinesEnabled"]
          : [layer === "keypoints" ? "keypointsEnabled" : `${layer}Enabled`],
      );
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

  it("keeps the polyline playground focused on one committed basketball trace", () => {
    expect(docsVisualizationLayers.polylines.controls).toHaveLength(1);
    expect(docsVisualizationLayers.polylines.controls[0]?.key).toBe(
      "polylineStrokeWidth",
    );
    expect(
      filterDocsVisualizationLayerFrames("polylines", [
        {
          detections: [
            { className: "basketball", id: "2:0", polyline: { points: [] } },
            {
              className: "basketball",
              id: "2:1",
              metadata: { trajectoryTrackId: "basketball-track:0" },
            },
            { className: "yellow team player", id: "1:0" },
          ],
          mediaTime: 0,
        },
      ])[0]?.detections,
    ).toEqual([
      {
        className: "basketball",
        id: "2:1",
        metadata: { trajectoryTrackId: "basketball-track:0" },
      },
    ]);
  });

  it("uses the same basketball class color for the fixed mask and editable trace", () => {
    const basketballStyle =
      defaultDemoPresentationSettings.classStyles.basketball;

    expect(basketballStyle?.fill).toBe(basketballStyle?.stroke);
  });
});
