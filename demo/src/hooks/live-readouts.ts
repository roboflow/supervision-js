import { useEffect, useRef } from "react";
import type {
  DetectionBufferState,
  MediaRendererPlaybackState,
  MediaRendererState,
  RenderPreparationDiagnostics,
} from "supervision";

/** Everything on the control bar that changes while the picture moves. */
export interface LiveReadouts {
  readonly activeDetectionFrameTime: number | null;
  readonly currentTime: number | null;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly duration: number | null;
  readonly playbackRate: number;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly presentedRate: number | null;
  readonly renderPreparation: RenderPreparationDiagnostics | null;
  /** The playhead has moved somewhere the picture has not reached yet. */
  readonly seeking: boolean;
  readonly sourceFrameRate: number | null;
}

export type LiveReadoutWriter = (readouts: LiveReadouts) => void;

/** Whether a writer changes a figure someone reads, or geometry they only see. */
export type LiveReadoutCadence = "geometry" | "text";

const idleReadouts: LiveReadouts = {
  activeDetectionFrameTime: null,
  currentTime: null,
  detectionBuffer: null,
  duration: null,
  playbackRate: 1,
  playbackState: null,
  presentedRate: null,
  renderPreparation: null,
  seeking: false,
  sourceFrameRate: null,
};

/**
 * How often the readouts may be rewritten while the picture is moving. Every
 * frame that writes anything at all is charged a style pass, a layout and a
 * paint per element touched, so the cadence is the whole cost. Measured on this
 * page during steady playback: 50ms costs 85 paints a second, 100ms costs 47,
 * and the publisher this replaced ran at 250ms and read as deferred. A hundred
 * is the knee: ten readings a second is continuous to the eye rather than
 * stepped, and no reading is more than three presented frames old.
 */
const MOVING_INTERVAL_MS = 100;

/**
 * How often they may be rewritten when the only thing that moved is background
 * work. A cook filling behind a stopped picture has no frame rate to keep up
 * with, and this is the rate the readouts have always been published at.
 */
const BACKGROUND_INTERVAL_MS = 250;

/**
 * How often a writer that moves geometry rather than text may run. A band edge
 * or a marker carries no figure to read, so it buys nothing from matching the
 * rate of a changing number, and each one costs its own paint. Two hundred
 * milliseconds keeps a band within a pixel or two of the playhead.
 */
const GEOMETRY_INTERVAL_MS = 200;

let readouts = idleReadouts;
let serial = 0;
let writtenSerial = 0;
let writtenAt = Number.NEGATIVE_INFINITY;
let pendingIntervalMs = BACKGROUND_INTERVAL_MS;
let frameHandle: number | undefined;
const writers = new Set<LiveReadoutWriter>();
const geometryWriters = new Set<LiveReadoutWriter>();
let geometryWrittenAt = Number.NEGATIVE_INFINITY;

/**
 * Every readout is written in one pass on one frame. A style pass, a layout and
 * two paints are charged per frame that writes anything at all, not per value
 * written, so readouts spread across separate frames cost a multiple of the same
 * picture.
 */
const writeFrame = () => {
  frameHandle = undefined;

  if (writtenSerial === serial) {
    return;
  }

  const now = performance.now();

  if (now - writtenAt < pendingIntervalMs) {
    frameHandle = requestAnimationFrame(writeFrame);
    return;
  }

  writtenAt = now;
  writtenSerial = serial;
  pendingIntervalMs = BACKGROUND_INTERVAL_MS;

  for (const write of writers) {
    write(readouts);
  }

  if (now - geometryWrittenAt < GEOMETRY_INTERVAL_MS) {
    return;
  }

  geometryWrittenAt = now;

  for (const write of geometryWriters) {
    write(readouts);
  }
};

const scheduleWrite = (intervalMs: number) => {
  serial += 1;
  pendingIntervalMs = Math.min(pendingIntervalMs, intervalMs);

  if (frameHandle === undefined && writers.size > 0) {
    frameHandle = requestAnimationFrame(writeFrame);
  }
};

export function publishLiveRendererState(
  state: MediaRendererState,
  presentedRate: number | null,
) {
  readouts = {
    ...readouts,
    activeDetectionFrameTime: state.activeDetectionFrameTime,
    currentTime: state.currentTime,
    detectionBuffer: state.detectionBuffer,
    duration: state.duration,
    playbackRate: state.playbackRate,
    playbackState: state.playbackState,
    presentedRate,
    seeking: state.seeking === true,
    sourceFrameRate: state.source.estimatedFrameRate ?? null,
  };
  scheduleWrite(MOVING_INTERVAL_MS);
}

export function publishLiveRenderPreparation(
  diagnostics: RenderPreparationDiagnostics,
) {
  readouts = { ...readouts, renderPreparation: diagnostics };
  scheduleWrite(BACKGROUND_INTERVAL_MS);
}

export function clearLiveReadouts() {
  readouts = idleReadouts;
  scheduleWrite(MOVING_INTERVAL_MS);
}

export function readLiveReadouts() {
  return readouts;
}

export function subscribeLiveReadouts(
  write: LiveReadoutWriter,
  cadence: LiveReadoutCadence = "text",
) {
  const set = cadence === "geometry" ? geometryWriters : writers;

  set.add(write);
  write(readouts);

  return () => {
    set.delete(write);

    if (
      writers.size === 0 &&
      geometryWriters.size === 0 &&
      frameHandle !== undefined
    ) {
      cancelAnimationFrame(frameHandle);
      frameHandle = undefined;
    }
  };
}

/**
 * Runs `write` against the live readouts on every frame that carries new
 * numbers, and once on mount so a readout is never blank waiting for the next
 * one. `write` is read through a ref, so a caller may close over fresh values
 * without resubscribing.
 */
export function useLiveReadoutWriter(
  write: LiveReadoutWriter,
  cadence: LiveReadoutCadence = "text",
) {
  const writeRef = useRef(write);

  useEffect(() => {
    writeRef.current = write;
  });

  useEffect(
    () => subscribeLiveReadouts((next) => writeRef.current(next), cadence),
    [cadence],
  );
}
