import { SourceKind, VideoEngine } from "@roboflow/video-engine";
import type { EngineReadySnapshot } from "@roboflow/video-engine";
import type {
  DecodedMediaSource,
  DecodedMediaSourceMetadata,
  DecodedVideoSampleSink,
  MediaRendererSource,
} from "supervision";

const MILLISECONDS_PER_SECOND = 1000;

export interface EngineMediaSource extends MediaRendererSource {
  /** The engine behind the last `open()`, for driving playback from the demo. */
  getEngine(): VideoEngine | null;
}

/** How the scene finds the presented-frame plane on an opened source. */
interface EnginePresentedMediaSource extends DecodedMediaSource {
  readonly engine: VideoEngine;
}

/**
 * A renderer source backed by the video engine in frames presentation. The
 * engine paints nothing and announces every frame that earns the screen; the
 * scene finds that plane as `engine` and composites the frames itself.
 */
export function createEngineMediaSource(url: string): EngineMediaSource {
  let engine: VideoEngine | null = null;

  return {
    getEngine() {
      return engine;
    },

    async open(): Promise<DecodedMediaSource> {
      const opened = new VideoEngine({
        presentation: "frames",
        source: { kind: SourceKind.Url, url },
      });

      try {
        const snapshot = await opened.load();
        engine = opened;
        const source: EnginePresentedMediaSource = {
          engine: opened,
          input: {
            dispose() {
              engine = null;
              void opened.dispose();
            },
          },
          metadata: createMetadata(snapshot),
          sampleSink: pushOnlySampleSink,
        };

        return source;
      } catch (error) {
        await opened.dispose();
        throw error;
      }
    },
  };
}

/** Nothing to pull: the engine decides which frame is on screen and pushes it. */
const pushOnlySampleSink: DecodedVideoSampleSink = {
  async getSample() {
    return null;
  },
  async *samples() {},
};

function createMetadata(
  snapshot: EngineReadySnapshot,
): DecodedMediaSourceMetadata {
  const duration = Number.isFinite(snapshot.durationMs)
    ? snapshot.durationMs / MILLISECONDS_PER_SECOND
    : null;

  return {
    audioTrackCount: 0,
    canRead: snapshot.canDecode,
    duration,
    estimatedFrameRate: snapshot.nativeFps,
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
