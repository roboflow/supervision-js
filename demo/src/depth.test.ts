import { describe, expect, it } from "vitest";

import type { ActiveDepthMap, DepthMap } from "supervision";

import {
  DepthRangeMode,
  changeDepthQuantity,
  changeDepthRangeMode,
  createDepthLayerLoader,
  createDepthRenderer,
  createDepthSnippet,
  describeDepthReadout,
  initialDepthSettings,
  lockDepthRange,
  resolveDepthColourRange,
  type DepthLayerLoad,
  type DepthSettings,
} from "./depth";

/** Evaluates the object literal the snippet passes to `annotationRenderers.depth`. */
function snippetOptions(snippet: string): unknown {
  const start = snippet.indexOf("annotationRenderers.depth(") + 26;
  const end = snippet.lastIndexOf("}),") + 1;

  return new Function(`return (${snippet.slice(start, end)});`)();
}

const variations: readonly DepthSettings[] = [
  initialDepthSettings,
  {
    colormap: "cividis",
    manualRange: { max: 12.5, min: 0.75 },
    noDepthColor: 0x202020,
    opacity: 0.65,
    quantity: "depth",
    rangeMode: DepthRangeMode.Manual,
    sampling: "edge-aware",
    wipe: 0.4,
  },
  {
    ...initialDepthSettings,
    colormap: "magma",
    noDepthColor: 0x00ff00,
    rangeMode: DepthRangeMode.Auto,
    sampling: "nearest",
  },
];

describe("depth settings", () => {
  it.each(variations)(
    "builds the renderer its snippet describes (%#)",
    (settings) => {
      const { id, kind, ...renderer } = createDepthRenderer(settings);

      expect([id, kind]).toEqual(["depth", "depth"]);
      expect(snippetOptions(createDepthSnippet(settings))).toEqual(renderer);
    },
  );

  it("shows every control value verbatim", () => {
    const settings = variations[1]!;
    const snippet = createDepthSnippet(settings);

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
    expect(createDepthSnippet(initialDepthSettings)).toContain('range: "clip"');
  });
});

describe("depth pointer readout", () => {
  const active = (kind: DepthMap["kind"]): ActiveDepthMap => ({
    frameIndex: 42,
    map: {
      height: 1,
      kind,
      samples: { encoding: "scaled16", scale: 1, values: new Uint16Array(1) },
      width: 1,
    },
    mediaHeight: 1,
    mediaTime: 0,
    mediaWidth: 1,
    precision: "exact",
  });
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
  const disparity = active("disparity_px");

  it("keeps the same rows with no depth, off the picture, over a hole and over depth", () => {
    const states = [
      describeDepthReadout(null, null),
      describeDepthReadout(disparity, null),
      describeDepthReadout(disparity, {
        precision: "exact",
        stored: 0,
        valid: false,
        x: 3,
        y: 4,
      }),
      describeDepthReadout(disparity, exact),
      describeDepthReadout(disparity, { ...exact, precision: "preview" }),
    ];
    const labels = states.map(({ rows }) => rows.map(({ label }) => label));

    for (const state of labels) expect(state).toEqual(labels[0]);
    expect(states.map(({ status }) => status)).toEqual([
      "No depth on screen yet",
      "Point at the picture",
      "No depth at this pixel",
      "Exact value",
      "≈ 8-bit preview value",
    ]);
    expect(states[0]!.rows.every(({ value }) => value === "—")).toBe(true);
  });

  it("formats values with fixed decimals and units", () => {
    expect(describeDepthReadout(disparity, exact).rows).toEqual([
      { label: "Depth frame", value: "42" },
      { label: "Map pixel", value: "640, 12" },
      { label: "Stored", value: "24896" },
      { label: "Disparity", value: "97.250 px" },
      { label: "Depth", value: "1.234 m" },
      { label: "Step", value: "0.00391 px" },
      { label: "Confidence", value: "50.0 %" },
    ]);
  });

  it("names the relative quantity for monocular maps", () => {
    const view = describeDepthReadout(active("relative_inverse"), {
      precision: "exact",
      relativeInverse: 0.25,
      step: 1 / 1000,
      stored: 250,
      valid: true,
      x: 0,
      y: 0,
    });

    expect(view.rows[3]).toEqual({ label: "Inverse depth", value: "0.2500" });
    expect(view.rows[5]).toEqual({ label: "Step", value: "0.00100" });
  });
});

describe("depth colour legend", () => {
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

  it("reads the clip range, near end warm, in the quantity's unit", () => {
    expect(resolveDepthColourRange(map, initialDepthSettings)).toEqual({
      far: 2,
      near: 32,
      unit: "px",
    });
    expect(
      resolveDepthColourRange(map, {
        ...initialDepthSettings,
        quantity: "depth",
      }),
    ).toEqual({ far: 43.771, near: 2.736, unit: "m" });
  });

  it("reads this frame's percentiles in auto, and the inputs in manual", () => {
    expect(
      resolveDepthColourRange(map, {
        ...initialDepthSettings,
        rangeMode: DepthRangeMode.Auto,
      }),
    ).toEqual({ far: 3, near: 97, unit: "px" });
    expect(
      resolveDepthColourRange(null, {
        ...initialDepthSettings,
        manualRange: { max: 20, min: 4 },
        rangeMode: DepthRangeMode.Manual,
      }),
    ).toEqual({ far: 4, near: 20, unit: "px" });
  });

  it("waits for depth on screen before describing a map's range", () => {
    expect(resolveDepthColourRange(null, initialDepthSettings)).toEqual({
      message: "Shown once depth is on screen",
    });
  });
});

describe("depth range controls", () => {
  const manual: DepthSettings = {
    ...initialDepthSettings,
    manualRange: { max: 150, min: 3 },
    rangeMode: DepthRangeMode.Manual,
  };
  const locked = { max: 9.5, min: 1.25 };
  const lockTo = () => locked;
  const noDepth = () => null;

  it("keeps a clip or auto range when the quantity changes", () => {
    expect(changeDepthQuantity(initialDepthSettings, "depth", lockTo)).toEqual({
      quantity: "depth",
    });
  });

  it("locks a manual range again in the new unit, or falls back to the clip's", () => {
    expect(changeDepthQuantity(manual, "depth", lockTo)).toEqual({
      manualRange: locked,
      quantity: "depth",
    });
    expect(changeDepthQuantity(manual, "depth", noDepth)).toEqual({
      quantity: "depth",
      rangeMode: DepthRangeMode.Clip,
    });
  });

  it("starts a manual range from the depth on screen when there is some", () => {
    expect(
      changeDepthRangeMode(initialDepthSettings, DepthRangeMode.Manual, lockTo),
    ).toEqual({ manualRange: locked, rangeMode: DepthRangeMode.Manual });
    expect(
      changeDepthRangeMode(
        initialDepthSettings,
        DepthRangeMode.Manual,
        noDepth,
      ),
    ).toEqual({ rangeMode: DepthRangeMode.Manual });
    expect(changeDepthRangeMode(manual, DepthRangeMode.Auto, lockTo)).toEqual({
      rangeMode: DepthRangeMode.Auto,
    });
  });

  it("locks to nothing without a map", () => {
    expect(lockDepthRange(null, "disparity")).toBeNull();
    expect(lockDepthRange(undefined, "depth")).toBeNull();
  });
});

describe("depth layer loads", () => {
  it("report only the latest swap, and why it failed", async () => {
    const reports: DepthLayerLoad[] = [];
    const loader = createDepthLayerLoader((load) => reports.push(load));
    let finishFirst!: () => void;
    const first = loader.load(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    const second = loader.load(() => Promise.reject(new Error("404")));

    await second;
    finishFirst();
    await first;

    expect(reports).toEqual([
      { status: "loading" },
      { status: "loading" },
      { message: "404", status: "failed" },
    ]);

    loader.reset();
    expect(reports.at(-1)).toEqual({ status: "idle" });
  });
});
