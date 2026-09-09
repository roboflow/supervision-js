import {
  PipelineNodeStatus,
  pipelineStagesById,
  type PipelineDescriptor,
  type PipelineNode,
  type PipelineStageId,
} from "./pipeline-descriptor";

const MARKERS: Record<PipelineNodeStatus, string> = {
  [PipelineNodeStatus.Bypassed]: "·",
  [PipelineNodeStatus.Taken]: "✓",
  [PipelineNodeStatus.Unavailable]: "✗",
  [PipelineNodeStatus.Unknown]: "?",
};

/**
 * The same diagram as text, so the answer to "what path did this take" can be
 * pasted into a bug report. Generated from the descriptor the panel draws, so
 * the two cannot drift apart.
 */
export function formatPipelineTrace(descriptor: PipelineDescriptor): string {
  const lines: string[] = [
    `pipeline path — session ${descriptor.epoch}`,
    "",
    "✓ ran   · did not run   ✗ nothing here can reach it   ? nothing reports it",
    "",
  ];

  for (const stage of descriptor.stages) {
    lines.push(`${stage.title} — ${stage.question}`);

    for (const node of stage.nodes) {
      lines.push(`  ${MARKERS[node.status]} ${node.label}`);
      lines.push(...describeNode(node));
    }

    lines.push("");
  }

  if (descriptor.incompleteStages.length > 0) {
    lines.push(
      `Nothing reported a path through: ${titles(descriptor.incompleteStages)}`,
    );
  }

  if (descriptor.conflictingStages.length > 0) {
    lines.push(
      `Two branches both reported running in: ${titles(descriptor.conflictingStages)}`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function titles(stages: readonly PipelineStageId[]) {
  return stages
    .map((stage) => pipelineStagesById.get(stage)?.title ?? stage)
    .join(", ");
}

function describeNode(node: PipelineNode): readonly string[] {
  if (node.status === PipelineNodeStatus.Taken) {
    return [
      ...node.facts.map((fact) => `      ${fact.label}: ${fact.value}`),
      `      recorded by ${node.evidence.site}`,
    ];
  }

  if (node.status === PipelineNodeStatus.Unknown) {
    return [
      `      ${node.reason}`,
      `      would be reported by ${node.wouldBeReportedBy}`,
    ];
  }

  return [`      ${node.reason}`];
}
