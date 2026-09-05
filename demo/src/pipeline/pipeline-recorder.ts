import type { MediaRendererSource, MediaRendererState } from "supervision";
import {
  MediaSessionMediaBranch,
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
  pipelineNodesById,
  pipelineStages,
  type PipelineDescriptor,
  type PipelineEvidence,
  type PipelineFact,
  type PipelineNode,
  type PipelineStage,
} from "./pipeline-descriptor";
import type { DemoSessionConfiguration } from "../session/session-options";

/**
 * The slice of an opened media source the recorder can observe, named
 * structurally so a source that is not the web video engine fails to match.
 * Reading it costs nothing recurring: `getMetadata` returns the snapshot the
 * engine already resolved when it loaded, and nothing here starts the engine's
 * broadcast.
 */
interface ObservableEngineHandle {
  getMetadata(): EngineReadySnapshot | null;
  getPlayhead(): unknown;
  subscribe(signal: string, listener: () => void): () => void;
}

interface TakenRecord {
  readonly kind: "taken";
  readonly site: string;
  readonly seq: number;
  readonly atMs: number;
  readonly facts: readonly PipelineFact[];
}

interface BypassedRecord {
  readonly kind: "bypassed";
  readonly reason: string;
}

type PipelineRecord = TakenRecord | BypassedRecord;

export interface PipelineSessionObservations {
  /** The resolved settings the open session reported back to the workbench. */
  readonly configuration?: DemoSessionConfiguration | null;
  /** What the session recorded doing with the media it was handed. */
  readonly media: MediaSessionMediaState | null;
  /** The renderer's own state, read once the session has finished opening. */
  readonly rendererState: MediaRendererState | null;
}

export interface PipelineRecorder {
  /** Stamps a node as having run. */
  record(
    id: PipelineNodeId,
    site: string,
    facts?: readonly PipelineFact[],
  ): void;
  /** Stamps why a node did not run, in words a person would say. */
  bypass(id: PipelineNodeId, reason: string): void;
  /**
   * Wraps a media source so the recorder sees what `open()` hands back. The
   * wrapper reads and returns; it subscribes to nothing and starts nothing.
   */
  tap(source: MediaRendererSource): MediaRendererSource;
  /**
   * Folds in the records only the finished session can supply and returns the
   * diagram. Everything is stamped by now, so the result never changes again.
   */
  seal(observations: PipelineSessionObservations): PipelineDescriptor;
  /** Drops every stamp that arrives after the session was torn down. */
  close(): void;
}

const SITE_TAP = "demo/pipeline/pipeline-recorder.ts › tap";
const SITE_SESSION_MEDIA =
  "packages/web/src/sessions/media-session-media.ts › prepareSessionMedia";
const SITE_RENDERER_STATE =
  "packages/web/src/renderers/media-renderer-core.ts › createMediaRendererRuntimeState";
const SITE_SESSION_CONFIGURATION =
  "demo/session/session-options.ts › resolveDemoSessionConfiguration";

export function createPipelineRecorder(options: {
  readonly epoch: number;
  readonly now?: () => number;
}): PipelineRecorder {
  const now = options.now ?? (() => performance.now());
  const openedAtMs = now();
  const records = new Map<PipelineNodeId, PipelineRecord>();
  let seq = 0;
  let closed = false;

  const record: PipelineRecorder["record"] = (id, site, facts = []) => {
    if (closed) {
      return;
    }

    const existing = records.get(id);

    // Two places can witness the same step. The first stamp is when it
    // happened, so the order the diagram draws stays the order things ran, and
    // the later witness is added to the node as one more reading.
    if (existing?.kind === "taken") {
      records.set(id, {
        ...existing,
        facts: [
          ...existing.facts,
          ...(existing.site === site
            ? []
            : [{ label: "also recorded by", value: site }]),
          ...facts,
        ],
      });
      return;
    }

    seq += 1;
    records.set(id, {
      atMs: Math.round(now() - openedAtMs),
      facts,
      kind: "taken",
      seq,
      site,
    });
  };

  const bypass: PipelineRecorder["bypass"] = (id, reason) => {
    if (closed) {
      return;
    }

    records.set(id, { kind: "bypassed", reason });
  };

  const observeOpenedSource = (opened: unknown) => {
    const engine = readEngineHandle(opened);

    if (!engine) {
      return;
    }

    record(PipelineNodeId.DecoderVideoEngine, SITE_TAP, [
      { label: "seen as", value: "an engine handle on the opened source" },
    ]);
    record(PipelineNodeId.PresentationFrames, SITE_TAP, [
      {
        label: "seen as",
        value: "the engine's own frame channel on the opened source",
      },
    ]);

    const snapshot = engine.getMetadata();

    if (!snapshot) {
      return;
    }

    record(PipelineNodeId.EngineFrameTimeline, SITE_TAP, [
      { label: "frames", value: String(snapshot.timeline.ticks.length) },
      { label: "ticks per second", value: String(snapshot.timeline.tickRate) },
      {
        label: "first frame at",
        value: `${snapshot.firstTimestampMs} ms`,
      },
    ]);
    recordByteSource(snapshot);
  };

  const recordByteSource = (snapshot: EngineReadySnapshot) => {
    const facts: readonly PipelineFact[] = [
      {
        label: "picture",
        value: `${snapshot.naturalWidth} by ${snapshot.naturalHeight}`,
      },
      {
        label: "frame rate",
        value:
          snapshot.nativeFps === null ? "not stated" : `${snapshot.nativeFps}`,
      },
    ];

    const opened =
      snapshot.byteSource === undefined
        ? undefined
        : engineByteNodes[snapshot.byteSource];

    if (opened === undefined) {
      return;
    }

    // The one-way stream is left out of the sweep: it says something a reader
    // needs more than "something else opened", which is that nothing on this
    // build can hand the engine a stream at all.
    recordOneOf(
      [PipelineNodeId.BytesUrlSource, PipelineNodeId.BytesBlobSource],
      opened,
      SITE_TAP,
      "The engine reported opening the clip through the other reader, and it opens exactly one.",
      facts,
    );
  };

  const recordSessionMedia = (media: MediaSessionMediaState | null) => {
    const preparation = media?.preparation;

    if (!preparation) {
      return;
    }

    const branchNode = sessionMediaNodes[preparation.branch];

    recordOneOf(
      Object.values(sessionMediaNodes),
      branchNode,
      SITE_SESSION_MEDIA,
      "The session recorded taking a different branch, and it takes exactly one.",
    );
    recordOneOf(
      [PipelineNodeId.OpenViaSrc, PipelineNodeId.OpenViaSource],
      preparation.opened === "src"
        ? PipelineNodeId.OpenViaSrc
        : PipelineNodeId.OpenViaSource,
      SITE_SESSION_MEDIA,
      "The session filled in the other one, and it fills in exactly one.",
    );
  };

  /**
   * Stamps the one branch of a fork that ran and says of each of the others
   * that it did not. Only for forks whose record is a single value, where the
   * one that ran is itself the record that the rest did not.
   */
  const recordOneOf = (
    siblings: readonly PipelineNodeId[],
    taken: PipelineNodeId,
    site: string,
    reason: string,
    facts?: readonly PipelineFact[],
  ) => {
    record(taken, site, facts);

    for (const sibling of siblings) {
      if (sibling !== taken) {
        bypass(sibling, reason);
      }
    }
  };

  const recordRendererState = (state: MediaRendererState | null) => {
    if (!state) {
      return;
    }

    recordCompositor(state.rendererBackend);
  };

  const recordCompositor = (backend: string | null) => {
    if (backend === "webgpu") {
      record(PipelineNodeId.CompositorPixiWebgpu, SITE_RENDERER_STATE, [
        { label: "reported as", value: backend },
      ]);
      bypass(
        PipelineNodeId.CompositorPixiWebgl,
        "WebGPU was available, so the page is painting through it.",
      );
      return;
    }

    if (backend === "webgl") {
      record(PipelineNodeId.CompositorPixiWebgl, SITE_RENDERER_STATE, [
        { label: "reported as", value: backend },
      ]);
      bypass(
        PipelineNodeId.CompositorPixiWebgpu,
        "This browser did not offer WebGPU, so the page fell back to WebGL.",
      );
    }
  };

  const recordPlayback = (
    configuration: DemoSessionConfiguration | null | undefined,
  ) => {
    if (!configuration) {
      return;
    }

    const detectionGate = configuration.resolved.detectionBuffer.playbackGate;
    const preparationGate =
      configuration.resolved.renderPreparation.playbackGate;
    const detectionEnabled = detectionGate?.enabled === true;
    const preparationEnabled = preparationGate?.enabled === true;

    if (!detectionEnabled && !preparationEnabled) {
      record(PipelineNodeId.PlaybackNothingHeld, SITE_SESSION_CONFIGURATION);
      bypass(
        PipelineNodeId.PlaybackDetectionGate,
        "The resolved detection wait is off.",
      );
      bypass(
        PipelineNodeId.PlaybackPreparationGate,
        "The resolved mask wait is off.",
      );
      return;
    }

    bypass(
      PipelineNodeId.PlaybackNothingHeld,
      "At least one resolved playback wait is on.",
    );

    if (detectionEnabled) {
      record(PipelineNodeId.PlaybackDetectionGate, SITE_SESSION_CONFIGURATION, [
        {
          label: "required lead",
          value: formatGateLead(detectionGate?.requiredAheadSeconds),
        },
        {
          label: "maximum wait",
          value: formatGateWait(detectionGate?.maxWaitSeconds),
        },
      ]);
    } else {
      bypass(
        PipelineNodeId.PlaybackDetectionGate,
        "The resolved detection wait is off.",
      );
    }

    if (preparationEnabled) {
      record(
        PipelineNodeId.PlaybackPreparationGate,
        SITE_SESSION_CONFIGURATION,
        [
          {
            label: "required lead ceiling",
            value: formatGateLead(preparationGate?.requiredAheadSeconds),
          },
          {
            label: "maximum wait",
            value: formatGateWait(preparationGate?.maxWaitSeconds),
          },
          {
            label: "stop / resume margin",
            value: `${formatGateSeconds(
              preparationGate?.stopBelowWallSeconds,
            )} / ${formatGateSeconds(
              preparationGate?.resumeMarginWallSeconds,
            )}`,
          },
        ],
      );
    } else {
      bypass(
        PipelineNodeId.PlaybackPreparationGate,
        "The resolved mask wait is off.",
      );
    }
  };

  return {
    bypass,
    close() {
      closed = true;
    },
    record,
    seal(observations) {
      recordSessionMedia(observations.media);
      recordRendererState(observations.rendererState);
      recordPlayback(observations.configuration);

      return buildPipelineDescriptor({
        epoch: options.epoch,
        openedAtMs,
        records,
      });
    },
    tap(source) {
      return {
        async open() {
          const opened = await source.open();

          observeOpenedSource(opened);

          return opened;
        },
      };
    },
  };
}

const engineByteNodes: Record<SourceKind, PipelineNodeId> = {
  [SourceKind.Blob]: PipelineNodeId.BytesBlobSource,
  [SourceKind.Stream]: PipelineNodeId.BytesEngineStream,
  [SourceKind.Url]: PipelineNodeId.BytesUrlSource,
};

const sessionMediaNodes: Record<MediaSessionMediaBranch, PipelineNodeId> = {
  [MediaSessionMediaBranch.BlobObjectUrl]:
    PipelineNodeId.SessionMediaBlobObjectUrl,
  [MediaSessionMediaBranch.NormalizedObjectUrl]:
    PipelineNodeId.SessionMediaNormalizedObjectUrl,
  [MediaSessionMediaBranch.ProgressiveSource]:
    PipelineNodeId.SessionMediaProgressiveSource,
  [MediaSessionMediaBranch.RendererSource]:
    PipelineNodeId.SessionMediaRendererSource,
  [MediaSessionMediaBranch.Url]: PipelineNodeId.SessionMediaUrl,
};

function formatGateLead(value: number | undefined) {
  return value === undefined ? "current frame" : formatGateSeconds(value);
}

function formatGateWait(value: number | undefined) {
  return value === Number.POSITIVE_INFINITY
    ? "unbounded"
    : formatGateSeconds(value);
}

function formatGateSeconds(value: number | undefined) {
  return value === undefined ? "not reported" : `${value} s`;
}

/**
 * Turns the stamps into the drawn diagram. Pure, and it never throws: a
 * recorder bug must show up in the picture rather than take the session down
 * with it.
 */
export function buildPipelineDescriptor(input: {
  readonly epoch: number;
  readonly openedAtMs: number;
  readonly records: ReadonlyMap<PipelineNodeId, PipelineRecord>;
}): PipelineDescriptor {
  const takenOrder = [...input.records.entries()]
    .filter(
      (entry): entry is [PipelineNodeId, TakenRecord] =>
        entry[1].kind === "taken",
    )
    .sort(([, left], [, right]) => left.seq - right.seq)
    .map(([id]) => id);
  const conflictingStages = pipelineStages
    .filter(
      (stage) => stage.arity === "fork" && countTaken(stage.id, takenOrder) > 1,
    )
    .map((stage) => stage.id);
  const conflicting = new Set(conflictingStages);
  const stages: PipelineStage[] = pipelineStages.map((stage) => ({
    id: stage.id,
    nodes: pipelineNodes
      .filter((node) => node.stage === stage.id)
      .map((node) =>
        conflicting.has(stage.id)
          ? drawConflict(node.id, node.label)
          : drawNode(node.id, input.records, takenOrder),
      ),
    question: stage.question,
    title: stage.title,
  }));

  return {
    conflictingStages,
    epoch: input.epoch,
    incompleteStages: stages
      .filter(
        (stage) =>
          !stage.nodes.some((node) => node.status === PipelineNodeStatus.Taken),
      )
      .map((stage) => stage.id),
    openedAtMs: input.openedAtMs,
    stages,
  };
}

function countTaken(
  stage: PipelineStageId,
  takenOrder: readonly PipelineNodeId[],
) {
  return takenOrder.filter((id) => pipelineNodesById.get(id)?.stage === stage)
    .length;
}

function drawConflict(id: PipelineNodeId, label: string): PipelineNode {
  return {
    id,
    label,
    reason:
      "Two branches of this step both reported running. That is a fault in the recording, so nothing here is drawn as the winner.",
    status: PipelineNodeStatus.Unknown,
    wouldBeReportedBy: "the recording, once only one branch stamps this step",
  };
}

function drawNode(
  id: PipelineNodeId,
  records: ReadonlyMap<PipelineNodeId, PipelineRecord>,
  takenOrder: readonly PipelineNodeId[],
): PipelineNode {
  const definition = pipelineNodesById.get(id)!;
  const record = records.get(id);

  if (record?.kind === "taken") {
    const position = takenOrder.indexOf(id);

    return {
      evidence: {
        atMs: record.atMs,
        seq: record.seq,
        site: record.site,
      } satisfies PipelineEvidence,
      facts: record.facts,
      fedBy: position > 0 ? takenOrder[position - 1] : null,
      id,
      label: definition.label,
      status: PipelineNodeStatus.Taken,
    };
  }

  if (record?.kind === "bypassed") {
    return {
      id,
      label: definition.label,
      reason: record.reason,
      status: PipelineNodeStatus.Bypassed,
    };
  }

  if (definition.fallback.kind === "unavailable") {
    return {
      id,
      label: definition.label,
      reason: definition.fallback.reason,
      status: PipelineNodeStatus.Unavailable,
    };
  }

  return {
    id,
    label: definition.label,
    reason: definition.fallback.reason,
    status: PipelineNodeStatus.Unknown,
    wouldBeReportedBy: definition.fallback.wouldBeReportedBy,
  };
}

function readEngineHandle(opened: unknown): ObservableEngineHandle | null {
  if (typeof opened !== "object" || opened === null) {
    return null;
  }

  const { engine } = opened as { readonly engine?: unknown };

  if (typeof engine !== "object" || engine === null) {
    return null;
  }

  const candidate = engine as Partial<ObservableEngineHandle>;

  return typeof candidate.getMetadata === "function" &&
    typeof candidate.getPlayhead === "function" &&
    typeof candidate.subscribe === "function"
    ? (engine as ObservableEngineHandle)
    : null;
}
