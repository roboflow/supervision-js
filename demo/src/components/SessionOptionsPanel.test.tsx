import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  MediaInteractionMode,
  MediaRendererFit,
  MediaSessionMode,
  PlaybackGateReach,
  RenderPreparationMode,
  type MediaSessionDetectionOptions,
  type MediaSessionRendererOptions,
} from "supervision";
import { describe, expect, it } from "vitest";

import { SessionOptionsPanel } from "./SessionOptionsPanel";
import {
  normalizationSupported,
  resolveDemoSessionConfiguration,
} from "../session/session-options";

const detections: MediaSessionDetectionOptions = {
  frames: [],
  sync: { frameRate: 24 },
};

const renderer: MediaSessionRendererOptions = {
  autoPlay: false,
  fit: MediaRendererFit.Contain,
  interaction: { mode: MediaInteractionMode.PausedOnly },
  loop: true,
  renderPreparation: { mode: RenderPreparationMode.Worker },
};

const configuration = resolveDemoSessionConfiguration({
  detections,
  mode: MediaSessionMode.File,
  normalizable: normalizationSupported,
  playbackGate: true,
  renderer,
});

interface ControlProps {
  readonly label?: string;
  readonly optionPath?: string;
  readonly tooltip?: string;
}

function renderControls(): ReactElement<ControlProps>[] {
  const panel = SessionOptionsPanel.type({
    configuration,
    onChange: () => {},
    options: {},
    playbackGateReach: PlaybackGateReach.StartOfPlayback,
  });

  return collect(panel).filter((node) => node.props.optionPath !== undefined);
}

function collect(
  node: ReactNode,
  found: ReactElement<ControlProps>[] = [],
): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, found);
    }
    return found;
  }

  if (!isValidElement<{ readonly children?: ReactNode } & ControlProps>(node)) {
    return found;
  }

  found.push(node);

  if (node.props.optionPath !== undefined) {
    return found;
  }

  /* The panel hands its controls to a component of its own, so the tree stops
   * at that element until it is called. */
  if (typeof node.type === "function" && node.props.children === undefined) {
    collect((node.type as (props: unknown) => ReactNode)(node.props), found);
    return found;
  }

  return collect(node.props.children, found);
}

describe("SessionOptionsPanel", () => {
  it("explains every option it offers", () => {
    const controls = renderControls();

    expect(controls.length).toBeGreaterThan(30);
    expect(
      controls
        .filter((control) => (control.props.tooltip ?? "").length < 80)
        .map((control) => control.props.optionPath),
    ).toEqual([]);
  });

  it("names the option each explainer is about, so a reader can go and find it", () => {
    expect(
      renderControls()
        .filter((control) => !/`[\w.]+`/.test(control.props.tooltip ?? ""))
        .map((control) => control.props.optionPath),
    ).toEqual([]);
  });

  it("labels controls with the name the API uses", () => {
    expect(
      renderControls()
        .filter((control) => !sharesWording(control.props))
        .map(
          (control) => `${control.props.label} / ${control.props.optionPath}`,
        ),
    ).toEqual([]);
  });
});

/** Whether every word of the option's last segment survives in the label. */
function sharesWording({ label, optionPath }: ControlProps) {
  const leaf = (optionPath ?? "").split(".").pop() ?? "";

  return words(leaf).every((word) => words(label ?? "").includes(word));
}

function words(value: string) {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
