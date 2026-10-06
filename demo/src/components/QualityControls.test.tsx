import { isValidElement, type ReactElement, type ReactNode } from "react";
import { MediaSessionMode } from "supervision";
import { describe, expect, it } from "vitest";

import { QualityControls } from "./QualityControls";
import {
  DemoEngineSource,
  DemoMediaPath,
  optionSupported,
  resolveDemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";

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

describe("QualityControls", () => {
  it("keeps the mask gate disabled when Fine is selected", () => {
    let options: DemoSessionOptions = {
      loop: false,
      preparationGateEnabled: false,
    };
    const render = () =>
      QualityControls.type({
        configuration,
        disabled: false,
        onChange: () => {},
        onSessionOptionsChange: (updated) => {
          options = updated;
        },
        quality: 1.5,
        sessionOptions: options,
      });

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
