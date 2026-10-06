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
import { defaultDemoPresentationSettings } from "../presentation/demo-presentation";
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
