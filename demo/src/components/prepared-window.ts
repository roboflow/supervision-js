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

/** Reads the cook's own numbers into something a timeline can draw. */
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
  const targetFrameCount = Math.max(
    cookedFrameCount,
    artifact.window?.targetFrameCount ?? artifact.prefetchCount ?? 0,
  );

  return {
    cookedFrameCount,
    cookedSeconds: Math.max(0, artifact.preparedAheadSeconds ?? 0),
    framePitchSeconds,
    targetFrameCount,
    targetSeconds: targetFrameCount * framePitchSeconds,
  };
}
