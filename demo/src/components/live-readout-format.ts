import { MediaRendererPlaybackState } from "supervision";
import { formatExactTime, formatInteger } from "../format";
import type { LiveReadouts } from "../hooks/live-readouts";
import { selectPreparedWindowArtifact } from "../render-preparation";
import {
  formatPlaybackRate,
  isPlaybackRateSustained,
} from "../session/playback-rate";
import {
  readPreparedWindow,
  type PreparedWindowReading,
} from "./prepared-window";

export interface PlaybackStatePresentation {
  readonly label: string;
  readonly tone: "error" | "idle" | "live" | "waiting";
}

/**
 * The states the transport publishes that the play button cannot draw. Playing
 * and paused are absent on purpose: the button is already showing them, so the
 * chip spends its space on the rate the picture is actually keeping instead.
 */
const namedPlaybackStates: Partial<
  Record<MediaRendererPlaybackState, PlaybackStatePresentation>
> = {
  [MediaRendererPlaybackState.Buffering]: {
    label: "Buffering",
    tone: "waiting",
  },
  [MediaRendererPlaybackState.Destroyed]: { label: "Destroyed", tone: "error" },
  [MediaRendererPlaybackState.Error]: { label: "Error", tone: "error" },
  [MediaRendererPlaybackState.Loading]: { label: "Loading", tone: "waiting" },
  [MediaRendererPlaybackState.Ready]: { label: "Ready", tone: "idle" },
};

/** Used to read "the playhead is on the last frame" until the source reports
 *  its own frame rate. */
const fallbackFramePitchSeconds = 1 / 60;

export function readLiveFramePitchSeconds(readouts: LiveReadouts) {
  const frameRate = readouts.sourceFrameRate;

  return frameRate !== null && frameRate > 0
    ? 1 / frameRate
    : fallbackFramePitchSeconds;
}

export function readLivePreparedWindow(
  readouts: LiveReadouts,
): PreparedWindowReading | null {
  return readPreparedWindow(
    selectPreparedWindowArtifact(readouts.renderPreparation),
    readouts.sourceFrameRate,
  );
}

export function isLiveAtClipEnd(readouts: LiveReadouts) {
  const { currentTime, duration, playbackState } = readouts;

  return (
    playbackState !== MediaRendererPlaybackState.Playing &&
    playbackState !== MediaRendererPlaybackState.Buffering &&
    currentTime !== null &&
    duration !== null &&
    duration > 0 &&
    duration - currentTime <= readLiveFramePitchSeconds(readouts)
  );
}

export function formatLiveTimecode(readouts: LiveReadouts) {
  return formatExactTime(readLivePresentedTime(readouts));
}

/** The picture's timestamp, already normalized when an older renderer does
 * not report one separately. */
export function readLivePresentedTime(readouts: LiveReadouts) {
  return readouts.presentedTime;
}

export function formatLiveDetectionTime(readouts: LiveReadouts) {
  return formatExactTime(readouts.activeDetectionFrameTime);
}

export function formatLiveHotBuffer({ detectionBuffer }: LiveReadouts) {
  if (detectionBuffer === null) {
    return "-";
  }

  return `${formatInteger(detectionBuffer.frameCount)}f · ${formatInteger(
    detectionBuffer.detectionCount,
  )}d`;
}

export function formatLiveCook({ renderPreparation }: LiveReadouts) {
  const artifact = selectPreparedWindowArtifact(renderPreparation);

  if (artifact === null) {
    return "-";
  }

  return `${formatInteger(artifact.inFlightCount ?? 0)}/${formatInteger(
    artifact.maxInFlightCount ?? 0,
  )} · ${formatInteger(artifact.pendingCount)}q`;
}

/**
 * A state worth naming takes the chip; otherwise it carries the one fact the
 * play button cannot, which is whether the picture is really running at the
 * speed it was asked for.
 */
export function readLiveStatePresentation(
  readouts: LiveReadouts,
): PlaybackStatePresentation {
  const { playbackRate, playbackState, presentedRate } = readouts;

  if (playbackState === null) {
    return { label: "No renderer", tone: "idle" };
  }

  const named = namedPlaybackStates[playbackState];

  if (named) {
    return named;
  }

  if (isLiveAtClipEnd(readouts)) {
    return { label: "Ended", tone: "idle" };
  }

  if (
    presentedRate !== null &&
    !isPlaybackRateSustained(playbackRate, presentedRate)
  ) {
    return {
      label: `${formatMeasuredRate(presentedRate)} of ${formatPlaybackRate(playbackRate)}`,
      tone: "waiting",
    };
  }

  if (playbackState !== MediaRendererPlaybackState.Playing) {
    return { label: "Paused", tone: "idle" };
  }

  /* Nothing measured yet is not a verdict. The rate that was asked for is still
   * worth naming, but without the word that would claim it is being kept. */
  if (presentedRate === null) {
    return { label: `${formatPlaybackRate(playbackRate)} asked`, tone: "idle" };
  }

  /* A kept rate is named rather than measured, so the chip states a verdict
   * that holds instead of a figure that rewrites itself several times a
   * second. */
  return {
    label: `${formatPlaybackRate(playbackRate)} sustained`,
    tone: "live",
  };
}

/** A rate read off the picture, which lands anywhere; a commanded rate is a
 *  ladder rung and renders through `formatPlaybackRate` exactly as asked. */
function formatMeasuredRate(rate: number) {
  return `${rate.toFixed(1)}x`;
}
