import { describe, expect, it } from "vitest";

import type { DepthMap } from "supervision";

import {
  DocsDepthRangeMode,
  createDocsDepthRenderer,
  createDocsDepthSnippet,
  describeDepthColourRange,
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
    expect(describeDepthReadout(exact, { frameIndex: 42 }).rows).toEqual([
      { label: "Depth frame", value: "42" },
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

  it("says why nothing is read when no depth is drawn", () => {
    expect(
      describeDepthReadout(null, {
        frameIndex: null,
        idleStatus: "No depth while playing",
      }),
    ).toMatchObject({
      rows: expect.arrayContaining([{ label: "Depth frame", value: "—" }]),
      status: "No depth while playing",
    });
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
      { kind: "relative_inverse" },
    );

    expect(view.rows[3]).toEqual({ label: "Inverse depth", value: "0.2500" });
    expect(view.rows[5]).toEqual({ label: "Step", value: "0.00100" });
  });
});

describe("depth colour range note", () => {
  /** Disparity 2 to 32 px of a 1346.8 px, 6.5 cm stereo rig, like Spring's. */
  const map: DepthMap = {
    camera: { baselineM: 0.065, fxPx: 1346.8013 },
    displayRange: { max: 32, min: 2 },
    height: 1,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 1,
      values: Uint16Array.from({ length: 100 }, (_, i) => i + 1),
    },
    width: 100,
  };

  it("reads the clip range, near end first, in the quantity's unit", () => {
    expect(describeDepthColourRange(map, initialDocsDepthSettings)).toBe(
      "Colour range: near 32 px (warm) to far 2 px",
    );
    expect(
      describeDepthColourRange(map, {
        ...initialDocsDepthSettings,
        quantity: "depth",
      }),
    ).toBe("Colour range: near 2.736 m (warm) to far 43.771 m");
  });

  it("reads this frame's percentiles in auto, and the inputs in manual", () => {
    expect(
      describeDepthColourRange(map, {
        ...initialDocsDepthSettings,
        rangeMode: DocsDepthRangeMode.Auto,
      }),
    ).toBe("Colour range: near 97 px (warm) to far 3 px");
    expect(
      describeDepthColourRange(null, {
        ...initialDocsDepthSettings,
        manualRange: { max: 20, min: 4 },
        rangeMode: DocsDepthRangeMode.Manual,
      }),
    ).toBe("Colour range: near 20 px (warm) to far 4 px");
  });

  it("waits for depth on screen before describing a map's range", () => {
    expect(describeDepthColourRange(null, initialDocsDepthSettings)).toBe(
      "Colour range: shown once depth is on screen",
    );
  });
});
