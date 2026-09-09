import type { MediaRenderer } from "supervision";

const FALLBACK_FRAME_DURATION_SECONDS = 1 / 30;

export interface ReadinessBand {
  readonly endTime: number;
  readonly startTime: number;
}

/**
 * Media-time ranges the renderer's prepared annotation window covers, merged
 * from its per-frame readiness. Null is a renderer that answers nothing (a
 * scene free-running on the ticker), which a lane reports as unavailable
 * rather than as prepared nothing.
 */
export function readRendererReadinessBands(
  renderer: MediaRenderer | null,
): readonly ReadinessBand[] | null {
  const snapshot = renderer?.getPreparedAnnotationWindow() ?? null;

  if (!snapshot) {
    return null;
  }

  const frames = snapshot.frames;
  const frameDuration = resolveFrameDuration(frames.map((f) => f.mediaTime));
  const bands: ReadinessBand[] = [];
  let openBand: { endTime: number; startTime: number } | null = null;

  for (const frame of frames) {
    if (!frame.prepared) {
      openBand = null;
      continue;
    }
    const endTime = frame.mediaTime + frameDuration;
    if (openBand && frame.mediaTime <= openBand.endTime) {
      openBand.endTime = endTime;
      continue;
    }
    openBand = { endTime, startTime: frame.mediaTime };
    bands.push(openBand);
  }

  return bands;
}

function resolveFrameDuration(mediaTimes: readonly number[]): number {
  let smallest = Number.POSITIVE_INFINITY;

  for (let index = 1; index < mediaTimes.length; index += 1) {
    const delta = mediaTimes[index] - mediaTimes[index - 1];
    if (delta > 0 && delta < smallest) {
      smallest = delta;
    }
  }

  return Number.isFinite(smallest) ? smallest : FALLBACK_FRAME_DURATION_SECONDS;
}
