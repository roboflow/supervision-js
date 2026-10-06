import { renderToStaticMarkup } from "react-dom/server";
import { depthColormapColors, type DepthMap } from "supervision";
import { describe, expect, it } from "vitest";

import {
  DepthRangeMode,
  initialDepthSettings,
  type DepthSettings,
} from "../depth";
import type { DepthProbe, DepthProbeSnapshot } from "../hooks/depth-probe";
import { DepthControls, type DepthControlKit } from "./DepthControls";
import { DepthStyleSection, depthStyleKit } from "./DepthStyleSection";
import { DocsDepthPlayground, depthPlaygroundKit } from "./DocsDepthPlayground";
import { DEPTH_VIDEO_OFF_WHILE_CONVERTING } from "./media-path-copy";

const map: DepthMap = {
  displayRange: { max: 33, min: 2 },
  height: 1,
  kind: "disparity_px",
  samples: { encoding: "scaled16", scale: 1, values: new Uint16Array([10]) },
  width: 1,
};

function probe(snapshot: DepthProbeSnapshot): DepthProbe {
  return {
    getSnapshot: () => snapshot,
    onPointerLeave: () => {},
    onPointerMove: () => {},
    refresh: () => {},
    subscribe: () => () => {},
  };
}

const depthOnScreen = probe({
  active: {
    frameIndex: 96,
    map,
    mediaHeight: 1,
    mediaTime: 4,
    mediaWidth: 1,
    precision: "exact",
  },
  readout: null,
});
const noDepth = probe({ active: null, readout: null });

function styleControls(
  settings: DepthSettings = initialDepthSettings,
  depthProbe: DepthProbe = depthOnScreen,
) {
  return renderToStaticMarkup(
    <DepthControls
      kit={depthStyleKit}
      onChange={() => {}}
      probe={depthProbe}
      settings={settings}
    />,
  );
}

const controlLabels = [
  "Colormap",
  "Quantity",
  "Range",
  "Opacity",
  "Wipe",
  "Sampling",
  "Paint pixels without depth",
  "No-depth colour",
];
const optionLabels = [
  "Turbo",
  "Grayscale",
  "Disparity (px)",
  "Depth (m)",
  "Clip",
  "Manual",
  "Nearest",
  "Edge-aware",
];

describe("the depth controls", () => {
  it("offer the same controls and options in the Style panel and the docs playground", () => {
    const style = styleControls();
    const docs = renderToStaticMarkup(<DocsDepthPlayground />);

    for (const label of controlLabels) {
      expect(style).toContain(label);
      expect(docs).toContain(label);
    }
    for (const option of optionLabels) {
      expect(style).toContain(`>${option}</button>`);
      expect(docs).toContain(`>${option}</option>`);
    }
  });

  it("draw the legend from the renderer's own colours and the map's range", () => {
    const markup = styleControls({
      ...initialDepthSettings,
      colormap: "viridis",
    });

    expect(markup).toContain(depthColormapColors("viridis").join(", "));
    expect(markup).toContain("far 2 px");
    expect(markup).toContain("near 33 px");
  });

  it("ask for a manual range in the quantity's unit, locked only to depth on screen", () => {
    const manual = {
      ...initialDepthSettings,
      manualRange: { max: 12.5, min: 0.75 },
      quantity: "depth" as const,
      rangeMode: DepthRangeMode.Manual,
    };

    expect(styleControls(manual)).toContain("Min (m)");
    expect(styleControls(manual)).toContain('value="0.75"');
    expect(styleControls(manual)).toMatch(
      /<button class="depth-controls__lock" type="button">Lock to this frame/,
    );
    expect(styleControls(manual, noDepth)).toMatch(
      /<button[^>]*disabled=""[^>]*>Lock to this frame/,
    );
    expect(styleControls(initialDepthSettings, noDepth)).toContain(
      "Shown once depth is on screen",
    );
  });
});

describe("the manual range slider", () => {
  const manual: DepthSettings = {
    ...initialDepthSettings,
    manualRange: { max: 20, min: 4 },
    rangeMode: DepthRangeMode.Manual,
  };
  const render = (kit: DepthControlKit, settings: DepthSettings) =>
    renderToStaticMarkup(
      <DepthControls
        kit={kit}
        onChange={() => {}}
        probe={depthOnScreen}
        settings={settings}
      />,
    );

  it("shows two thumbs over the clip's range in both the Style panel and the docs playground", () => {
    for (const kit of [depthStyleKit, depthPlaygroundKit]) {
      const markup = render(kit, manual);
      const thumbs = markup.match(/role="slider"/g) ?? [];

      expect(thumbs).toHaveLength(2);
      expect(markup).toMatch(/aria-label="Min \(px\)"[^>]*aria-valuemin="0"/);
      expect(markup).toMatch(
        /aria-label="Max \(px\)"[^>]*aria-valuemax="36.1"/,
      );
      expect(markup).toContain('value="4"');
      expect(render(kit, initialDepthSettings)).not.toContain('role="slider"');
    }
  });

  it("paints the picked values with the colormap, near end warm in either quantity", () => {
    const [far, ...rest] = depthColormapColors("turbo");
    const near = rest[rest.length - 1];

    expect(render(depthStyleKit, manual)).toMatch(
      new RegExp(`linear-gradient\\(to right, ${far} 0%, ${far} `),
    );
    expect(render(depthStyleKit, { ...manual, quantity: "depth" })).toMatch(
      new RegExp(`linear-gradient\\(to right, ${near} 0%, ${near} `),
    );
  });
});

describe("the Style panel's Depth section", () => {
  it("says on the closed section why depth cannot show on this path", () => {
    const markup = renderToStaticMarkup(
      <DepthStyleSection
        available={false}
        depth={{
          blockedReason: DEPTH_VIDEO_OFF_WHILE_CONVERTING,
          layerId: null,
          layerLoad: { status: "idle" },
          layers: [],
          onLayerChange: () => {},
          probe: noDepth,
        }}
        enabled={false}
        onChange={() => {}}
        onToggleEnabled={() => {}}
        settings={initialDepthSettings}
      />,
    );

    expect(markup).toContain(">Depth</h3>");
    expect(markup).toMatch(/aria-label="Show depth"[^>]*disabled=""/);
    expect(markup).toContain("Turn conversion off to see depth.");
    expect(markup).not.toContain("Colormap");
  });
});

describe("the docs depth playground", () => {
  it("shows the fixture's layers, a readout and the live code", () => {
    const markup = renderToStaticMarkup(<DocsDepthPlayground />);

    expect(markup).toMatch(/name="depth-layer"[^>]*value="ground-truth"/);
    expect(markup).toContain("Depth frame");
    expect(markup).toContain("No depth on screen yet");
    expect(markup).toContain("session.setPresentation({");
    expect(markup).toContain("colormap: &quot;turbo&quot;");
  });
});
