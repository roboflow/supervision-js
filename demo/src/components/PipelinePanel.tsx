import { memo, useEffect, useMemo, useState } from "react";
import type { DiagnosticsSnapshot } from "supervision-js-video-engine";

import type { EngineDiagnosticsTap } from "../diagnostics/engine-diagnostics-tap";
import { formatMb } from "../diagnostics/engine-metrics";
import {
  PipelineNodeId,
  PipelineNodeStatus,
  type PipelineDescriptor,
  type PipelineNode,
  type PipelineStage,
} from "../pipeline/pipeline-descriptor";
import { formatPipelineTrace } from "../pipeline/pipeline-trace";
import { DiagnosticLabel } from "./DiagnosticLabel";
import { Readout } from "./Readout";

const LIVE_POLL_INTERVAL_MS = 250;

const VIEW_WIDTH = 300;
const TRUNK_X = 16;
const NODE_X = 30;
const NODE_RIGHT = 294;
const BRANCH_MARK_X = 44;
const BRANCH_TEXT_X = 54;
const DOT_SIZE = 5;

const STAGE_HEAD_HEIGHT = 14;
const STAGE_GAP = 5;
const SPINE_HEIGHT = 20;
const BRANCH_HEIGHT = 12;
const ROW_GAP = 2;
const OUTLET_HEIGHT = 8;

/** The transport's four states, borrowed whole so a node reads like a cell. */
type NodeState = "error" | "idle" | "live" | "waiting";

const NODE_STATES: Record<PipelineNodeStatus, NodeState> = {
  [PipelineNodeStatus.Bypassed]: "idle",
  [PipelineNodeStatus.Taken]: "live",
  [PipelineNodeStatus.Unavailable]: "error",
  [PipelineNodeStatus.Unknown]: "waiting",
};

const STATUS_ORDER: Record<PipelineNodeStatus, number> = {
  [PipelineNodeStatus.Taken]: 0,
  [PipelineNodeStatus.Unknown]: 1,
  [PipelineNodeStatus.Bypassed]: 2,
  [PipelineNodeStatus.Unavailable]: 3,
};

const STATUS_WORDS: Record<PipelineNodeStatus, string> = {
  [PipelineNodeStatus.Bypassed]: "Did not run.",
  [PipelineNodeStatus.Taken]: "Ran.",
  [PipelineNodeStatus.Unavailable]: "Nothing here can reach it.",
  [PipelineNodeStatus.Unknown]: "Nothing reports it.",
};

const LEGEND: readonly {
  readonly state: NodeState;
  readonly word: string;
  readonly tooltip: string;
}[] = [
  { state: "live", tooltip: "A record says this ran.", word: "ran" },
  {
    state: "waiting",
    tooltip: "Nothing in this build reports whether this ran.",
    word: "unknown",
  },
  {
    state: "idle",
    tooltip: "A record says something else in this step ran.",
    word: "not taken",
  },
  {
    state: "error",
    tooltip: "No control on this build reaches it.",
    word: "blocked",
  },
];

/**
 * The descriptor names each node in a full sentence; a drawn node has room for
 * two or three words. The sentence, the reason and the recording site all
 * travel in the node's tooltip, so nothing is lost by drawing the short form.
 */
const SHORT_LABELS: Record<PipelineNodeId, string> = {
  [PipelineNodeId.BytesBlobSource]: "File in memory",
  [PipelineNodeId.BytesConversionStream]: "Stream from conversion",
  [PipelineNodeId.BytesEngineStream]: "One-way stream in",
  [PipelineNodeId.BytesUrlSource]: "Network ranges",
  [PipelineNodeId.CompositorPixiWebgl]: "Pixi on WebGL",
  [PipelineNodeId.CompositorPixiWebgpu]: "Pixi on WebGPU",
  [PipelineNodeId.ConditioningFrameGrid]: "Frames kept as they were",
  [PipelineNodeId.ConditioningNone]: "Played as it arrived",
  [PipelineNodeId.ConditioningProgressive]: "Converted while playing",
  [PipelineNodeId.ConditioningWholeFile]: "Converted in full",
  [PipelineNodeId.DecoderCameraStream]: "Live camera reader",
  [PipelineNodeId.DecoderMediabunny]: "Mediabunny alone",
  [PipelineNodeId.DecoderStaticImage]: "Still-picture reader",
  [PipelineNodeId.DecoderVideoEngine]: "Video engine",
  [PipelineNodeId.DetectionsInterval]: "By time span",
  [PipelineNodeId.DetectionsNearestFrameIndex]: "By frame count",
  [PipelineNodeId.EngineDecodeScheduler]: "Decode queue",
  [PipelineNodeId.EngineFrameCacheExact]: "Full-quality store",
  [PipelineNodeId.EngineFrameCachePreview]: "Rough store",
  [PipelineNodeId.EngineFrameTimeline]: "Frame table",
  [PipelineNodeId.EngineKeyframeIndex]: "Anchor index",
  [PipelineNodeId.EngineResidency]: "Bytes held",
  [PipelineNodeId.IntakeConversionRefetch]: "Downloaded in full",
  [PipelineNodeId.IntakeFixtureProxy]: "Stand-in clip",
  [PipelineNodeId.IntakeFixtureUrl]: "Sample clip URL",
  [PipelineNodeId.IntakeUploadFile]: "File from this machine",
  [PipelineNodeId.IntakeUploadImageRecode]: "Still re-encoded",
  [PipelineNodeId.OpenViaSrc]: "Opened by address",
  [PipelineNodeId.OpenViaSource]: "Opened by reader",
  [PipelineNodeId.PlaybackDetectionHold]: "Held for detections",
  [PipelineNodeId.PlaybackEveryFrame]: "Every frame waits",
  [PipelineNodeId.PlaybackNothingHeld]: "Nothing held back",
  [PipelineNodeId.PlaybackStartOnly]: "Only the start waits",
  [PipelineNodeId.PresentationCanvas]: "Engine paints canvas",
  [PipelineNodeId.PresentationFrames]: "Engine hands over frames",
  [PipelineNodeId.PresentationPull]: "Renderer pulls frames",
  [PipelineNodeId.SessionMediaBlobObjectUrl]: "File as local address",
  [PipelineNodeId.SessionMediaNormalizedObjectUrl]: "Conversion as address",
  [PipelineNodeId.SessionMediaProgressiveSource]: "Conversion's own reader",
  [PipelineNodeId.SessionMediaRendererSource]: "Reader passed through",
  [PipelineNodeId.SessionMediaUrl]: "URL passed through",
};

interface DrawnNode {
  readonly cy: number;
  readonly id: PipelineNodeId;
  readonly label: string;
  readonly onSpine: boolean;
  readonly stamp: string | null;
  readonly state: NodeState;
  readonly tooltip: string;
}

interface DrawnStage {
  readonly height: number;
  readonly id: string;
  readonly nodes: readonly DrawnNode[];
  readonly question: string;
  readonly title: string;
  readonly top: number;
  readonly trunk: NodeState;
}

interface Diagram {
  readonly height: number;
  readonly outlet: NodeState;
  readonly stages: readonly DrawnStage[];
}

/**
 * The path this session took, drawn. The route runs down one trunk; every
 * branch the session went past hangs off it as a stub that stops short.
 *
 * The whole picture comes from a descriptor sealed once, when the session
 * finished opening, so nothing here reads the engine while the picture moves.
 * The few live figures at the bottom are opt-in because asking for them makes
 * the engine count and publish on every frame.
 */
export const PipelinePanel = memo(function PipelinePanel({
  descriptor,
  engineDiagnosticsTap,
}: {
  readonly descriptor: PipelineDescriptor | null;
  readonly engineDiagnosticsTap: EngineDiagnosticsTap;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="pipeline-panel" aria-label="Pipeline path">
      <header className="inspector-card__header">
        <button
          aria-expanded={open}
          className="pipeline-panel__toggle"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <h2>Pipeline path</h2>
          <span aria-hidden="true" className="pipeline-panel__chevron" />
        </button>
        {open && descriptor !== null ? (
          <CopyPathButton descriptor={descriptor} />
        ) : null}
      </header>
      <PipelineLedger descriptor={descriptor} />
      {open && descriptor !== null ? (
        <>
          <PipelineLegend />
          <PipelineDiagram descriptor={descriptor} />
          <LiveEngineReadings tap={engineDiagnosticsTap} />
        </>
      ) : null}
    </section>
  );
});

function PipelineLedger({
  descriptor,
}: {
  readonly descriptor: PipelineDescriptor | null;
}) {
  if (descriptor === null) {
    return (
      <div className="pipeline-panel__ledger pipeline-panel__ledger--empty">
        <LedgerCell
          label="Session"
          state="waiting"
          tooltip="Nothing has finished opening yet, so there is no path to draw."
          value="none open"
        />
      </div>
    );
  }

  const nodes = descriptor.stages.flatMap((stage) => stage.nodes);
  const taken = nodes.filter(
    (node) => node.status === PipelineNodeStatus.Taken,
  ).length;
  const unknown = nodes.filter(
    (node) => node.status === PipelineNodeStatus.Unknown,
  ).length;
  const reported =
    descriptor.stages.length - descriptor.incompleteStages.length;

  return (
    <div className="pipeline-panel__ledger">
      <LedgerCell
        label="Route"
        state="live"
        tooltip="How many steps left a record that they ran. A step is drawn on the route only because something stamped it."
        value={String(taken)}
      />
      <LedgerCell
        label="Steps"
        state={reported === descriptor.stages.length ? "live" : "waiting"}
        tooltip="How many of the diagram's steps had a branch report that it ran. A step nothing reported is drawn as unknown rather than guessed."
        value={`${reported}/${descriptor.stages.length}`}
      />
      <LedgerCell
        align="end"
        label="Unknown"
        state={unknown === 0 ? "live" : "waiting"}
        tooltip="Branches nothing in this build reports yet. They are drawn where they would sit, in amber, rather than left out."
        value={String(unknown)}
      />
    </div>
  );
}

function LedgerCell({
  align = "start",
  label,
  state,
  tooltip,
  value,
}: {
  readonly align?: "end" | "start";
  readonly label: string;
  readonly state: NodeState;
  readonly tooltip: string;
  readonly value: string;
}) {
  return (
    <span className={`control-bar__cell control-bar__cell--${state}`}>
      <DiagnosticLabel align={align} label={label} tooltip={tooltip} />
      <span className="control-bar__cell-value">
        <span aria-hidden="true" className="control-bar__cell-dot" />
        {value}
      </span>
    </span>
  );
}

function PipelineLegend() {
  return (
    <ul className="pipeline-legend">
      {LEGEND.map((entry) => (
        <li
          className={`pipeline-legend__item pipeline-legend__item--${entry.state}`}
          key={entry.state}
          title={entry.tooltip}
        >
          <span aria-hidden="true" className="control-bar__cell-dot" />
          {entry.word}
        </li>
      ))}
    </ul>
  );
}

const PipelineDiagram = memo(function PipelineDiagram({
  descriptor,
}: {
  readonly descriptor: PipelineDescriptor;
}) {
  const diagram = useMemo(() => layOutDiagram(descriptor), [descriptor]);

  return (
    <svg
      aria-label="The path media and detections took through this session"
      className="pipeline-diagram"
      height={diagram.height}
      role="list"
      viewBox={`0 0 ${VIEW_WIDTH} ${diagram.height}`}
      width={VIEW_WIDTH}
    >
      {diagram.stages.map((stage) => (
        <g key={stage.id}>
          <line
            className={`pipeline-diagram__trunk pipeline-diagram__trunk--${stage.trunk}`}
            x1={TRUNK_X}
            x2={TRUNK_X}
            y1={stage.top}
            y2={stage.top + stage.height}
          />
          <line
            className="pipeline-diagram__tick"
            x1={TRUNK_X - 3.5}
            x2={TRUNK_X + 3.5}
            y1={stage.top + 1}
            y2={stage.top + 1}
          />
          <text
            className="pipeline-diagram__stage"
            x={NODE_X}
            y={stage.top + 7}
          >
            {stage.title}
            <title>{stage.question}</title>
          </text>
          {stage.nodes.map((node) =>
            node.onSpine ? (
              <SpineNode key={node.id} node={node} />
            ) : (
              <BranchNode key={node.id} node={node} />
            ),
          )}
        </g>
      ))}
      <path
        className={`pipeline-diagram__outlet pipeline-diagram__outlet--${diagram.outlet}`}
        d={`M ${TRUNK_X - 3.5} ${diagram.height - OUTLET_HEIGHT} L ${TRUNK_X} ${diagram.height - 1} L ${TRUNK_X + 3.5} ${diagram.height - OUTLET_HEIGHT}`}
      />
    </svg>
  );
});

function SpineNode({ node }: { readonly node: DrawnNode }) {
  const top = node.cy - SPINE_HEIGHT / 2;

  return (
    <g
      className={`pipeline-diagram__node pipeline-diagram__node--${node.state}`}
      role="listitem"
    >
      <title>{node.tooltip}</title>
      <rect
        className="pipeline-diagram__hit"
        height={SPINE_HEIGHT + ROW_GAP}
        width={NODE_RIGHT - TRUNK_X}
        x={TRUNK_X}
        y={top - ROW_GAP / 2}
      />
      <line
        className="pipeline-diagram__lead"
        x1={TRUNK_X}
        x2={NODE_X}
        y1={node.cy}
        y2={node.cy}
      />
      <rect
        className="pipeline-diagram__box"
        height={SPINE_HEIGHT}
        rx={4}
        width={NODE_RIGHT - NODE_X}
        x={NODE_X}
        y={top}
      />
      <rect
        className="pipeline-diagram__dot"
        height={DOT_SIZE}
        rx={1}
        width={DOT_SIZE}
        x={NODE_X + 8}
        y={node.cy - DOT_SIZE / 2}
      />
      <text
        className="pipeline-diagram__label"
        dominantBaseline="central"
        x={NODE_X + 19}
        y={node.cy}
      >
        {node.label}
      </text>
      {node.stamp === null ? null : (
        <text
          className="pipeline-diagram__stamp"
          dominantBaseline="central"
          textAnchor="end"
          x={NODE_RIGHT - 8}
          y={node.cy}
        >
          {node.stamp}
        </text>
      )}
    </g>
  );
}

function BranchNode({ node }: { readonly node: DrawnNode }) {
  const half = DOT_SIZE / 2;

  return (
    <g
      className={`pipeline-diagram__node pipeline-diagram__node--${node.state}`}
      role="listitem"
    >
      <title>{node.tooltip}</title>
      <rect
        className="pipeline-diagram__hit"
        height={BRANCH_HEIGHT + ROW_GAP}
        width={NODE_RIGHT - TRUNK_X}
        x={TRUNK_X}
        y={node.cy - (BRANCH_HEIGHT + ROW_GAP) / 2}
      />
      <path
        className="pipeline-diagram__stub"
        d={`M ${TRUNK_X} ${node.cy - 7} V ${node.cy - 4} Q ${TRUNK_X} ${node.cy} ${TRUNK_X + 4} ${node.cy} H ${BRANCH_MARK_X - half - 3}`}
      />
      <rect
        className="pipeline-diagram__dot pipeline-diagram__dot--hollow"
        height={DOT_SIZE}
        rx={1}
        width={DOT_SIZE}
        x={BRANCH_MARK_X - half}
        y={node.cy - half}
      />
      {node.state === "error" ? (
        <line
          className="pipeline-diagram__slash"
          x1={BRANCH_MARK_X - half - 1.5}
          x2={BRANCH_MARK_X + half + 1.5}
          y1={node.cy + half + 1.5}
          y2={node.cy - half - 1.5}
        />
      ) : null}
      <text
        className="pipeline-diagram__label pipeline-diagram__label--branch"
        dominantBaseline="central"
        x={BRANCH_TEXT_X}
        y={node.cy}
      >
        {node.label}
      </text>
    </g>
  );
}

function layOutDiagram(descriptor: PipelineDescriptor): Diagram {
  let y = 0;

  const stages = descriptor.stages.map((stage) => {
    const top = y;

    y += STAGE_HEAD_HEIGHT;

    const nodes = orderNodes(stage).map((node) => {
      const onSpine = node.status === PipelineNodeStatus.Taken;
      const height = onSpine ? SPINE_HEIGHT : BRANCH_HEIGHT;
      const drawn: DrawnNode = {
        cy: y + height / 2,
        id: node.id,
        label: SHORT_LABELS[node.id],
        onSpine,
        stamp:
          node.status === PipelineNodeStatus.Taken
            ? `${node.evidence.atMs}ms`
            : null,
        state: NODE_STATES[node.status],
        tooltip: describeNode(node),
      };

      y += height + ROW_GAP;

      return drawn;
    });

    y += STAGE_GAP;

    return {
      height: y - top,
      id: stage.id,
      nodes,
      question: stage.question,
      title: stage.title,
      top,
      trunk: nodes.some((node) => node.onSpine)
        ? ("live" as const)
        : ("waiting" as const),
    };
  });

  return {
    height: y + OUTLET_HEIGHT,
    outlet: stages[stages.length - 1]?.trunk ?? "waiting",
    stages,
  };
}

function orderNodes(stage: PipelineStage): readonly PipelineNode[] {
  return [...stage.nodes].sort((left, right) => {
    const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];

    if (byStatus !== 0) {
      return byStatus;
    }

    return left.status === PipelineNodeStatus.Taken &&
      right.status === PipelineNodeStatus.Taken
      ? left.evidence.seq - right.evidence.seq
      : 0;
  });
}

function describeNode(node: PipelineNode): string {
  const sentences = [`${node.label}.`, STATUS_WORDS[node.status]];

  if (node.status === PipelineNodeStatus.Taken) {
    sentences.push(
      ...node.facts.map((fact) => `${fact.label}: ${fact.value}.`),
      `Recorded by ${node.evidence.site}, ${node.evidence.atMs} ms into the open.`,
    );
  } else {
    sentences.push(node.reason);
  }

  if (node.status === PipelineNodeStatus.Unknown) {
    sentences.push(`Would be reported by ${node.wouldBeReportedBy}.`);
  }

  return sentences.join(" ");
}

function CopyPathButton({
  descriptor,
}: {
  readonly descriptor: PipelineDescriptor;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [descriptor]);

  return (
    <button
      className="pipeline-panel__copy"
      onClick={() => {
        void copyPath(descriptor, setCopied);
      }}
      type="button"
    >
      {copied ? "Copied" : "Copy as text"}
    </button>
  );
}

async function copyPath(
  descriptor: PipelineDescriptor,
  setCopied: (copied: boolean) => void,
) {
  await navigator.clipboard.writeText(formatPipelineTrace(descriptor));
  setCopied(true);
}

/**
 * The few figures that keep moving. Reading them turns the engine's broadcast
 * on for the whole session and switches on per-frame counters with it, so the
 * diagram stands on its own without this and nothing here starts until someone
 * asks.
 */
function LiveEngineReadings({ tap }: { readonly tap: EngineDiagnosticsTap }) {
  const [reading, setReading] = useState(false);
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);

  useEffect(() => {
    if (!reading) {
      setSnapshot(null);
      return undefined;
    }

    const stop = tap.start();
    const poll = setInterval(() => {
      setSnapshot(tap.read());
    }, LIVE_POLL_INTERVAL_MS);

    return () => {
      clearInterval(poll);
      stop();
    };
  }, [reading, tap]);

  return (
    <div className="pipeline-live">
      <div className="pipeline-live__header">
        <DiagnosticLabel
          label="Live engine readings"
          tooltip="The engine reports nothing about what it is holding unless it is asked to, and asking makes it count and publish on every frame for as long as this stays on."
        />
        <label className="pipeline-live__switch">
          <input
            checked={reading}
            onChange={(event) => setReading(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Read while it runs</span>
        </label>
      </div>
      {reading ? (
        <div className="pipeline-live__readings">
          {liveReadings(snapshot).map((entry) => (
            <Readout
              key={entry.label}
              label={entry.label}
              value={entry.value}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function liveReadings(snapshot: DiagnosticsSnapshot | null) {
  if (snapshot === null) {
    return [{ label: "Engine", value: "no engine opened on this path" }];
  }

  return [
    {
      label: "Bytes held",
      value:
        snapshot.sourceResidency === null
          ? "not holding any"
          : `${formatMb(snapshot.sourceResidency.residentBytes)} of ${formatMb(
              snapshot.sourceResidency.totalBytes,
            )}`,
    },
    {
      label: "Anchor index",
      value: `${snapshot.gop.count} anchors, ${snapshot.gop.avgGopS.toFixed(2)} s apart`,
    },
    {
      label: "Full-quality store",
      value: formatMb(snapshot.cacheBytes.exactBytes),
    },
    {
      label: "Rough store",
      value: formatMb(snapshot.cacheBytes.previewBytes),
    },
    {
      label: "Decode queue",
      value: `${snapshot.scheduler?.mode ?? "idle"}, ${snapshot.counters.foregroundDecodes} decodes`,
    },
  ];
}
