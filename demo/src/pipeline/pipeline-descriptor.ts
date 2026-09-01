/**
 * The shape the pipeline diagram draws, and the vocabulary it draws from.
 *
 * Every branch the media and the detections can take through this workbench is
 * one node here. A node is drawn as taken only because something recorded that
 * it ran; a node nothing reports is drawn as unknown and says what would have
 * to report it. Nothing in this file reads a session option.
 */

/** Columns, in the order the pipeline runs them. */
export enum PipelineStageId {
  Intake = "intake",
  Conditioning = "conditioning",
  SessionMedia = "sessionMedia",
  Open = "open",
  Decoder = "decoder",
  Bytes = "bytes",
  EngineServices = "engineServices",
  Presentation = "presentation",
  Compositor = "compositor",
  Detections = "detections",
  Playback = "playback",
}

export enum PipelineNodeId {
  IntakeFixtureUrl = "intake.fixtureUrl",
  IntakeFixtureProxy = "intake.fixtureProxy",
  IntakeUploadFile = "intake.uploadFile",
  IntakeUploadImageRecode = "intake.uploadImageRecode",
  IntakeConversionRefetch = "intake.conversionRefetch",

  ConditioningNone = "conditioning.none",
  ConditioningWholeFile = "conditioning.wholeFile",
  ConditioningProgressive = "conditioning.progressive",
  ConditioningFrameGrid = "conditioning.frameGrid",

  SessionMediaUrl = "sessionMedia.url",
  SessionMediaRendererSource = "sessionMedia.rendererSource",
  SessionMediaBlobObjectUrl = "sessionMedia.blobObjectUrl",
  SessionMediaNormalizedObjectUrl = "sessionMedia.normalizedObjectUrl",
  SessionMediaProgressiveSource = "sessionMedia.progressiveSource",

  OpenViaSrc = "open.viaSrc",
  OpenViaSource = "open.viaSource",

  DecoderVideoEngine = "decoder.videoEngine",
  DecoderMediabunny = "decoder.mediabunny",
  DecoderStaticImage = "decoder.staticImage",
  DecoderCameraStream = "decoder.cameraStream",

  BytesUrlSource = "bytes.urlSource",
  BytesBlobSource = "bytes.blobSource",
  BytesEngineStream = "bytes.engineStream",
  BytesConversionStream = "bytes.conversionStream",

  EngineFrameTimeline = "engine.frameTimeline",
  EngineResidency = "engine.residency",
  EngineKeyframeIndex = "engine.keyframeIndex",
  EngineFrameCacheExact = "engine.frameCacheExact",
  EngineFrameCachePreview = "engine.frameCachePreview",
  EngineDecodeScheduler = "engine.decodeScheduler",

  PresentationFrames = "presentation.frames",
  PresentationCanvas = "presentation.canvas",
  PresentationPull = "presentation.pull",

  CompositorPixiWebgpu = "compositor.pixiWebgpu",
  CompositorPixiWebgl = "compositor.pixiWebgl",

  DetectionsNearestFrameIndex = "detections.nearestFrameIndex",
  DetectionsInterval = "detections.interval",

  PlaybackNothingHeld = "playback.nothingHeld",
  PlaybackDetectionGate = "playback.detectionGate",
  PlaybackPreparationGate = "playback.preparationGate",
}

export enum PipelineNodeStatus {
  /** A record says this ran. Never inferred. */
  Taken = "taken",
  /** A record says something else in this column ran instead. */
  Bypassed = "bypassed",
  /** Nothing on this build can reach it, whatever the options say. */
  Unavailable = "unavailable",
  /**
   * Nothing in the runtime reports whether this ran. The diagram says so rather
   * than filling the gap.
   */
  Unknown = "unknown",
}

/** Where a record was stamped. A taken node cannot exist without one. */
export interface PipelineEvidence {
  /**
   * The file and function that stamped it. Deliberately not a line number: a
   * line moves under every edit and a stale one is worse than none.
   */
  readonly site: string;
  /** Arrival order, so the drawn path is the order things really happened. */
  readonly seq: number;
  /** Milliseconds since the session began opening. */
  readonly atMs: number;
}

/** One reading on a node. */
export interface PipelineFact {
  readonly label: string;
  readonly value: string;
}

interface PipelineNodeBase {
  readonly id: PipelineNodeId;
  readonly label: string;
}

export type PipelineNode = PipelineNodeBase &
  (
    | {
        readonly status: PipelineNodeStatus.Taken;
        readonly evidence: PipelineEvidence;
        /**
         * The taken node that ran immediately before this one, by arrival
         * order. Null for the first. Read off the stamps, so the drawn spine is
         * the real sequence rather than the column layout.
         */
        readonly fedBy: PipelineNodeId | null;
        readonly facts: readonly PipelineFact[];
      }
    | {
        readonly status: PipelineNodeStatus.Bypassed;
        /** Plain language: what ran instead, and why. */
        readonly reason: string;
      }
    | {
        readonly status: PipelineNodeStatus.Unavailable;
        /** Plain language: why nothing reaches this, and what would change it. */
        readonly reason: string;
      }
    | {
        readonly status: PipelineNodeStatus.Unknown;
        /** Plain language: what is missing. */
        readonly reason: string;
        /** What would have to report it. */
        readonly wouldBeReportedBy: string;
      }
  );

export interface PipelineStage {
  readonly id: PipelineStageId;
  readonly title: string;
  /** The plain question this column answers. */
  readonly question: string;
  readonly nodes: readonly PipelineNode[];
}

export interface PipelineDescriptor {
  /** The session generation this describes. */
  readonly epoch: number;
  readonly openedAtMs: number;
  readonly stages: readonly PipelineStage[];
  /** Columns where nothing came back taken. */
  readonly incompleteStages: readonly PipelineStageId[];
  /**
   * Columns where two nodes both claimed to have run. That is a recorder bug,
   * never a rendering choice, so the column is drawn as unknown rather than
   * picking a winner.
   */
  readonly conflictingStages: readonly PipelineStageId[];
}

/**
 * A fork runs exactly one of its nodes; a set may run several at once, because
 * its nodes are concurrent facilities rather than alternatives.
 */
export type PipelineStageArity = "fork" | "set";

export interface PipelineStageDefinition {
  readonly id: PipelineStageId;
  readonly title: string;
  readonly question: string;
  readonly arity: PipelineStageArity;
}

export const pipelineStages: readonly PipelineStageDefinition[] = [
  {
    arity: "set",
    id: PipelineStageId.Intake,
    question: "What did the workbench hand the session?",
    title: "Intake",
  },
  {
    arity: "set",
    id: PipelineStageId.Conditioning,
    question: "Was the clip rewritten before anything played?",
    title: "Conditioning",
  },
  {
    arity: "fork",
    id: PipelineStageId.SessionMedia,
    question: "Which branch of the session's media preparation ran?",
    title: "Session media",
  },
  {
    arity: "fork",
    id: PipelineStageId.Open,
    question: "Which of the renderer's two media options was filled in?",
    title: "Open",
  },
  {
    arity: "fork",
    id: PipelineStageId.Decoder,
    question: "Who reads the container?",
    title: "Decoder",
  },
  {
    arity: "fork",
    id: PipelineStageId.Bytes,
    question: "Where do the bytes come from?",
    title: "Bytes",
  },
  {
    arity: "set",
    id: PipelineStageId.EngineServices,
    question: "What is the web video engine doing with them?",
    title: "Engine services",
  },
  {
    arity: "fork",
    id: PipelineStageId.Presentation,
    question: "Who owns the pixels?",
    title: "Presentation",
  },
  {
    arity: "fork",
    id: PipelineStageId.Compositor,
    question: "What paints the screen?",
    title: "Compositor",
  },
  {
    arity: "fork",
    id: PipelineStageId.Detections,
    question: "How does an annotation find its frame?",
    title: "Detections",
  },
  {
    arity: "set",
    id: PipelineStageId.Playback,
    question: "What holds the picture back?",
    title: "Playback",
  },
];

/**
 * What a node renders as before anything records it.
 *
 * `unavailable` marks the branches no option on this build reaches. Everything
 * else defaults to unknown and carries the sentence naming what would have to
 * report it, so the diagram's own incompleteness is on screen rather than in a
 * document.
 */
export type PipelineNodeDefault =
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly wouldBeReportedBy: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface PipelineNodeDefinition {
  readonly id: PipelineNodeId;
  readonly stage: PipelineStageId;
  readonly label: string;
  readonly fallback: PipelineNodeDefault;
}

/**
 * The reason a node falls back to unknown is always the same one: no record
 * arrived. Saying anything more, "it did not run" included, would be a claim
 * about a session nothing here observed.
 */
const nothingRecordedIt = (reporter: string): PipelineNodeDefault => ({
  kind: "unknown",
  reason: "Nothing recorded whether this ran.",
  wouldBeReportedBy: reporter,
});

const NOT_RECORDED_BY_THE_WORKBENCH = nothingRecordedIt(
  "the workbench, as it builds the media for a session",
);
const NOT_RECORDED_BY_THE_SESSION = nothingRecordedIt(
  "the session, as it prepares the media it was handed",
);
const NOT_RECORDED_BY_THE_ENGINE = nothingRecordedIt(
  "the web video engine, when it opens a clip",
);
const NOT_RECORDED_BY_THE_RENDERER = nothingRecordedIt(
  "the renderer's own state, once it has opened the clip",
);

const engineReadingsOff = (facility: string): PipelineNodeDefault => ({
  kind: "unknown",
  reason: `Nothing here reports ${facility} unless the engine is asked for live readings, and asking for them costs the session measurable work.`,
  wouldBeReportedBy: "the engine's live readings, switched on below",
});

export const pipelineNodes: readonly PipelineNodeDefinition[] = [
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.IntakeFixtureUrl,
    label: "Sample clip, by URL",
    stage: PipelineStageId.Intake,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.IntakeFixtureProxy,
    label: "Stand-in clip played instead of the named file",
    stage: PipelineStageId.Intake,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.IntakeUploadFile,
    label: "File from this machine",
    stage: PipelineStageId.Intake,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.IntakeUploadImageRecode,
    label: "Still picture re-encoded before opening",
    stage: PipelineStageId.Intake,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.IntakeConversionRefetch,
    label: "Whole clip downloaded so it could be converted",
    stage: PipelineStageId.Intake,
  },

  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.ConditioningNone,
    label: "Played as it arrived",
    stage: PipelineStageId.Conditioning,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.ConditioningWholeFile,
    label: "Converted in full, then played",
    stage: PipelineStageId.Conditioning,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.ConditioningProgressive,
    label: "Converted while it plays",
    stage: PipelineStageId.Conditioning,
  },
  {
    fallback: {
      kind: "unknown",
      reason:
        "Nothing compares the converted clip's frames to the original's, so a conversion that quietly resampled 25 pictures a second into 30 looks exactly like one that copied every frame across untouched.",
      wouldBeReportedBy:
        "the conversion result, once it carries a frame count and frame rate for what went in as well as what came out",
    },
    id: PipelineNodeId.ConditioningFrameGrid,
    label: "Frames kept as they were",
    stage: PipelineStageId.Conditioning,
  },

  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.SessionMediaUrl,
    label: "A URL, passed straight through",
    stage: PipelineStageId.SessionMedia,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.SessionMediaRendererSource,
    label: "A reader the workbench built, passed straight through",
    stage: PipelineStageId.SessionMedia,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.SessionMediaBlobObjectUrl,
    label: "A file wrapped in a local address",
    stage: PipelineStageId.SessionMedia,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.SessionMediaNormalizedObjectUrl,
    label: "The conversion, wrapped in a local address",
    stage: PipelineStageId.SessionMedia,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.SessionMediaProgressiveSource,
    label: "The conversion's own reader",
    stage: PipelineStageId.SessionMedia,
  },

  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.OpenViaSrc,
    label: "An address, opened by the renderer's own reader",
    stage: PipelineStageId.Open,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.OpenViaSource,
    label: "A reader, opened as it was handed over",
    stage: PipelineStageId.Open,
  },

  {
    fallback: NOT_RECORDED_BY_THE_ENGINE,
    id: PipelineNodeId.DecoderVideoEngine,
    label: "Web video engine",
    stage: PipelineStageId.Decoder,
  },
  {
    fallback: {
      kind: "unknown",
      reason:
        "Nothing downstream of the renderer's own fork records which arm it took, so a session that certainly went to Mediabunny cannot say so here.",
      wouldBeReportedBy:
        "the renderer's state, once it names which reader opened the clip",
    },
    id: PipelineNodeId.DecoderMediabunny,
    label: "Mediabunny, on its own",
    stage: PipelineStageId.Decoder,
  },
  {
    fallback: {
      kind: "unavailable",
      reason:
        "The library can open a single still picture, but this workbench has no control that reaches it: an uploaded picture is handed to the web video engine like everything else.",
    },
    id: PipelineNodeId.DecoderStaticImage,
    label: "Still-picture reader",
    stage: PipelineStageId.Decoder,
  },
  {
    fallback: {
      kind: "unavailable",
      reason:
        "The library can open a live camera, and this workbench has no control that opens one.",
    },
    id: PipelineNodeId.DecoderCameraStream,
    label: "Live camera reader",
    stage: PipelineStageId.Decoder,
  },

  {
    fallback: NOT_RECORDED_BY_THE_ENGINE,
    id: PipelineNodeId.BytesUrlSource,
    label: "Fetched over the network, in ranges",
    stage: PipelineStageId.Bytes,
  },
  {
    fallback: NOT_RECORDED_BY_THE_ENGINE,
    id: PipelineNodeId.BytesBlobSource,
    label: "Read out of a file already in memory",
    stage: PipelineStageId.Bytes,
  },
  {
    fallback: {
      kind: "unavailable",
      reason:
        "Nothing on this build hands the engine a one-way stream. A stream is read forwards once, so seeking back has nothing left to read and the engine cannot reopen it after a stall. The engine supports it and there is no way to reach it from here.",
    },
    id: PipelineNodeId.BytesEngineStream,
    label: "A one-way stream, into the web video engine",
    stage: PipelineStageId.Bytes,
  },
  {
    fallback: {
      kind: "unknown",
      reason:
        "Converting while playing really does feed a one-way stream to Mediabunny, and nothing reports what that reader opened.",
      wouldBeReportedBy:
        "the renderer's state, once it names which reader opened the clip",
    },
    id: PipelineNodeId.BytesConversionStream,
    label: "A one-way stream, out of the conversion",
    stage: PipelineStageId.Bytes,
  },

  {
    fallback: NOT_RECORDED_BY_THE_ENGINE,
    id: PipelineNodeId.EngineFrameTimeline,
    label: "Frame table",
    stage: PipelineStageId.EngineServices,
  },
  {
    fallback: engineReadingsOff("how much of the clip it is holding on to"),
    id: PipelineNodeId.EngineResidency,
    label: "Bytes held in memory",
    stage: PipelineStageId.EngineServices,
  },
  {
    fallback: engineReadingsOff("the anchor frames it seeks between"),
    id: PipelineNodeId.EngineKeyframeIndex,
    label: "Anchor-frame index",
    stage: PipelineStageId.EngineServices,
  },
  {
    fallback: engineReadingsOff("how many finished frames it is keeping"),
    id: PipelineNodeId.EngineFrameCacheExact,
    label: "Full-quality frame store",
    stage: PipelineStageId.EngineServices,
  },
  {
    fallback: engineReadingsOff("how many rough frames it is keeping"),
    id: PipelineNodeId.EngineFrameCachePreview,
    label: "Rough frame store, for dragging",
    stage: PipelineStageId.EngineServices,
  },
  {
    fallback: engineReadingsOff("what its decoder is working on"),
    id: PipelineNodeId.EngineDecodeScheduler,
    label: "Decode queue",
    stage: PipelineStageId.EngineServices,
  },

  {
    fallback: NOT_RECORDED_BY_THE_ENGINE,
    id: PipelineNodeId.PresentationFrames,
    label: "The engine announces frames, this page paints them",
    stage: PipelineStageId.Presentation,
  },
  {
    fallback: {
      kind: "unavailable",
      reason:
        "The engine would take the canvas over and paint straight onto it. Once that happens the browser hands the canvas to the engine's worker for good, and the boxes, masks and labels drawn on top here could never be drawn again. This workbench needs them, so it always keeps the canvas and takes finished frames from the engine instead.",
    },
    id: PipelineNodeId.PresentationCanvas,
    label: "The engine paints straight onto the canvas",
    stage: PipelineStageId.Presentation,
  },
  {
    fallback: {
      kind: "unknown",
      reason:
        "Nothing reports whether the renderer is asking a reader for each frame or being handed them. Holding the picture at every frame is the one visible sign, and a session can be held at every frame for a second reason, so it does not settle the question.",
      wouldBeReportedBy:
        "the renderer's state, once it names whether it pulls frames or receives them",
    },
    id: PipelineNodeId.PresentationPull,
    label: "The renderer asks for each frame",
    stage: PipelineStageId.Presentation,
  },

  {
    fallback: NOT_RECORDED_BY_THE_RENDERER,
    id: PipelineNodeId.CompositorPixiWebgpu,
    label: "Pixi on WebGPU",
    stage: PipelineStageId.Compositor,
  },
  {
    fallback: NOT_RECORDED_BY_THE_RENDERER,
    id: PipelineNodeId.CompositorPixiWebgl,
    label: "Pixi on WebGL",
    stage: PipelineStageId.Compositor,
  },

  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.DetectionsNearestFrameIndex,
    label: "By counting frames from the start",
    stage: PipelineStageId.Detections,
  },
  {
    fallback: NOT_RECORDED_BY_THE_WORKBENCH,
    id: PipelineNodeId.DetectionsInterval,
    label: "By the stretch of time each one covers",
    stage: PipelineStageId.Detections,
  },

  {
    fallback: NOT_RECORDED_BY_THE_RENDERER,
    id: PipelineNodeId.PlaybackNothingHeld,
    label: "Nothing is held back",
    stage: PipelineStageId.Playback,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.PlaybackDetectionGate,
    label: "Waits for detections before any frame",
    stage: PipelineStageId.Playback,
  },
  {
    fallback: NOT_RECORDED_BY_THE_SESSION,
    id: PipelineNodeId.PlaybackPreparationGate,
    label: "Waits for masks before any frame",
    stage: PipelineStageId.Playback,
  },
];

export const pipelineNodesById: ReadonlyMap<
  PipelineNodeId,
  PipelineNodeDefinition
> = new Map(pipelineNodes.map((node) => [node.id, node]));

export const pipelineStagesById: ReadonlyMap<
  PipelineStageId,
  PipelineStageDefinition
> = new Map(pipelineStages.map((stage) => [stage.id, stage]));
