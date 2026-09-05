import type {
  DecodedMediaSource,
  DecodedMediaSourceMetadata,
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";
import type { PresentedFrameChannel } from "#renderers/presented-frame-channel";
import type { MediaRendererSource } from "#types/media-renderer";
import type {
  BlobVideoSource,
  DecodeResolutionStrategy,
  DisplayBoxResolutionOptions,
  EngineReadySnapshot,
  UrlVideoSource,
  WebVideoEngine,
  WebVideoEngineOptions,
} from "#web-video-engine";
import type {
  AnalysisSession,
  ExtractedFrame,
} from "#web-video-engine/analysis";
import { MediaSourceError, toMediaSourceError } from "#media/media-errors";
import { MediaErrorKind } from "supervision-js-core";

import { resolveDisplayPixelRatio } from "./display-pixel-ratio";
import {
  rethrowEngineImportFailure,
  VIDEO_ENGINE_ANALYSIS_ENTRY,
  VIDEO_ENGINE_ENTRY,
} from "./engine-import-failure";

const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_FRAME_RATE = 30;
const TIMESTAMP_EPSILON_SECONDS = 1e-6;
const FRAMES_PRESENTATION_PREVIEW_MAX_WIDTH_PX = 320;

export interface WebVideoEngineMediaSourceOptions extends Omit<
  WebVideoEngineOptions,
  "presentation" | "source"
> {
  /**
   * The video to open. Two readers open it here, so it has to be one that can
   * be opened twice: the worker-backed engine decodes playback and scrubbing,
   * and the analysis session behind `sampleSink` decodes thumbnails and one-off
   * grabs from scratch. A URL re-fetches and a Blob re-reads. A ReadableStream
   * yields its bytes once, and the engine's load transfers it to the worker,
   * which detaches it here, so the pull path would be left with nothing to
   * read; pass one to {@link WebVideoEngine} directly instead.
   */
  readonly source: UrlVideoSource | BlobVideoSource;
  /**
   * The box a compositor paints these frames into, in CSS pixels, with the
   * viewer's device pixel ratio.
   *
   * This source runs the engine canvas-less, so nothing on the engine side ever
   * measures a display box and its viewport strategy has nothing to read: left
   * unsaid, frames decode at the source's full resolution however small the box
   * is. Saying it here decodes at the size the frames are actually shown at,
   * which cuts per-frame paint work and buys the scrub cache more slots at the
   * cost of preview sharpness while scrubbing. An explicit `decodeStrategy`
   * wins over this.
   */
  readonly display?: DisplayBoxResolutionOptions;
  /**
   * Sizes the frames the pull path decodes. The inherited `decodeStrategy`
   * sizes what the engine decodes for its own presentation.
   */
  readonly frameDecodeStrategy?: DecodeResolutionStrategy;
}

export interface WebVideoEngineMediaSource extends DecodedMediaSource {
  /**
   * The loaded engine. Naming the renderer's channel in the type is what fails
   * the build if the engine's transport stops answering that seam.
   */
  readonly engine: WebVideoEngine & PresentedFrameChannel;
}

/**
 * Adapts the web video engine to the decoded-media source seam.
 *
 * The pull path, `sampleSink`, serves one-off reads such as thumbnails and
 * single frame grabs, decoding each request from scratch through the engine's
 * batch analysis entry. The push path serves playback and scrub presentation:
 * the engine holds no canvas, paints nothing, and announces every frame that
 * earns the screen, so a compositor subscribes to `engine` and never pulls
 * samples here.
 */
export async function openWebVideoEngineMediaSource(
  options: WebVideoEngineMediaSourceOptions,
): Promise<WebVideoEngineMediaSource> {
  if ("stream" in options.source) {
    throw new MediaSourceError(
      MediaErrorKind.Unreadable,
      "This media source decodes playback and one-off frame grabs from two readers of the video, so it needs one that opens twice: a URL or a Blob. A ReadableStream yields its bytes once.",
    );
  }

  let engine: WebVideoEngine | undefined;
  let retainedFrames:
    ReturnType<typeof retainFramesUntilSubscribed> | undefined;

  try {
    const { WebVideoEngine, displayBoxResolution } = await importEngineEntry();
    const { display, frameDecodeStrategy, ...engineOptions } = options;
    engine = new WebVideoEngine({
      decodeStrategy: display ? displayBoxResolution(display) : undefined,
      previewWidth: framesPreviewWidth(display),
      ...engineOptions,
      presentation: "frames",
    });
    const openedEngine = engine;
    // The engine can present its seed before open() returns and before the
    // renderer can register. Retain only the newest frame across that gap.
    retainedFrames = retainFramesUntilSubscribed(openedEngine);
    const snapshot = await openedEngine.load();
    const frames = createAnalysisFrameReader({
      decodeStrategy: frameDecodeStrategy,
      frameDuration: resolveFrameDuration(snapshot.nativeFps),
      source: options.source,
    });

    return {
      engine: openedEngine,
      input: {
        dispose() {
          retainedFrames?.dispose();
          void frames.close();
          void openedEngine.dispose();
        },
      },
      metadata: createMetadata(snapshot),
      sampleSink: frames.sampleSink,
    };
  } catch (error) {
    retainedFrames?.dispose();
    await engine?.dispose();
    throw toWebVideoEngineMediaSourceError(error);
  }
}

function retainFramesUntilSubscribed(engine: WebVideoEngine) {
  type PresentedFrameHandler = Parameters<
    WebVideoEngine["onPresentedFrame"]
  >[0];
  const registerUpstream = engine.onPresentedFrame.bind(engine);
  let downstream: PresentedFrameHandler | null = null;
  let pending: Parameters<PresentedFrameHandler>[0] | null = null;
  let disposed = false;

  registerUpstream((presented) => {
    if (disposed) {
      presented.frame.close();
      return;
    }
    if (downstream) {
      downstream(presented);
      return;
    }
    pending?.frame.close();
    pending = presented;
  });

  engine.onPresentedFrame = (handler) => {
    downstream = handler;
    const retained = pending;
    pending = null;
    if (retained) handler(retained);
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.frame.close();
      pending = null;
      downstream = (presented) => presented.frame.close();
    },
  };
}

function toWebVideoEngineMediaSourceError(error: unknown): MediaSourceError {
  if (
    error instanceof DOMException &&
    (error.name === "SecurityError" || error.name === "NotSupportedError")
  ) {
    return new MediaSourceError(
      MediaErrorKind.EnvironmentUnsupported,
      "The browser environment could not start the web video engine worker.",
      { cause: error },
    );
  }
  return toMediaSourceError(error, "Unable to open this video source.");
}

export function createWebVideoEngineMediaRendererSource(
  options: WebVideoEngineMediaSourceOptions,
): MediaRendererSource {
  return {
    open() {
      return openWebVideoEngineMediaSource(options);
    },
  };
}

/**
 * The engine ships inside this package, and arrives through a dynamic import so
 * that it lands in its own chunk: a consumer who only annotates images never
 * downloads the engine's embedded decode worker. A static import would fold it
 * into the main entry.
 */
async function importEngineEntry() {
  try {
    return await import("#web-video-engine");
  } catch (error) {
    rethrowEngineImportFailure(error, VIDEO_ENGINE_ENTRY);
  }
}

async function importAnalysisEntry() {
  try {
    return await import("#web-video-engine/analysis");
  } catch (error) {
    rethrowEngineImportFailure(error, VIDEO_ENGINE_ANALYSIS_ENTRY);
  }
}

/**
 * A wider coarse frame means fewer of them resident, and residency is what a
 * drag spends: a scrub position holding no coarse frame paints nothing until a
 * full decode returns. A stated box only ever lowers the width, since a preview
 * wider than the picture it stands in for buys no sharpness and costs resident
 * frames.
 */
function framesPreviewWidth(
  display: DisplayBoxResolutionOptions | undefined,
): number {
  if (display === undefined || !(display.boxWidth > 0)) {
    return FRAMES_PRESENTATION_PREVIEW_MAX_WIDTH_PX;
  }

  return Math.min(
    FRAMES_PRESENTATION_PREVIEW_MAX_WIDTH_PX,
    Math.ceil(display.boxWidth * resolveDisplayPixelRatio(display)),
  );
}

function createAnalysisFrameReader(options: {
  readonly decodeStrategy: DecodeResolutionStrategy | undefined;
  readonly frameDuration: number;
  readonly source: WebVideoEngineMediaSourceOptions["source"];
}) {
  let sessionPromise: Promise<AnalysisSession> | undefined;
  let closed = false;

  const openSession = () => {
    sessionPromise ??= (async () => {
      try {
        const { AnalysisSession } = await importAnalysisEntry();
        return await AnalysisSession.open({
          decodeStrategy: options.decodeStrategy,
          source: options.source,
        });
      } catch (error) {
        throw toMediaSourceError(error, "Unable to open video frame analysis.");
      }
    })();
    return sessionPromise;
  };

  const extractAt = async (
    timestamp: number,
  ): Promise<ExtractedFrame | null> => {
    if (closed) return null;
    try {
      const session = await openSession();
      const [frame] = await session.extractFrames([timestamp]);
      return frame ?? null;
    } catch (error) {
      throw toMediaSourceError(error, "Unable to decode this video frame.");
    }
  };

  const sampleSink: DecodedVideoSampleSink = {
    async getSample(timestamp) {
      const frame = await extractAt(timestamp);
      return frame ? createSample(frame, options.frameDuration) : null;
    },
    async *samples(
      startTimestamp = 0,
      endTimestamp = Number.POSITIVE_INFINITY,
    ) {
      let cursor = startTimestamp;
      let lastTimestamp = Number.NEGATIVE_INFINITY;

      while (cursor <= endTimestamp) {
        const frame = await extractAt(cursor);
        if (!frame) return;
        // The analysis entry answers with the frame on screen at the requested
        // timestamp, so a request past the last frame answers with that frame
        // again. A timestamp that does not advance is the end of the track.
        if (frame.timestampS <= lastTimestamp + TIMESTAMP_EPSILON_SECONDS) {
          return;
        }

        lastTimestamp = frame.timestampS;
        cursor = Math.max(cursor, frame.timestampS) + options.frameDuration;
        yield createSample(frame, options.frameDuration);
      }
    },
    async *samplesAtTimestamps(timestamps) {
      if (closed) return;
      try {
        const session = await openSession();
        for await (const frame of session.framesAtTimestamps([...timestamps])) {
          yield frame ? createSample(frame, options.frameDuration) : null;
        }
      } catch (error) {
        throw toMediaSourceError(error, "Unable to decode these video frames.");
      }
    },
  };

  const close = async () => {
    closed = true;
    const opening = sessionPromise;
    sessionPromise = undefined;
    if (!opening) return;

    try {
      const session = await opening;
      await session.close();
    } catch {
      // A session that failed to open already rejected the pull that opened it.
    }
  };

  return { close, sampleSink };
}

function createSample(
  frame: ExtractedFrame,
  duration: number,
): DecodedVideoSample {
  let closed = false;

  return {
    close() {
      closed = true;
    },
    draw(context, dx, dy, dWidth = frame.width, dHeight = frame.height) {
      if (closed)
        throw new Error("Cannot draw a closed web video engine frame.");
      context.drawImage(frame.canvas, dx, dy, dWidth, dHeight);
    },
    duration,
    timestamp: frame.timestampS,
  };
}

function createMetadata(
  snapshot: EngineReadySnapshot,
): DecodedMediaSourceMetadata {
  const duration = Number.isFinite(snapshot.durationMs)
    ? snapshot.durationMs / MILLISECONDS_PER_SECOND
    : null;
  const estimatedFrameRate =
    snapshot.nativeFps !== null && snapshot.nativeFps > 0
      ? snapshot.nativeFps
      : null;

  return {
    audioTrackCount: 0,
    canRead: snapshot.canDecode,
    duration,
    estimatedFrameCount:
      duration !== null && estimatedFrameRate !== null
        ? Math.max(1, Math.round(duration * estimatedFrameRate))
        : null,
    estimatedFrameRate,
    firstTimestamp: snapshot.firstTimestampMs / MILLISECONDS_PER_SECOND,
    formatMimeType: null,
    formatName: "video-engine",
    mimeType: null,
    primaryVideoHeight: snapshot.naturalHeight,
    primaryVideoWidth: snapshot.naturalWidth,
    trackCount: 1,
    videoTrackCount: 1,
  };
}

function resolveFrameDuration(nativeFps: number | null) {
  return nativeFps !== null && nativeFps > 0
    ? 1 / nativeFps
    : 1 / DEFAULT_FRAME_RATE;
}
