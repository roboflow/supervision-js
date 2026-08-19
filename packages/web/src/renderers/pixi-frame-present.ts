import type { PixiBoxLayerState } from "./pixi-box-layer";
import type { PixiRegionLayerState } from "./pixi-region-layer";
import type { PresentedVideoFrame } from "./presented-frame-channel";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The present's timestamp tripwire, armed in every build including production.
 * It is around eleven comparisons per presented frame, and it is what fails
 * loudly the day a refactor hands one step a time of its own instead of
 * silently putting annotations from one moment over pixels from another.
 */
const PRESENT_TIMESTAMP_TRIPWIRE_ENABLED = true;

/**
 * Every drawing step of a present, each taking the media time in seconds and
 * nothing else. A step that reads a time from anywhere but its argument breaks
 * the guarantee this module exists to hold.
 */
export interface FramePresentLayers {
  readonly drawMask: ((mediaTime: number) => void) | undefined;
  readonly drawBox: (mediaTime: number) => PixiBoxLayerState;
  readonly drawPolygon: ((mediaTime: number) => void) | undefined;
  readonly drawVector: (mediaTime: number) => void;
  readonly drawRegion: (mediaTime: number) => PixiRegionLayerState;
  readonly drawInteraction: ((mediaTime: number) => void) | undefined;
  readonly drawFocus: (mediaTime: number) => void;
  /** Moves the focus layer's fade to where the presented media time puts it. */
  readonly advanceFocus: (mediaTime: number) => void;
  readonly drawInteractionPresentation: (mediaTime: number) => void;
  readonly drawLabel: ((mediaTime: number) => void) | undefined;
  readonly drawAnnotationOverlay: (mediaTime: number) => void;
}

export interface FramePresentTargets {
  /** Adopts the presented time as the scene's media time, before anything draws. */
  readonly adoptMediaTime: (mediaTime: number) => void;
  readonly fitMediaScene: () => void;
  readonly uploadFrame: (frame: VideoFrame) => void;
  readonly layers: FramePresentLayers;
  readonly render: () => void;
  readonly completePresentation: (
    mediaTime: number,
    boxState: PixiBoxLayerState,
    regionState: PixiRegionLayerState,
  ) => void;
}

/**
 * The atomic present: one frame the producer put on screen becomes one screen.
 *
 * The media time is derived once, from the event, and is the only time any step
 * below sees. Nothing here awaits, so no other frame can be presented between
 * the pixel upload and the annotations drawn over it, and nothing here consults
 * a wall clock, a playhead getter or a store, so no step can disagree with the
 * pixels about which moment is on screen. One render closes the block, after
 * every layer has drawn; the frame is closed on the way out, once, by its only
 * owner.
 */
export function presentVideoFrame(
  presented: PresentedVideoFrame,
  targets: FramePresentTargets,
): void {
  const presentedMediaTimeMs = presented.mediaTimeMs;
  const mediaTime = presentedMediaTimeMs / MILLISECONDS_PER_SECOND;
  const { layers } = targets;

  try {
    at(targets.adoptMediaTime, mediaTime, presentedMediaTimeMs);
    targets.fitMediaScene();
    targets.uploadFrame(presented.frame);

    maybeAt(layers.drawMask, mediaTime, presentedMediaTimeMs);
    const boxState = at(layers.drawBox, mediaTime, presentedMediaTimeMs);
    maybeAt(layers.drawPolygon, mediaTime, presentedMediaTimeMs);
    at(layers.drawVector, mediaTime, presentedMediaTimeMs);
    const regionState = at(layers.drawRegion, mediaTime, presentedMediaTimeMs);
    maybeAt(layers.drawInteraction, mediaTime, presentedMediaTimeMs);
    at(layers.drawFocus, mediaTime, presentedMediaTimeMs);
    at(layers.advanceFocus, mediaTime, presentedMediaTimeMs);
    at(layers.drawInteractionPresentation, mediaTime, presentedMediaTimeMs);
    maybeAt(layers.drawLabel, mediaTime, presentedMediaTimeMs);
    at(layers.drawAnnotationOverlay, mediaTime, presentedMediaTimeMs);

    targets.render();
    targets.completePresentation(mediaTime, boxState, regionState);
  } finally {
    presented.frame.close();
  }
}

/**
 * Fails when a step is handed anything but the presented media time. It reads
 * as a tautology against the line above it, and that is the point: it is the
 * line that breaks when someone later gives one step a time of its own.
 */
export function assertPresentedTimestamp(
  mediaTime: number,
  presentedMediaTimeMs: number,
): void {
  if (
    !PRESENT_TIMESTAMP_TRIPWIRE_ENABLED ||
    mediaTime === presentedMediaTimeMs / MILLISECONDS_PER_SECOND
  ) {
    return;
  }

  throw new Error(
    `Presented frame at ${presentedMediaTimeMs}ms drew a layer at ${mediaTime}s.`,
  );
}

function at<T>(
  step: (mediaTime: number) => T,
  mediaTime: number,
  presentedMediaTimeMs: number,
): T {
  assertPresentedTimestamp(mediaTime, presentedMediaTimeMs);
  return step(mediaTime);
}

function maybeAt(
  step: ((mediaTime: number) => void) | undefined,
  mediaTime: number,
  presentedMediaTimeMs: number,
): void {
  if (!step) {
    return;
  }

  assertPresentedTimestamp(mediaTime, presentedMediaTimeMs);
  step(mediaTime);
}
