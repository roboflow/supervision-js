import { describe, expect, it } from "vitest";

import {
  DocsDepthRangeMode,
  createDocsDepthRenderer,
  createDocsDepthSnippet,
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
