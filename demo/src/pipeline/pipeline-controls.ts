/**
 * The few drawn nodes that are a choice, not a record of one.
 *
 * Most of the diagram is not switchable, and the difference is the whole point
 * of this file. A node here names one branch of a control the Session panel
 * already owns, and picking it writes that control's own options: there is one
 * way to change a setting and both surfaces read the same session.
 *
 * Everything absent is absent for a reason worth stating:
 *
 * - Session media, Open, Bytes and Compositor are consequences. Which branch
 *   runs falls out of the intake, the media path and what the device offered;
 *   no control selects one.
 * - Presentation is not a session option at all. Canvas presentation is a
 *   different page load (`?presentation=canvas`) that replaces this workbench
 *   with a player carrying no annotation layer, so it is a door out of this
 *   session, not a switch on it.
 * - Detections follows the sample's own manifest: a sample that records the
 *   time each detection covers is paired on time, one that does not has its
 *   position rebuilt from the count. Neither is chosen.
 * - Playback's three branches are one reading computed from two independent
 *   gates and the kind of source, so no single control lands on a branch.
 * - Source residency is a three-way setting drawn as one node, and the node
 *   reads unknown unless the engine's live readings are on, so a click here
 *   could only guess which of the three the session is on.
 * - Intake is which clip is open, which the Source controls own.
 */

import {
  DemoMediaPath,
  type DemoOptionSupport,
  type DemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";
import { PipelineNodeId } from "./pipeline-descriptor";

export interface PipelineNodeChoice {
  /** Why the control cannot act on this session, or null when it can. */
  readonly blocked: string | null;
  /** The Session-panel control this node is one branch of. */
  readonly control: string;
  /** Whether the session is running on this branch. */
  readonly current: boolean;
  /** The options the session would reopen on. */
  readonly select: (options: DemoSessionOptions) => DemoSessionOptions;
}

/** What picking this node would do, or null for a node that is not a choice. */
export function readPipelineNodeChoice(
  id: PipelineNodeId,
  configuration: DemoSessionConfiguration,
  options: DemoSessionOptions,
): PipelineNodeChoice | null {
  switch (id) {
    case PipelineNodeId.DecoderVideoEngine:
      return mediaPathChoice(DemoMediaPath.Engine, configuration);
    case PipelineNodeId.DecoderMediabunny:
      return mediaPathChoice(DemoMediaPath.Mediabunny, configuration);
    case PipelineNodeId.ConditioningNone:
      return conditioningChoice(null, configuration, options);
    case PipelineNodeId.ConditioningWholeFile:
      return conditioningChoice(false, configuration, options);
    case PipelineNodeId.ConditioningProgressive:
      return conditioningChoice(true, configuration, options);
    default:
      return null;
  }
}

/** The sentence a node's tooltip ends on once it turns out to be a choice. */
export function describePipelineNodeChoice(choice: PipelineNodeChoice): string {
  if (choice.current) {
    return `The Session panel's ${choice.control} is on this branch.`;
  }

  if (choice.blocked !== null) {
    return `${choice.control} cannot change on this session. ${choice.blocked}`;
  }

  return `Pick this to put the Session panel's ${choice.control} on this branch and reopen the clip on it.`;
}

function mediaPathChoice(
  path: DemoMediaPath,
  configuration: DemoSessionConfiguration,
): PipelineNodeChoice {
  return {
    blocked: readBlocked(configuration.mediaPathSupport),
    control: "Media path",
    current: configuration.mediaPath === path,
    select: (options) => ({ ...options, mediaPath: path }),
  };
}

/**
 * `stream` is null for the branch that converts nothing. Picking a branch does
 * what the Normalize and Stream toggles do together, because the branch is what
 * the pair of them adds up to.
 */
function conditioningChoice(
  stream: boolean | null,
  configuration: DemoSessionConfiguration,
  options: DemoSessionOptions,
): PipelineNodeChoice {
  const normalizing =
    configuration.normalizationSupport.supported && options.normalize === true;
  const streaming = options.normalizeStream ?? false;

  return {
    blocked: readBlocked(configuration.normalizationSupport),
    control: "Normalize",
    current:
      stream === null ? !normalizing : normalizing && streaming === stream,
    select: (current) =>
      stream === null
        ? { ...current, normalize: undefined }
        : { ...current, normalize: true, normalizeStream: stream },
  };
}

function readBlocked(support: DemoOptionSupport) {
  return support.supported ? null : support.reason;
}
