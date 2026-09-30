import { describe, expect, it } from "vitest";

import {
  DocsDepthRangeMode,
  createDocsDepthRenderer,
  createDocsDepthSnippet,
  describeDepthReadout,
  initialDocsDepthSettings,
  type DocsDepthSettings,
} from "./docs-depth";

/** Evaluates the object literal the snippet passes to `annotationRenderers.depth`. */
function snippetOptions(snippet: string): unknown {
  const start = snippet.indexOf("annotationRenderers.depth(") + 26;
  const end = snippet.lastIndexOf("}),") + 1;

  return new Function(`return (${snippet.slice(start, end)});`)();
}

const variations: readonly DocsDepthSettings[] = [
  initialDocsDepthSettings,
  {
    colormap: "cividis",
    manualRange: { max: 12.5, min: 0.75 },
    noDepthColor: 0x202020,
    opacity: 0.65,
    quantity: "depth",
    rangeMode: DocsDepthRangeMode.Manual,
    sampling: "edge-aware",
    wipe: 0.4,
  },
  {
    ...initialDocsDepthSettings,
    colormap: "magma",
    noDepthColor: 0x00ff00,
    rangeMode: DocsDepthRangeMode.Auto,
    sampling: "nearest",
  },
];

describe("depth playground settings", () => {
  it.each(variations)(
    "builds the renderer its snippet describes (%#)",
    (settings) => {
      const { id, kind, ...renderer } = createDocsDepthRenderer(settings);

      expect([id, kind]).toEqual(["depth", "depth"]);
      expect(snippetOptions(createDocsDepthSnippet(settings))).toEqual(
        renderer,
      );
    },
  );

  it("shows every control value verbatim", () => {
    const settings = variations[1]!;
    const snippet = createDocsDepthSnippet(settings);

    for (const text of [
      'colormap: "cividis"',
      'quantity: "depth"',
      "range: { min: 0.75, max: 12.5 }",
      "opacity: 0.65",
      'sampling: "edge-aware"',
      "wipe: 0.4",
      "noDepthColor: 0x202020",
    ]) {
      expect(snippet).toContain(text);
    }
    expect(createDocsDepthSnippet(initialDocsDepthSettings)).toContain(
      'range: "clip"',
    );
  });
});

describe("depth pointer readout", () => {
  const exact = {
    confidence: 0.5,
    depthM: 1.2345,
    disparityPx: 97.25,
    precision: "exact" as const,
    step: 1 / 256,
    stored: 24_896,
    valid: true,
    x: 640,
    y: 12,
  };

  it("keeps the same rows off the picture, over a hole and over depth", () => {
    const states = [
      describeDepthReadout(null),
      describeDepthReadout({
        precision: "exact",
        stored: 0,
        valid: false,
        x: 3,
        y: 4,
      }),
      describeDepthReadout(exact),
    ];
    const labels = states.map(({ rows }) => rows.map(({ label }) => label));

    expect(labels[1]).toEqual(labels[0]);
    expect(labels[2]).toEqual(labels[0]);
    expect(states.map(({ status }) => status)).toEqual([
      "Point at the picture",
      "No depth at this pixel",
      "Exact value",
    ]);
    expect(states[0]!.rows.every(({ value }) => value === "—")).toBe(true);
  });

  it("formats values with fixed decimals and units", () => {
    expect(describeDepthReadout(exact).rows).toEqual([
      { label: "Map pixel", value: "640, 12" },
      { label: "Stored", value: "24896" },
      { label: "Disparity", value: "97.250 px" },
      { label: "Depth", value: "1.234 m" },
      { label: "Step", value: "0.00391 px" },
      { label: "Confidence", value: "50.0 %" },
    ]);
    expect(
      describeDepthReadout({ ...exact, precision: "preview" }).status,
    ).toBe("≈ 8-bit preview value");
  });

  it("names the relative quantity for monocular maps", () => {
    const view = describeDepthReadout(
      {
        precision: "exact",
        relativeInverse: 0.25,
        step: 1 / 1000,
        stored: 250,
        valid: true,
        x: 0,
        y: 0,
      },
      "relative_inverse",
    );

    expect(view.rows[2]).toEqual({ label: "Inverse depth", value: "0.2500" });
    expect(view.rows[4]).toEqual({ label: "Step", value: "0.00100" });
  });
});
