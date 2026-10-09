import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaSessionMode } from "supervision";
import { describe, expect, it, vi } from "vitest";

import { RenderControls } from "./RenderControls";
import { createDepthProbe } from "../hooks/depth-probe";
import type { WorkbenchDepth } from "./DepthStyleSection";
import {
  createDemoPresentation,
  defaultDemoPresentationSettings,
  type DemoPresentationSettings,
} from "../presentation/demo-presentation";
import {
  DemoEngineSource,
  DemoMediaPath,
  optionSupported,
  resolveDemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";

const { sections } = vi.hoisted(() => ({
  sections: new Map<string, ReactNode>(),
}));

vi.mock("./InspectorControls", async (importOriginal) => {
  const original = await importOriginal<typeof import("./InspectorControls")>();
  return {
    ...original,
    ControlSection: ({
      children,
      title,
    }: {
      readonly children: ReactNode;
      readonly title: string;
    }) => {
      sections.set(title, children);
      return null;
    },
  };
});

const depth: WorkbenchDepth = {
  blockedReason: null,
  layerId: null,
  layerLoad: { status: "idle" },
  layers: [],
  onLayerChange: () => {},
  probe: createDepthProbe(() => null),
};

const configuration = resolveDemoSessionConfiguration({
  detections: { frames: [] },
  engine: {},
  engineSource: DemoEngineSource.None,
  mediaPath: DemoMediaPath.Mediabunny,
  mediaPathSupport: optionSupported,
  mode: MediaSessionMode.File,
  normalizationSupport: optionSupported,
  playbackGate: false,
  renderer: {},
});

interface ControlProps {
  readonly children?: ReactNode;
  readonly onChange?: (value: unknown) => void;
  readonly optionPath?: string;
}

function findControl(
  node: ReactNode,
  path: string,
): ReactElement<ControlProps> {
  const found = findControlOrNull(node, path);
  if (found === null) throw new Error(`Missing control: ${path}`);
  return found;
}

function findControlOrNull(
  node: ReactNode,
  path: string,
): ReactElement<ControlProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findControlOrNull(child, path);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isValidElement<ControlProps>(node)) return null;
  if (node.props.optionPath === path) return node;
  return findControlOrNull(node.props.children, path);
}

describe("RenderControls", () => {
  it("applies Heatmap controls to the public renderer without accepting a zero score range", () => {
    let settings: DemoPresentationSettings = {
      ...defaultDemoPresentationSettings,
      heatmapsEnabled: true,
    };
    const render = () => {
      sections.clear();
      renderToStaticMarkup(
        createElement(RenderControls, {
          classNames: [],
          configuration,
          depth,
          onChange: (updated) => {
            settings = updated;
          },
          onSessionOptionsChange: () => {},
          sessionOptions: {},
          settings,
        }),
      );
      return sections.get("Heatmap");
    };

    findControl(render(), "heatmap.thresholdScale").props.onChange!(1.25);
    findControl(render(), "heatmap.minimumAlpha").props.onChange!(0);
    findControl(render(), "heatmap.opacity").props.onChange!(0.4);
    findControl(render(), "heatmap.maximumScore").props.onChange!(2);
    findControl(render(), "heatmap.maximumScore").props.onChange!(0);
    findControl(render(), "heatmap.colorStops").props.onChange!("grayscale");

    const renderer = createDemoPresentation(settings).renderers?.find(
      (item) => item.kind === "heatmap",
    );
    expect(renderer).toMatchObject({
      thresholdScale: 1.25,
      minimumAlpha: 0,
      opacity: 0.4,
      maximumScore: 2,
      colorStops: [
        { position: 0, color: 0 },
        { position: 1, color: 0xffffff },
      ],
    });
    findControl(render(), "heatmap.maximumScore").props.onChange!(undefined);
    expect(settings.heatmapMaximumScore).toBeUndefined();
  });

  it("keeps the mask gate disabled when Fine is selected in Segmentation", () => {
    let options: DemoSessionOptions = {
      loop: false,
      preparationGateEnabled: false,
    };
    const render = () => {
      sections.clear();
      renderToStaticMarkup(
        createElement(RenderControls, {
          classNames: [],
          configuration,
          depth,
          onChange: () => {},
          onSessionOptionsChange: (updated) => {
            options = updated;
          },
          sessionOptions: options,
          settings: defaultDemoPresentationSettings,
        }),
      );
      return sections.get("Segmentation");
    };

    findControl(render(), "renderPreparation.playbackGate.quality").props
      .onChange!("fine");
    expect(options).toEqual({
      loop: false,
      preparationGateEnabled: false,
      preparationGateQuality: "fine",
    });

    findControl(render(), "renderPreparation.playbackGate.enabled").props
      .onChange!(true);
    expect(options).toEqual({
      loop: false,
      preparationGateEnabled: true,
      preparationGateQuality: "fine",
    });
  });
});
