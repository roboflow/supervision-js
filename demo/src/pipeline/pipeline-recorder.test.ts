import { describe, expect, it } from "vitest";
import {
  DetectionBufferStatus,
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSessionMediaBranch,
  MediaSessionMode,
  MediaSourceStatus,
  type MediaRendererSource,
  type MediaRendererState,
  type MediaSessionMediaState,
} from "supervision";
import {
  SourceKind,
  type EngineReadySnapshot,
} from "supervision/web-video-engine";

import {
  PipelineNodeId,
  PipelineNodeStatus,
  PipelineStageId,
  pipelineNodes,
  pipelineStages,
  type PipelineDescriptor,
  type PipelineNode,
} from "./pipeline-descriptor";
import { createPipelineRecorder } from "./pipeline-recorder";
import { formatPipelineTrace } from "./pipeline-trace";
import {
  DemoEngineSource,
  DemoMediaPath,
  optionSupported,
  resolveDemoSessionConfiguration,
} from "../session/session-options";

/** Everything the engine would refuse to answer without its broadcast running. */
interface BroadcastSpy {
  starts: number;
  subscriptions: number;
}

describe("pipeline recorder", () => {
  it("reports a step as unknown rather than guessing it when nothing recorded it", () => {
    const descriptor = createPipelineRecorder({ epoch: 1, now: clock() }).seal({
      media: null,
      rendererState: null,
    });

    expect(takenIds(descriptor)).toEqual([]);
    for (const node of allNodes(descriptor)) {
      expect(node.status).not.toBe(PipelineNodeStatus.Taken);
      expect(node.status).not.toBe(PipelineNodeStatus.Bypassed);
    }
  });

  it("names what would have to report each unknown step", () => {
    const descriptor = createPipelineRecorder({ epoch: 1, now: clock() }).seal({
      media: null,
      rendererState: null,
    });

    for (const node of allNodes(descriptor)) {
      if (node.status === PipelineNodeStatus.Unknown) {
        expect(node.reason.length).toBeGreaterThan(0);
        expect(node.wouldBeReportedBy.length).toBeGreaterThan(0);
      }
    }
  });

  it("leaves which reader opened the clip unknown when the session recorded no branch", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });
    const descriptor = recorder.seal({
      media: { inputMetadata: null, normalizedMedia: null, objectUrl: null },
      rendererState: null,
    });

    expect(statusOf(descriptor, PipelineNodeId.SessionMediaUrl)).toBe(
      PipelineNodeStatus.Unknown,
    );
    expect(statusOf(descriptor, PipelineNodeId.OpenViaSrc)).toBe(
      PipelineNodeStatus.Unknown,
    );
    expect(descriptor.incompleteStages).toContain(PipelineStageId.SessionMedia);
    expect(descriptor.incompleteStages).toContain(PipelineStageId.Open);
  });

  it("keeps Mediabunny unknown on a path that certainly used it", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });
    const descriptor = recorder.seal({
      media: mediaState(MediaSessionMediaBranch.Url, "src"),
      rendererState: null,
    });

    expect(statusOf(descriptor, PipelineNodeId.OpenViaSrc)).toBe(
      PipelineNodeStatus.Taken,
    );
    expect(statusOf(descriptor, PipelineNodeId.DecoderMediabunny)).toBe(
      PipelineNodeStatus.Unknown,
    );
  });

  it("resolves every structural step with the engine's broadcast off", async () => {
    const spy: BroadcastSpy = { starts: 0, subscriptions: 0 };
    const recorder = createPipelineRecorder({ epoch: 4, now: clock() });
    const tapped = recorder.tap(
      engineSource(readySnapshot(SourceKind.Url), spy),
    );

    await tapped.open();

    const descriptor = recorder.seal({
      configuration: sessionConfiguration(),
      media: mediaState(MediaSessionMediaBranch.RendererSource, "source"),
      rendererState: rendererState(),
    });

    expect(spy).toEqual({ starts: 0, subscriptions: 0 });
    for (const stage of [
      PipelineStageId.SessionMedia,
      PipelineStageId.Open,
      PipelineStageId.Decoder,
      PipelineStageId.Bytes,
      PipelineStageId.Presentation,
      PipelineStageId.Compositor,
      PipelineStageId.Playback,
    ]) {
      expect(descriptor.incompleteStages).not.toContain(stage);
    }
    expect(statusOf(descriptor, PipelineNodeId.EngineFrameTimeline)).toBe(
      PipelineNodeStatus.Taken,
    );
    expect(statusOf(descriptor, PipelineNodeId.BytesUrlSource)).toBe(
      PipelineNodeStatus.Taken,
    );
  });

  it("leaves the engine's live readings unknown while its broadcast is off", async () => {
    const recorder = createPipelineRecorder({ epoch: 4, now: clock() });

    await recorder
      .tap(engineSource(readySnapshot(SourceKind.Url), spy()))
      .open();

    const descriptor = recorder.seal({
      media: mediaState(MediaSessionMediaBranch.RendererSource, "source"),
      rendererState: rendererState(),
    });

    for (const id of [
      PipelineNodeId.EngineResidency,
      PipelineNodeId.EngineKeyframeIndex,
      PipelineNodeId.EngineFrameCacheExact,
      PipelineNodeId.EngineFrameCachePreview,
      PipelineNodeId.EngineDecodeScheduler,
    ]) {
      expect(statusOf(descriptor, id)).toBe(PipelineNodeStatus.Unknown);
    }
  });

  it("reads a file-backed engine as a file rather than a download", async () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });

    await recorder
      .tap(engineSource(readySnapshot(SourceKind.Blob), spy()))
      .open();

    const descriptor = recorder.seal({
      media: mediaState(MediaSessionMediaBranch.RendererSource, "source"),
      rendererState: rendererState(),
    });

    expect(statusOf(descriptor, PipelineNodeId.BytesBlobSource)).toBe(
      PipelineNodeStatus.Taken,
    );
    expect(statusOf(descriptor, PipelineNodeId.BytesUrlSource)).toBe(
      PipelineNodeStatus.Bypassed,
    );
  });

  it("leaves the byte reader unknown when the engine reports no kind", async () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });
    const snapshot = {
      ...readySnapshot(SourceKind.Url),
      byteSource: undefined,
    };

    await recorder.tap(engineSource(snapshot, spy())).open();

    const descriptor = recorder.seal({
      media: mediaState(MediaSessionMediaBranch.RendererSource, "source"),
      rendererState: rendererState(),
    });

    expect(descriptor.incompleteStages).toContain(PipelineStageId.Bytes);
    expect(statusOf(descriptor, PipelineNodeId.DecoderVideoEngine)).toBe(
      PipelineNodeStatus.Taken,
    );
  });

  it("draws a step whose branches both reported running as unknown", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });

    recorder.record(PipelineNodeId.OpenViaSrc, "test");
    recorder.record(PipelineNodeId.OpenViaSource, "test");

    const descriptor = recorder.seal({ media: null, rendererState: null });

    expect(descriptor.conflictingStages).toEqual([PipelineStageId.Open]);
    expect(statusOf(descriptor, PipelineNodeId.OpenViaSrc)).toBe(
      PipelineNodeStatus.Unknown,
    );
    expect(statusOf(descriptor, PipelineNodeId.OpenViaSource)).toBe(
      PipelineNodeStatus.Unknown,
    );
  });

  it("drops stamps that arrive after the session was torn down", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });

    recorder.close();
    recorder.record(PipelineNodeId.OpenViaSrc, "test");

    expect(
      statusOf(
        recorder.seal({ media: null, rendererState: null }),
        PipelineNodeId.OpenViaSrc,
      ),
    ).toBe(PipelineNodeStatus.Unknown);
  });

  it("draws the path in the order the stamps arrived", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });

    recorder.record(PipelineNodeId.IntakeFixtureUrl, "test");
    recorder.record(PipelineNodeId.ConditioningNone, "test");

    const descriptor = recorder.seal({
      media: mediaState(MediaSessionMediaBranch.Url, "src"),
      rendererState: null,
    });

    expect(takenIds(descriptor)).toEqual([
      PipelineNodeId.IntakeFixtureUrl,
      PipelineNodeId.ConditioningNone,
      PipelineNodeId.SessionMediaUrl,
      PipelineNodeId.OpenViaSrc,
    ]);
    expect(fedBy(descriptor, PipelineNodeId.IntakeFixtureUrl)).toBeNull();
    expect(fedBy(descriptor, PipelineNodeId.OpenViaSrc)).toBe(
      PipelineNodeId.SessionMediaUrl,
    );
  });

  it("records detection and mask waits as concurrent session policies", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });
    const descriptor = recorder.seal({
      configuration: sessionConfiguration(),
      media: null,
      rendererState: rendererState(),
    });

    expect(statusOf(descriptor, PipelineNodeId.PlaybackDetectionGate)).toBe(
      PipelineNodeStatus.Taken,
    );
    expect(statusOf(descriptor, PipelineNodeId.PlaybackPreparationGate)).toBe(
      PipelineNodeStatus.Taken,
    );
    expect(statusOf(descriptor, PipelineNodeId.PlaybackNothingHeld)).toBe(
      PipelineNodeStatus.Bypassed,
    );
    expect(descriptor.conflictingStages).not.toContain(
      PipelineStageId.Playback,
    );
  });

  it("records when both waits are disabled", () => {
    const recorder = createPipelineRecorder({ epoch: 1, now: clock() });
    const descriptor = recorder.seal({
      configuration: sessionConfiguration({
        detectionGateEnabled: false,
        preparationGateEnabled: false,
      }),
      media: null,
      rendererState: rendererState(),
    });

    expect(statusOf(descriptor, PipelineNodeId.PlaybackNothingHeld)).toBe(
      PipelineNodeStatus.Taken,
    );
    expect(statusOf(descriptor, PipelineNodeId.PlaybackDetectionGate)).toBe(
      PipelineNodeStatus.Bypassed,
    );
    expect(statusOf(descriptor, PipelineNodeId.PlaybackPreparationGate)).toBe(
      PipelineNodeStatus.Bypassed,
    );
  });

  it("gives every branch of the session's media fork a node of its own", () => {
    const nodes = Object.values(MediaSessionMediaBranch).map((branch) => {
      const recorder = createPipelineRecorder({ epoch: 1, now: clock() });
      const descriptor = recorder.seal({
        media: mediaState(branch, "src"),
        rendererState: null,
      });

      return takenIds(descriptor).filter(
        (id) => stageOf(descriptor, id) === PipelineStageId.SessionMedia,
      );
    });

    expect(nodes.flat()).toHaveLength(
      Object.values(MediaSessionMediaBranch).length,
    );
    expect(new Set(nodes.flat()).size).toBe(nodes.length);
  });
});

describe("pipeline vocabulary", () => {
  it("puts every node in a declared step, and leaves no step empty", () => {
    const stageIds = new Set(pipelineStages.map((stage) => stage.id));

    for (const node of pipelineNodes) {
      expect(stageIds.has(node.stage)).toBe(true);
    }

    for (const stage of pipelineStages) {
      expect(
        pipelineNodes.filter((node) => node.stage === stage.id).length,
      ).toBeGreaterThan(0);
    }
  });

  it("asks a question of every step, in words rather than symbol names", () => {
    for (const stage of pipelineStages) {
      expect(stage.question.endsWith("?")).toBe(true);
      expect(plainWords(stage.question)).not.toMatch(SYMBOL_NAME);
    }
  });

  it("keeps identifiers and code words out of everything a person reads", () => {
    for (const node of pipelineNodes) {
      for (const sentence of [
        node.label,
        node.fallback.reason,
        node.fallback.kind === "unknown" ? node.fallback.wouldBeReportedBy : "",
      ]) {
        expect(plainWords(sentence)).not.toMatch(SYMBOL_NAME);
        expect(sentence.toLowerCase()).not.toMatch(/\bgates?\b/);
      }
    }
  });

  it("says only that nothing recorded a step, never that it did not run", () => {
    for (const node of pipelineNodes) {
      if (node.fallback.kind === "unknown") {
        expect(node.fallback.reason.toLowerCase()).not.toMatch(
          /\b(did not|never|no) (run|engine|reader)\b/,
        );
      }
    }
  });
});

describe("pipeline trace", () => {
  it("carries the unknowns and what would report them into the pasted text", () => {
    const recorder = createPipelineRecorder({ epoch: 7, now: clock() });
    const trace = formatPipelineTrace(
      recorder.seal({ media: null, rendererState: null }),
    );

    expect(trace).toContain("session 7");
    expect(trace).toContain("would be reported by");
    expect(trace).toContain("nothing reports it");
  });
});

/** A backtick, an underscore, or a run of letters humped in the middle. */
const SYMBOL_NAME = /[`_]|[a-z][A-Z]/;

/** Product names are not code identifiers, however they are spelled. */
function plainWords(sentence: string) {
  return sentence.replaceAll(/WebGPU|WebGL|SAM3|Mediabunny|Pixi/g, "x");
}

function clock() {
  let value = 0;

  return () => {
    value += 1;
    return value;
  };
}

function spy(): BroadcastSpy {
  return { starts: 0, subscriptions: 0 };
}

function allNodes(descriptor: PipelineDescriptor): readonly PipelineNode[] {
  return descriptor.stages.flatMap((stage) => stage.nodes);
}

function findNode(descriptor: PipelineDescriptor, id: PipelineNodeId) {
  return allNodes(descriptor).find((node) => node.id === id)!;
}

function statusOf(descriptor: PipelineDescriptor, id: PipelineNodeId) {
  return findNode(descriptor, id).status;
}

function stageOf(descriptor: PipelineDescriptor, id: PipelineNodeId) {
  return descriptor.stages.find((stage) =>
    stage.nodes.some((node) => node.id === id),
  )!.id;
}

function fedBy(descriptor: PipelineDescriptor, id: PipelineNodeId) {
  const node = findNode(descriptor, id);

  return node.status === PipelineNodeStatus.Taken ? node.fedBy : undefined;
}

function takenIds(descriptor: PipelineDescriptor) {
  return allNodes(descriptor)
    .filter((node) => node.status === PipelineNodeStatus.Taken)
    .map((node) => node.id);
}

function mediaState(
  branch: MediaSessionMediaBranch,
  opened: "src" | "source",
): MediaSessionMediaState {
  return {
    inputMetadata: null,
    normalizedMedia: null,
    objectUrl: null,
    preparation: { branch, opened },
  };
}

function readySnapshot(byteSource: SourceKind): EngineReadySnapshot {
  return {
    byteSource,
    canDecode: true,
    codec: "avc1",
    durationMs: 9000,
    firstTimestampMs: 0,
    nativeFps: null,
    naturalHeight: 720,
    naturalWidth: 1280,
    timeline: {
      lastDurationTicks: 1,
      tickRate: 30,
      ticks: new Float64Array([0, 1, 2]),
    },
  };
}

/**
 * A source shaped like the web video engine's, whose broadcast controls count
 * their own calls. The recorder must resolve everything structural without touching
 * one of them.
 */
function engineSource(
  snapshot: EngineReadySnapshot,
  broadcast: BroadcastSpy,
): MediaRendererSource {
  const engine = {
    getMetadata: () => snapshot,
    getPlayhead: () => ({ mediaTimeMs: 0 }),
    startDiagnostics() {
      broadcast.starts += 1;
    },
    subscribe: () => () => {},
    subscribeDiagnostics() {
      broadcast.subscriptions += 1;
      return () => {};
    },
  };

  return {
    async open() {
      return { engine } as unknown as Awaited<
        ReturnType<MediaRendererSource["open"]>
      >;
    },
  };
}

function rendererState(): MediaRendererState {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    currentTime: 0,
    detectionBuffer: {
      bufferEndTime: null,
      bufferStartTime: null,
      detectionCount: 0,
      errorMessage: null,
      frameCount: 0,
      requestedEndTime: null,
      requestedStartTime: null,
      status: DetectionBufferStatus.Idle,
    },
    duration: 9,
    fit: MediaRendererFit.Contain,
    lastFrameRenderTimings: null,
    mediaHeight: 720,
    mediaWidth: 1280,
    playbackRate: 1,
    playbackState: MediaRendererPlaybackState.Paused,
    presentedFrames: 0,
    rendererBackend: "webgpu",
    source: {
      audioTrackCount: 0,
      canRead: true,
      duration: 9,
      errorKind: null,
      errorMessage: null,
      estimatedFrameCount: 270,
      estimatedFrameRate: 30,
      firstTimestamp: 0,
      formatMimeType: "video/mp4",
      formatName: "video-engine",
      mimeType: null,
      primaryVideoHeight: 720,
      primaryVideoWidth: 1280,
      status: MediaSourceStatus.Ready,
      trackCount: 1,
      videoTrackCount: 1,
    },
  };
}

function sessionConfiguration(
  options: {
    readonly detectionGateEnabled?: boolean;
    readonly preparationGateEnabled?: boolean;
  } = {},
) {
  return resolveDemoSessionConfiguration({
    detections: {
      frames: [],
      playbackGate: {
        enabled: options.detectionGateEnabled ?? true,
      },
    },
    engine: {},
    engineSource: DemoEngineSource.Url,
    mediaPath: DemoMediaPath.Engine,
    mediaPathSupport: optionSupported,
    mode: MediaSessionMode.File,
    normalizationSupport: optionSupported,
    playbackGate: undefined,
    renderer: {
      renderPreparation: {
        playbackGate: {
          enabled: options.preparationGateEnabled ?? true,
        },
      },
    },
  });
}
