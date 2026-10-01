import { renderToStaticMarkup } from "react-dom/server";
import { depthColormapColors, type DepthMap } from "supervision";
import { describe, expect, it } from "vitest";

import {
  DocsDepthRangeMode,
  initialDocsDepthSettings,
  type DocsDepthSettings,
} from "../docs-depth";
import type { DepthProbe, DepthProbeSnapshot } from "../hooks/depth-probe";
import {
  DepthStyleControls,
  DepthStyleSection,
  WorkbenchDepthReadout,
  shortLayerLabel,
  type WorkbenchDepth,
} from "./DepthStyleSection";
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

function workbenchDepth(
  overrides: Partial<WorkbenchDepth> = {},
): WorkbenchDepth {
  return {
    blockedReason: null,
    layerId: "sgbm",
    layerLoad: { status: "idle" },
    layers: [
      { id: "ground-truth", label: "Ground truth (Spring)" },
      { id: "sgbm", label: "Stereo matcher (OpenCV SGBM)" },
    ],
    onLayerChange: () => {},
    probe: probe({
      active: {
        frameIndex: 96,
        map,
        mediaHeight: 1,
        mediaTime: 4,
        mediaWidth: 1,
        precision: "exact",
      },
      readout: null,
    }),
    ...overrides,
  };
}

function controls(
  settings: DocsDepthSettings = initialDocsDepthSettings,
  depth: WorkbenchDepth = workbenchDepth(),
) {
  return renderToStaticMarkup(
    <DepthStyleControls
      depth={depth}
      disabled={false}
      onChange={() => {}}
      settings={settings}
    />,
  );
}

describe("the Style panel's Depth section", () => {
  it("offers every depth renderer option the docs playground offers", () => {
    const markup = controls();

    for (const label of [
      "Layer",
      "Colormap",
      "Quantity",
      "Range",
      "Opacity",
      "Wipe",
      "Sampling",
      "Paint pixels without depth",
      "No-depth colour",
    ]) {
      expect(markup).toContain(label);
    }
    for (const option of [
      "Turbo",
      "Viridis",
      "Cividis",
      "Inferno",
      "Magma",
      "Grayscale",
      "Disparity (px)",
      "Depth (m)",
      "Clip",
      "Auto",
      "Manual",
      "Nearest",
      "Edge-aware",
    ]) {
      expect(markup).toContain(`>${option}</button>`);
    }
  });

  it("switches between the sample's layers by their short names", () => {
    const markup = controls();

    expect(markup).toContain(">Ground truth</button>");
    expect(markup).toContain(">Stereo matcher</button>");
    expect(markup).toContain("Stereo matcher (OpenCV SGBM)");
    expect(shortLayerLabel("Ground truth (Spring)")).toBe("Ground truth");
  });

  it("says while a picked layer loads, and why it did not", () => {
    expect(
      controls(
        initialDocsDepthSettings,
        workbenchDepth({ layerLoad: { status: "loading" } }),
      ),
    ).toContain("Loading Stereo matcher (OpenCV SGBM)…");
    expect(
      controls(
        initialDocsDepthSettings,
        workbenchDepth({
          layerLoad: { message: "404 sgbm/depth.json", status: "failed" },
        }),
      ),
    ).toContain("Depth did not load: 404 sgbm/depth.json");
  });

  it("draws the legend from the renderer's own colours and the map's range", () => {
    const markup = controls({
      ...initialDocsDepthSettings,
      colormap: "viridis",
    });

    expect(markup).toContain(depthColormapColors("viridis").join(", "));
    expect(markup).toContain("far 2 px");
    expect(markup).toContain("near 33 px");
  });

  it("asks for a manual range in the quantity's unit, with a lock", () => {
    const markup = controls({
      ...initialDocsDepthSettings,
      manualRange: { max: 12.5, min: 0.75 },
      quantity: "depth",
      rangeMode: DocsDepthRangeMode.Manual,
    });

    expect(markup).toContain("Min (m)");
    expect(markup).toContain("Max (m)");
    expect(markup).toContain('value="0.75"');
    expect(markup).toContain("Lock to this frame");
  });

  it("cannot lock a range with no depth on screen", () => {
    const markup = controls(
      { ...initialDocsDepthSettings, rangeMode: DocsDepthRangeMode.Manual },
      workbenchDepth({ probe: probe({ active: null, readout: null }) }),
    );

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Lock to this frame/);
    expect(
      controls(
        initialDocsDepthSettings,
        workbenchDepth({ probe: probe({ active: null, readout: null }) }),
      ),
    ).toContain("Shown once depth is on screen");
  });

  /* A closed group shows only its header, so the reason the switch is off has
   * to sit there, not inside the body nobody can open usefully. */
  it("says on the closed section why depth cannot show on this path", () => {
    const markup = renderToStaticMarkup(
      <DepthStyleSection
        available={false}
        depth={workbenchDepth({
          blockedReason: DEPTH_VIDEO_OFF_WHILE_CONVERTING,
        })}
        enabled={false}
        onChange={() => {}}
        onToggleEnabled={() => {}}
        settings={initialDocsDepthSettings}
      />,
    );

    expect(markup).toContain(">Depth</h3>");
    expect(markup).toMatch(/aria-label="Show depth"[^>]*disabled=""/);
    expect(markup).toContain("depth stays off while conversion is on");
    expect(markup).not.toContain("Colormap");
  });

  it("keeps one set of readout rows before any depth is drawn", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchDepthReadout probe={probe({ active: null, readout: null })} />,
    );

    expect(markup).toContain("No depth on screen yet");
    expect(markup).toContain("Depth frame");
    expect(markup).toContain("Confidence");
  });
});

describe("the depth-only message", () => {
  it("says plainly why depth is off and how to bring it back", () => {
    expect(DEPTH_VIDEO_OFF_WHILE_CONVERTING).toContain(
      "converting the clip first can change those frames",
    );
    expect(DEPTH_VIDEO_OFF_WHILE_CONVERTING).toContain(
      "Turn conversion off to see depth.",
    );
  });
});
