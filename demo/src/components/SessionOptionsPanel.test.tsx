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
  DemoEngineSource,
  DemoMediaPath,
  describeMissingSupport,
  optionSupported,
  resolveDemoSessionConfiguration,
} from "../session/session-options";

const NO_CHOICE_ON_AN_UPLOAD = "An upload always opens on the video engine.";
const NO_CONVERSION_ON_AN_UPLOAD = "An upload cannot be converted first.";
const NO_CONVERSION_ON_THE_ENGINE =
  "Switch the media path to Mediabunny to convert.";

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
  engine: {},
  engineSource: DemoEngineSource.Url,
  mediaPath: DemoMediaPath.Engine,
  mediaPathSupport: optionSupported,
  mode: MediaSessionMode.File,
  normalizationSupport: describeMissingSupport(NO_CONVERSION_ON_THE_ENGINE),
  playbackGate: true,
  renderer,
});

const mediabunnyConfiguration = resolveDemoSessionConfiguration({
  detections,
  engine: {},
  engineSource: DemoEngineSource.None,
  mediaPath: DemoMediaPath.Mediabunny,
  mediaPathSupport: optionSupported,
  mode: MediaSessionMode.File,
  normalizationSupport: optionSupported,
  playbackGate: true,
  renderer,
});

const uploadConfiguration = resolveDemoSessionConfiguration({
  detections,
  engine: {},
  engineSource: DemoEngineSource.Blob,
  mediaPath: DemoMediaPath.Engine,
  mediaPathSupport: describeMissingSupport(NO_CHOICE_ON_AN_UPLOAD),
  mode: MediaSessionMode.File,
  normalizationSupport: describeMissingSupport(NO_CONVERSION_ON_AN_UPLOAD),
  playbackGate: true,
  renderer,
});

const ENGINE_PATH_OPTIONS = [
  "prefer2d",
  "cacheStrategy",
  "previewCapacity",
  "previewWidth",
  "cacheSkipNearMs",
  "sourceResidency",
  "sourceResidency.budgetBytes",
  "urlSource.parallelism",
  "urlSource.maxCacheSize",
];

interface ControlProps {
  readonly children?: ReactNode;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly optionPath?: string;
  readonly title?: string;
  readonly tooltip?: string;
  readonly value?: ReactNode;
}

function renderPanel(
  panelConfiguration = configuration,
): ReactElement<ControlProps>[] {
  return collect(
    SessionOptionsPanel.type({
      configuration: panelConfiguration,
      onChange: () => {},
      options: {},
      playbackGateReach: PlaybackGateReach.StartOfPlayback,
    }),
  );
}

function renderControls(
  panelConfiguration = configuration,
): ReactElement<ControlProps>[] {
  return renderPanel(panelConfiguration).filter(
    (node) => node.props.optionPath !== undefined,
  );
}

function renderSections(): ReactElement<ControlProps>[] {
  return renderPanel().filter((node) => node.props.title !== undefined);
}

function renderReadouts(): ReactElement<ControlProps>[] {
  return renderPanel().filter(
    (node) => node.props.label !== undefined && node.props.value !== undefined,
  );
}

function renderProse(panelConfiguration = configuration): string[] {
  return renderPanel(panelConfiguration)
    .flatMap((node) => [
      node.props.description,
      node.props.tooltip,
      typeof node.props.value === "string" ? node.props.value : undefined,
      node.props.optionPath === undefined && node.props.title === undefined
        ? flatten(node.props.children)
        : undefined,
    ])
    .filter((text): text is string => (text ?? "").length > 0);
}

function flatten(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => flatten(child)).join("");
  }

  return isValidElement<{ readonly children?: ReactNode }>(node)
    ? flatten(node.props.children)
    : "";
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

  if (!isValidElement<ControlProps>(node)) {
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

  it("introduces every group the same way, in the same place", () => {
    expect(
      renderSections()
        .filter((section) => (section.props.description ?? "").length === 0)
        .map((section) => section.props.title),
    ).toEqual([]);
  });

  it("tells the two playback gates apart by the option each one sets", () => {
    const paths = renderControls().map((control) => control.props.optionPath);

    expect(
      paths.filter((path, index) => paths.indexOf(path) !== index),
    ).toEqual([]);
  });

  it("says how far a playback gate reaches once", () => {
    expect(
      renderReadouts().filter(
        (readout) => readout.props.label === "Playback gate reach",
      ),
    ).toHaveLength(1);
  });

  it("explains a control without pointing at where it sits", () => {
    expect(
      renderProse().filter((text) => /\b(above|below)\b/i.test(text)),
    ).toEqual([]);
  });

  it("keeps an option the other media path owns visible and switched off", () => {
    const shown = renderControls(mediabunnyConfiguration).map(
      (control) => control.props.optionPath,
    );

    expect(ENGINE_PATH_OPTIONS.filter((path) => !shown.includes(path))).toEqual(
      [],
    );
    expect(
      ENGINE_PATH_OPTIONS.filter(
        (path) => !disabledOptions(mediabunnyConfiguration).includes(path),
      ),
    ).toEqual([]);
    expect(disabledOptions(configuration)).toContain("normalize");
    expect(disabledOptions(mediabunnyConfiguration)).not.toContain("normalize");
  });

  it("says why a switched-off option cannot act, in the group it belongs to", () => {
    expect(renderProse(configuration)).toContain(NO_CONVERSION_ON_THE_ENGINE);
    expect(renderProse(uploadConfiguration)).toContain(NO_CHOICE_ON_AN_UPLOAD);
    expect(renderProse(uploadConfiguration)).toContain(
      NO_CONVERSION_ON_AN_UPLOAD,
    );
  });

  it("lets an upload see the media path it is on without offering to change it", () => {
    expect(disabledOptions(uploadConfiguration)).toContain("media");
    expect(disabledOptions(configuration)).not.toContain("media");
  });

  it("explains the video, not the machinery that draws it", () => {
    const machinery =
      /artifacts?\b|prepared run|gate that is on|presents its own frames|hands the renderer/i;
    /* `Prepared window` capitalised names a reading a viewer can go and find,
     * so only the lower-case phrase counts as jargon. */
    const jargonWindow = /prepared window/;

    expect(
      renderProse().filter(
        (text) => machinery.test(text) || jargonWindow.test(text),
      ),
    ).toEqual([]);
  });
});

function disabledOptions(panelConfiguration = configuration) {
  return renderControls(panelConfiguration)
    .filter((control) => control.props.disabled === true)
    .map((control) => control.props.optionPath);
}

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
