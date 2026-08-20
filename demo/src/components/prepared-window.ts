import type { RenderPreparationArtifactDiagnostics } from "supervision";

/** Frame pitch to fall back on when the source never reported a rate. */
const FALLBACK_FRAME_RATE = 60;

export interface PreparedWindowReading {
  /** Frames cooked in an unbroken run forward from the playhead. */
  readonly cookedFrameCount: number;
  /** How far that run reaches, in media seconds. */
  readonly cookedSeconds: number;
  readonly framePitchSeconds: number;
  /** Frames the cook selected to prepare for this playhead position. */
  readonly targetFrameCount: number;
  readonly targetSeconds: number;
}

/**
 * Reads the cook's own numbers into something a timeline can draw.
 *
 * The engine measures the last cooked frame's distance the long way round a
 * looping timeline, so a run ending just behind the playhead is reported as
 * almost a full lap ahead: measured here at 1x, `preparedAheadSeconds` reads
 * 66.86s for the same 211 frames that cover 7.0s. The frame count is never
 * wrapped, so it sets the reach and the reported seconds may only shorten it.
 *
 * The cook may cover a fast playhead by preparing every second or third frame
 * instead of every one, which this reads as a shorter reach than the run truly
 * has. That direction is the safe one: the bar never claims more than is cooked.
 */
export function readPreparedWindow(
  artifact: RenderPreparationArtifactDiagnostics | null,
  sourceFrameRate: number | null,
): PreparedWindowReading | null {
  if (artifact === null || artifact.preparedAheadFrameCount === undefined) {
    return null;
  }

  const frameRate =
    sourceFrameRate !== null && sourceFrameRate > 0
      ? sourceFrameRate
      : FALLBACK_FRAME_RATE;
  const framePitchSeconds = 1 / frameRate;
  const cookedFrameCount = Math.max(0, artifact.preparedAheadFrameCount);
  const reportedSeconds = Math.max(0, artifact.preparedAheadSeconds ?? 0);
  const targetFrameCount = Math.max(
    cookedFrameCount,
    artifact.window?.targetFrameCount ?? artifact.prefetchCount ?? 0,
  );

  return {
    cookedFrameCount,
    cookedSeconds: Math.min(
      reportedSeconds,
      cookedFrameCount * framePitchSeconds,
    ),
    framePitchSeconds,
    targetFrameCount,
    targetSeconds: targetFrameCount * framePitchSeconds,
  };
}
