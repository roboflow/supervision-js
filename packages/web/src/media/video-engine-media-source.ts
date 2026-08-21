import type {
  DecodedMediaSource,
  DecodedMediaSourceMetadata,
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";
import type { PresentedFrameChannel } from "#renderers/presented-frame-channel";
import type { MediaRendererSource } from "#types/media-renderer";
import type {
  DecodeResolutionStrategy,
  DisplayBoxResolutionOptions,
  EngineReadySnapshot,
  VideoEngine,
  VideoEngineOptions,
  VideoSource,
} from "supervision-js-video-engine";
import type {
  AnalysisSession,
  ExtractedFrame,
} from "supervision-js-video-engine/analysis";

const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_FRAME_RATE = 30;
const TIMESTAMP_EPSILON_SECONDS = 1e-6;
const FRAMES_PRESENTATION_PREVIEW_MAX_WIDTH_PX = 320;
const DEFAULT_MAX_DEVICE_PIXEL_RATIO = 2;

export interface VideoEngineMediaSourceOptions extends Omit<
  VideoEngineOptions,
  "presentation"
> {
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

export interface VideoEngineMediaSource extends DecodedMediaSource {
  /**
   * The loaded engine. Naming the renderer's channel in the type is what fails
   * the build if the engine's transport stops answering that seam.
   */
  readonly engine: VideoEngine & PresentedFrameChannel;
}

/**
 * Adapts Roboflow's video engine to the decoded-media source seam.
 *
 * The pull path, `sampleSink`, serves one-off reads such as thumbnails and
 * single frame grabs, decoding each request from scratch through the engine's
 * batch analysis entry. The push path serves playback and scrub presentation:
 * the engine holds no canvas, paints nothing, and announces every frame that
 * earns the screen, so a compositor subscribes to `engine` and never pulls
 * samples here.
 */
export async function openVideoEngineMediaSource(
  options: VideoEngineMediaSourceOptions,
): Promise<VideoEngineMediaSource> {
  // The engine arrives via dynamic import so the package entry stays loadable
  // for consumers that never open a video-engine source: the specifier is
  // external to the build, and a static import would make resolving it a
  // precondition of importing the package at all.
  const { VideoEngine, displayBoxResolution } =
    await import("supervision-js-video-engine");
  const { display, frameDecodeStrategy, ...engineOptions } = options;
  const engine = new VideoEngine({
    decodeStrategy: display ? displayBoxResolution(display) : undefined,
    previewWidth: framesPreviewWidth(display),
    ...engineOptions,
    presentation: "frames",
  });

  try {
    const snapshot = await engine.load();
    const frames = createAnalysisFrameReader({
      decodeStrategy: frameDecodeStrategy,
      frameDuration: resolveFrameDuration(snapshot.nativeFps),
      source: options.source,
    });

    return {
      engine,
      input: {
        dispose() {
          void frames.close();
          void engine.dispose();
        },
      },
      metadata: createMetadata(options.source, snapshot),
      sampleSink: frames.sampleSink,
    };
  } catch (error) {
    await engine.dispose();
    throw error;
  }
}

export function createVideoEngineMediaRendererSource(
  options: VideoEngineMediaSourceOptions,
): MediaRendererSource {
  return {
    open() {
      return openVideoEngineMediaSource(options);
    },
  };
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

  const devicePixelRatio = Math.min(
    display.devicePixelRatio > 0 ? display.devicePixelRatio : 1,
    display.maxDevicePixelRatio ?? DEFAULT_MAX_DEVICE_PIXEL_RATIO,
  );

  return Math.min(
    FRAMES_PRESENTATION_PREVIEW_MAX_WIDTH_PX,
    Math.ceil(display.boxWidth * devicePixelRatio),
  );
}

function createAnalysisFrameReader(options: {
  readonly decodeStrategy: DecodeResolutionStrategy | undefined;
  readonly frameDuration: number;
  readonly source: VideoSource;
}) {
  let sessionPromise: Promise<AnalysisSession> | undefined;
  let closed = false;

  const openSession = () => {
    sessionPromise ??= import("supervision-js-video-engine/analysis").then(
      ({ AnalysisSession }) =>
        AnalysisSession.open({
          decodeStrategy: options.decodeStrategy,
          source: options.source,
        }),
    );
    return sessionPromise;
  };

  const extractAt = async (
    timestamp: number,
  ): Promise<ExtractedFrame | null> => {
    if (closed) return null;
    const session = await openSession();
    const [frame] = await session.extractFrames([timestamp]);
    return frame ?? null;
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
      if (closed) throw new Error("Cannot draw a closed video engine frame.");
      context.drawImage(frame.canvas, dx, dy, dWidth, dHeight);
    },
    duration,
    timestamp: frame.timestampS,
  };
}

function createMetadata(
  source: VideoSource,
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
    mimeType: "stream" in source ? source.mimeType : null,
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
