import {
  MediaInteractionMode,
  MediaRendererFit,
  MediaSessionMode,
  RenderPreparationMode,
  type MediaSessionDetectionOptions,
  type MediaSessionRendererOptions,
} from "supervision";
import { describe, expect, it } from "vitest";

import {
  DemoEngineSource,
  DemoMediaPath,
  describeMissingSupport,
  optionSupported,
  resolveDemoSessionConfiguration,
  type DemoOptionSupport,
  type DemoSessionOptions,
} from "../session/session-options";
import { PipelineNodeId, pipelineNodes } from "./pipeline-descriptor";
import { readPipelineNodeChoice } from "./pipeline-controls";

const baseDetections: MediaSessionDetectionOptions = {
  frames: [],
  sync: { frameRate: 24 },
};

const baseRenderer: MediaSessionRendererOptions = {
  autoPlay: false,
  fit: MediaRendererFit.Contain,
  interaction: { mode: MediaInteractionMode.PausedOnly },
  loop: true,
  renderPreparation: { mode: RenderPreparationMode.Worker },
};

const NORMALIZATION_BLOCKED = describeMissingSupport(
  "Switch the media path to Mediabunny to convert.",
);

function configuration(options?: {
  readonly mediaPath?: DemoMediaPath;
  readonly mediaPathSupport?: DemoOptionSupport;
  readonly normalizationSupport?: DemoOptionSupport;
}) {
  return resolveDemoSessionConfiguration({
    detections: baseDetections,
    engine: {},
    engineSource: DemoEngineSource.Url,
    mediaPath: options?.mediaPath ?? DemoMediaPath.Engine,
    mediaPathSupport: options?.mediaPathSupport ?? optionSupported,
    mode: MediaSessionMode.File,
    normalizationSupport: options?.normalizationSupport ?? optionSupported,
    playbackGate: true,
    renderer: baseRenderer,
  });
}

const CHOICES: readonly PipelineNodeId[] = [
  PipelineNodeId.ConditioningNone,
  PipelineNodeId.ConditioningProgressive,
  PipelineNodeId.ConditioningWholeFile,
  PipelineNodeId.DecoderMediabunny,
  PipelineNodeId.DecoderVideoEngine,
];

describe("readPipelineNodeChoice", () => {
  it("offers a choice on exactly the nodes a Session control owns", () => {
    const offered = pipelineNodes
      .filter(
        (node) => readPipelineNodeChoice(node.id, configuration(), {}) !== null,
      )
      .map((node) => node.id)
      .sort();

    expect(offered).toEqual([...CHOICES].sort());
  });

  it("reads the current branch off the session rather than the drawing", () => {
    const engine = configuration({ mediaPath: DemoMediaPath.Engine });

    expect(
      readPipelineNodeChoice(PipelineNodeId.DecoderVideoEngine, engine, {})
        ?.current,
    ).toBe(true);
    expect(
      readPipelineNodeChoice(PipelineNodeId.DecoderMediabunny, engine, {})
        ?.current,
    ).toBe(false);

    const mediabunny = configuration({ mediaPath: DemoMediaPath.Mediabunny });

    expect(
      readPipelineNodeChoice(PipelineNodeId.DecoderMediabunny, mediabunny, {})
        ?.current,
    ).toBe(true);
  });

  it("writes the option the Session panel's own control writes", () => {
    const engine = configuration();
    const options: DemoSessionOptions = { loop: true };

    expect(
      readPipelineNodeChoice(
        PipelineNodeId.DecoderMediabunny,
        engine,
        options,
      )?.select(options),
    ).toEqual({ loop: true, mediaPath: DemoMediaPath.Mediabunny });
  });

  it("reads the conditioning branch as the pair of normalize toggles", () => {
    const session = configuration({ mediaPath: DemoMediaPath.Mediabunny });
    const streaming: DemoSessionOptions = {
      normalize: true,
      normalizeStream: true,
    };
    const current = (id: PipelineNodeId, options: DemoSessionOptions) =>
      readPipelineNodeChoice(id, session, options)?.current;

    expect(current(PipelineNodeId.ConditioningNone, {})).toBe(true);
    expect(current(PipelineNodeId.ConditioningProgressive, streaming)).toBe(
      true,
    );
    expect(current(PipelineNodeId.ConditioningWholeFile, streaming)).toBe(
      false,
    );
    expect(
      current(PipelineNodeId.ConditioningWholeFile, { normalize: true }),
    ).toBe(true);
    expect(
      readPipelineNodeChoice(
        PipelineNodeId.ConditioningProgressive,
        session,
        {},
      )?.select({}),
    ).toEqual({ normalize: true, normalizeStream: true });
  });

  it("carries the reason a control cannot act instead of dropping the choice", () => {
    const blocked = configuration({
      normalizationSupport: NORMALIZATION_BLOCKED,
    });
    const choice = readPipelineNodeChoice(
      PipelineNodeId.ConditioningWholeFile,
      blocked,
      { normalize: true },
    );

    expect(choice?.blocked).toBe(NORMALIZATION_BLOCKED.reason);
    // Normalize cannot be on where nothing supports it, so the branch that
    // converts nothing is the one the session is running.
    expect(choice?.current).toBe(false);
    expect(
      readPipelineNodeChoice(PipelineNodeId.ConditioningNone, blocked, {
        normalize: true,
      })?.current,
    ).toBe(true);
  });
});
