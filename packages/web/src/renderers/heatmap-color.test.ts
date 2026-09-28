import { describe, expect, it } from "vitest";
import { annotationRenderers } from "supervision-js-core";
import { colorizeHeatmap } from "./heatmap-color";

describe("colorizeHeatmap", () => {
  it("keeps scores below the model threshold transparent", () => {
    const rgba = colorizeHeatmap(
      {
        bounds: { x: 1, y: 0.5, width: 2, height: 1 },
        width: 2,
        height: 1,
        values: [0.1, 0.2],
        threshold: 0.1,
      },
      annotationRenderers.heatmap(),
    );
    expect([...rgba.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...rgba.slice(4, 8)]).toEqual([220, 30, 30, 255]);
  });

  it("decodes scaled 16-bit samples and supports a lower display cutoff", () => {
    const rgba = colorizeHeatmap(
      {
        bounds: { x: 1.5, y: 0.5, width: 3, height: 1 },
        width: 3,
        height: 1,
        values: [0, 6500, 13000],
        valueScale: 1 / 65535,
        threshold: 0.10525,
      },
      annotationRenderers.heatmap({
        thresholdScale: 0.75,
        minimumAlpha: 0.35,
      }),
    );
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBeGreaterThan(0);
    expect([...rgba.slice(8, 12)]).toEqual([220, 30, 30, 255]);
  });

  it("rejects a mismatched raster instead of displaying stale geometry", () => {
    expect(() =>
      colorizeHeatmap(
        {
          bounds: { x: 0, y: 0, width: 2, height: 1 },
          width: 2,
          height: 1,
          values: [0.1],
        },
        annotationRenderers.heatmap(),
      ),
    ).toThrow(RangeError);
  });
});
