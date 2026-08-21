import type { PixiBoxLayerState } from "./pixi-box-layer";
import type { PixiRegionLayerState } from "./pixi-region-layer";
import type { PresentedVideoFrame } from "./presented-frame-channel";

/**
 * The present's timestamp tripwire, armed in every build including production.
 * It is around eleven comparisons per presented frame, and it is what fails
 * loudly the day a refactor hands one step a time of its own instead of
 * silently putting annotations from one moment over pixels from another.
 */
const PRESENT_TIMESTAMP_TRIPWIRE_ENABLED = true;

type PresentedFrameStamp = Pick<PresentedVideoFrame, "frameId" | "mediaTimeS">;

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
 * The media time is the one the producer published for the frame these pixels
 * are, and it is the only time any step below sees. Nothing here awaits, so no
 * other frame can be presented between the pixel upload and the annotations
 * drawn over it, and nothing here consults a wall clock, a playhead getter or
 * a store, so no step can disagree with the pixels about which moment is on
 * screen. One render closes the block, after every layer has drawn; the frame
 * is closed on the way out, once, by its only owner.
 */
export function presentVideoFrame(
  presented: PresentedVideoFrame,
  targets: FramePresentTargets,
): void {
  const mediaTime = presented.mediaTimeS;
  const { layers } = targets;

  try {
    at(targets.adoptMediaTime, mediaTime, presented);
    targets.fitMediaScene();
    targets.uploadFrame(presented.frame);

    maybeAt(layers.drawMask, mediaTime, presented);
    const boxState = at(layers.drawBox, mediaTime, presented);
    maybeAt(layers.drawPolygon, mediaTime, presented);
    at(layers.drawVector, mediaTime, presented);
    const regionState = at(layers.drawRegion, mediaTime, presented);
    maybeAt(layers.drawInteraction, mediaTime, presented);
    at(layers.drawFocus, mediaTime, presented);
    at(layers.advanceFocus, mediaTime, presented);
    at(layers.drawInteractionPresentation, mediaTime, presented);
    maybeAt(layers.drawLabel, mediaTime, presented);
    at(layers.drawAnnotationOverlay, mediaTime, presented);

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
  presented: PresentedFrameStamp,
): void {
  if (
    !PRESENT_TIMESTAMP_TRIPWIRE_ENABLED ||
    mediaTime === presented.mediaTimeS
  ) {
    return;
  }

  throw new Error(
    `Presented frame ${presented.frameId.index} at ${presented.mediaTimeS}s drew a layer at ${mediaTime}s.`,
  );
}

function at<T>(
  step: (mediaTime: number) => T,
  mediaTime: number,
  presented: PresentedFrameStamp,
): T {
  assertPresentedTimestamp(mediaTime, presented);
  return step(mediaTime);
}

function maybeAt(
  step: ((mediaTime: number) => void) | undefined,
  mediaTime: number,
  presented: PresentedFrameStamp,
): void {
  if (!step) {
    return;
  }

  assertPresentedTimestamp(mediaTime, presented);
  step(mediaTime);
}
