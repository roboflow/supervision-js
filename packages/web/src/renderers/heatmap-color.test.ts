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
        values: [0.1, 1],
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
    expect([...rgba.slice(8, 11)]).toEqual([255, 214, 0]);
    expect(rgba[11]).toBeLessThan(255);
  });

  it("keeps one score the same colour across rasters with different peaks", () => {
    const common = {
      bounds: { x: 1, y: 0.5, width: 2, height: 1 },
      width: 2,
      height: 1,
      threshold: 0.1,
    };
    const renderer = annotationRenderers.heatmap();
    const lowerPeak = colorizeHeatmap(
      { ...common, values: [0.2, 0.3] },
      renderer,
    );
    const higherPeak = colorizeHeatmap(
      { ...common, values: [0.2, 0.9] },
      renderer,
    );

    expect([...lowerPeak.slice(0, 4)]).toEqual([...higherPeak.slice(0, 4)]);
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

  it("rejects an oversized raster before allocating its RGBA buffer", () => {
    expect(() =>
      colorizeHeatmap(
        {
          bounds: { x: 0, y: 0, width: 16_000, height: 16_000 },
          width: 16_000,
          height: 16_000,
          values: [0.1],
        },
        annotationRenderers.heatmap(),
      ),
    ).toThrow(RangeError);
  });
});
