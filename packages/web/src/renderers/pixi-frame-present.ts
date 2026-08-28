import type { PixiBoxLayerState } from "./pixi-box-layer";
import type { PixiRegionLayerState } from "./pixi-region-layer";
import type {
  PresentedFrameId,
  PresentedVideoFrame,
} from "./presented-frame-channel";

/**
 * The present's timestamp tripwire, armed in every build including production.
 * It is around eleven comparisons per presented frame, and it is what fails
 * loudly the day a refactor hands one step a time of its own instead of
 * silently putting annotations from one moment over pixels from another.
 */
const PRESENT_TIMESTAMP_TRIPWIRE_ENABLED = true;

type PresentedFrameStamp = Pick<PresentedVideoFrame, "frameId" | "mediaTimeS">;

/**
 * Every drawing step of a present, each taking the media time in seconds. A
 * step that reads a time from anywhere but its argument breaks the guarantee
 * this module exists to hold.
 *
 * The mask step also takes the producer's name for the frame these pixels are,
 * because it is the one step that keeps a raster between presents and so is the
 * one step that can put a raster from one frame over the pixels of another. A
 * walk with no presented frame hands it null: a pull-path sample and a redraw
 * at a resting playhead both have a media time and no frame identity.
 */
export interface FramePresentLayers {
  readonly drawMask:
    | ((mediaTime: number, presentedFrameId: PresentedFrameId | null) => void)
    | undefined;
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

export interface FramePresentLayerStates {
  readonly boxState: PixiBoxLayerState;
  readonly regionState: PixiRegionLayerState;
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

    const { boxState, regionState } = drawFramePresentLayers(
      layers,
      mediaTime,
      presented,
    );

    targets.render();
    targets.completePresentation(mediaTime, boxState, regionState);
  } finally {
    presented.frame.close();
  }
}

/**
 * The one declaration of the draw order: a present walks it, and so does a
 * redraw at a resting playhead, so a layer cannot be in one sequence and be
 * missing or out of place in the other.
 *
 * A walk with no presented frame is not a present, and has no frame timestamp
 * to check its steps against.
 */
export function drawFramePresentLayers(
  layers: FramePresentLayers,
  mediaTime: number,
  presented?: PresentedFrameStamp,
): FramePresentLayerStates {
  maskAt(layers.drawMask, mediaTime, presented);
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

  return { boxState, regionState };
}

export type FramePresentStep = keyof FramePresentLayers;

/**
 * The steps a walk would take, each reporting its cost, so a present that
 * wants a timing breakdown still reads the one declared order.
 */
export function measureFramePresentLayers(
  layers: FramePresentLayers,
  measureStep: <T>(step: FramePresentStep, draw: () => T) => T,
): FramePresentLayers {
  const timed =
    <T>(step: FramePresentStep, draw: (mediaTime: number) => T) =>
    (mediaTime: number): T =>
      measureStep(step, () => draw(mediaTime));
  const maybeTimed = (
    step: FramePresentStep,
    draw: ((mediaTime: number) => void) | undefined,
  ) => (draw ? timed(step, draw) : undefined);
  const timedMask = (draw: FramePresentLayers["drawMask"]) =>
    draw
      ? (mediaTime: number, presentedFrameId: PresentedFrameId | null) =>
          measureStep("drawMask", () => draw(mediaTime, presentedFrameId))
      : undefined;

  return {
    advanceFocus: timed("advanceFocus", layers.advanceFocus),
    drawAnnotationOverlay: timed(
      "drawAnnotationOverlay",
      layers.drawAnnotationOverlay,
    ),
    drawBox: timed("drawBox", layers.drawBox),
    drawFocus: timed("drawFocus", layers.drawFocus),
    drawInteraction: maybeTimed("drawInteraction", layers.drawInteraction),
    drawInteractionPresentation: timed(
      "drawInteractionPresentation",
      layers.drawInteractionPresentation,
    ),
    drawLabel: maybeTimed("drawLabel", layers.drawLabel),
    drawMask: timedMask(layers.drawMask),
    drawPolygon: maybeTimed("drawPolygon", layers.drawPolygon),
    drawRegion: timed("drawRegion", layers.drawRegion),
    drawVector: timed("drawVector", layers.drawVector),
  };
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
  presented: PresentedFrameStamp | undefined,
): T {
  if (presented) assertPresentedTimestamp(mediaTime, presented);
  return step(mediaTime);
}

function maskAt(
  step: FramePresentLayers["drawMask"],
  mediaTime: number,
  presented: PresentedFrameStamp | undefined,
): void {
  if (!step) {
    return;
  }

  if (presented) assertPresentedTimestamp(mediaTime, presented);
  step(mediaTime, presented?.frameId ?? null);
}

function maybeAt(
  step: ((mediaTime: number) => void) | undefined,
  mediaTime: number,
  presented: PresentedFrameStamp | undefined,
): void {
  if (!step) {
    return;
  }

  if (presented) assertPresentedTimestamp(mediaTime, presented);
  step(mediaTime);
}
