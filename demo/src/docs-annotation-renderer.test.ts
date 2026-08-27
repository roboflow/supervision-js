import { describe, expect, it } from "vitest";
import { MarkerShape } from "supervision";
import { defaultDemoPresentationSettings } from "./presentation/demo-presentation";
import {
  createDocsAnnotationRendererPresentation,
  createDocsAnnotationRendererSnippet,
  docsAnnotationRendererIds,
  docsAnnotationRenderers,
  filterDocsAnnotationRendererFrames,
  parseDocsAnnotationRenderer,
} from "./docs-annotation-renderer";

describe("docs annotation renderers", () => {
  it("isolates each requested annotation renderer", () => {
    for (const renderer of docsAnnotationRendererIds) {
      const presentation = createDocsAnnotationRendererPresentation(renderer);
      const enabled = Object.entries(presentation)
        .filter(([key, value]) => key.endsWith("Enabled") && value)
        .map(([key]) => key);

      const expectedEnabled =
        renderer === "polylines"
          ? ["masksEnabled", "polylinesEnabled"]
          : renderer === "keypoints"
            ? ["keypointsEnabled"]
            : renderer === "markers"
              ? ["markersEnabled"]
              : renderer === "box-corners"
                ? ["boxCornersEnabled"]
                : renderer === "ellipse"
                  ? ["ellipsesEnabled"]
                  : renderer === "mask-halo"
                    ? ["maskHaloEnabled"]
                    : renderer === "regions" || renderer === "region-effects"
                      ? []
                      : [`${renderer}Enabled`];

      expect(enabled).toEqual(expectedEnabled);
    }
  });

  it("falls back to boxes for unknown renderer ids", () => {
    expect(parseDocsAnnotationRenderer("masks")).toBe("masks");
    expect(parseDocsAnnotationRenderer("unknown")).toBe("boxes");
  });

  it("keeps live values in the focused snippet", () => {
    expect(
      createDocsAnnotationRendererSnippet("boxes", {
        ...defaultDemoPresentationSettings,
        boxFillAlpha: 0.27,
        boxStrokeWidth: 6,
      }),
    ).toContain("fill: { alpha: 0.27 }");
    expect(
      createDocsAnnotationRendererSnippet("boxes", {
        ...defaultDemoPresentationSettings,
        boxFillAlpha: 0.27,
        boxStrokeWidth: 6,
      }),
    ).toContain("stroke: { width: 6 }");
    expect(
      createDocsAnnotationRendererSnippet("polylines", {
        ...defaultDemoPresentationSettings,
        polylineStrokeWidth: 7,
      }),
    ).toContain("stroke: { width: 7 }");
    expect(
      createDocsAnnotationRendererSnippet("markers", {
        ...defaultDemoPresentationSettings,
        markerPosition: "bottom-right",
        markerShape: MarkerShape.Triangle,
        markerSize: 20,
        markerStrokeWidth: 3,
      }),
    ).toContain("size: 20");
    const markerSnippet = createDocsAnnotationRendererSnippet("markers", {
      ...defaultDemoPresentationSettings,
      markerPosition: "bottom-right",
      markerShape: MarkerShape.Triangle,
    });
    expect(markerSnippet).toContain("shape: MarkerShape.Triangle");
    expect(markerSnippet).toContain("x: rect.x + rect.width / 2");
    expect(markerSnippet).toContain("y: rect.y + rect.height / 2");
    expect(
      createDocsAnnotationRendererSnippet("box-corners", {
        ...defaultDemoPresentationSettings,
        boxCornerLength: 31,
        boxCornerStrokeWidth: 4,
      }),
    ).toContain("length: 31");
    expect(
      createDocsAnnotationRendererSnippet(
        "masks",
        defaultDemoPresentationSettings,
      ),
    ).toContain("annotationRenderers.mask({");
    const ellipseSnippet = createDocsAnnotationRendererSnippet(
      "ellipse",
      defaultDemoPresentationSettings,
    );
    expect(ellipseSnippet).toContain("x: detection.rect.x,");
    expect(ellipseSnippet).toContain(
      "y: detection.rect.y + detection.rect.height / 2 - radiusY,",
    );
    expect(ellipseSnippet).toContain("alpha: 1,");
  });

  it("exposes marker shape and bounding-box position controls", () => {
    expect(createDocsAnnotationRendererPresentation("markers")).toMatchObject({
      markerPosition: "bottom-center",
      markerShape: MarkerShape.Triangle,
    });
    expect(docsAnnotationRenderers.markers.selects).toMatchObject([
      { key: "markerShape" },
      { key: "markerPosition" },
    ]);
    expect(docsAnnotationRenderers.markers.selects?.[1]?.options).toHaveLength(
      9,
    );
  });

  it("keeps the polyline playground focused on one committed basketball trace", () => {
    expect(docsAnnotationRenderers.polylines.controls).toHaveLength(1);
    expect(docsAnnotationRenderers.polylines.controls[0]?.key).toBe(
      "polylineStrokeWidth",
    );
    expect(
      filterDocsAnnotationRendererFrames("polylines", [
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
