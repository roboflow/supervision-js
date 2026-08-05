import type { DecodedMediaSource } from "./media-source";
import type { MediaRendererSource } from "#types/media-renderer";
import type { InputFormat, Source } from "mediabunny";

export interface MediabunnyMediaSourceInput {
  readonly formats?: readonly InputFormat[];
  readonly metadata?: {
    readonly duration?: number | null;
  };
  readonly source: Source;
}

const FRAME_RATE_SAMPLE_PACKET_COUNT = 120;

export async function openMediabunnyMediaSource(
  sourceInput: string | URL | Request | MediabunnyMediaSourceInput,
): Promise<DecodedMediaSource> {
  const { Input, MATROSKA, MP4, QTFF, UrlSource, VideoSampleSink, WEBM } =
    await import("mediabunny");
  const source = isUrlSourceInput(sourceInput)
    ? new UrlSource(sourceInput)
    : sourceInput.source;
  const formats = isUrlSourceInput(sourceInput)
    ? [MP4, QTFF, WEBM, MATROSKA]
    : [...(sourceInput.formats ?? [MP4, QTFF, WEBM, MATROSKA])];
  const input = new Input({
    formats,
    source,
  });

  try {
    const canRead = await input.canRead();

    if (!canRead) {
      throw new Error("Mediabunny cannot read this media source.");
    }

    const [
      format,
      mimeType,
      metadataDuration,
      tracks,
      videoTracks,
      audioTracks,
    ] = await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
      input.getTracks(),
      input.getVideoTracks(),
      input.getAudioTracks(),
    ]);
    const primaryVideoTrack = await input.getPrimaryVideoTrack();

    if (!primaryVideoTrack) {
      throw new Error("No video track found in media source.");
    }

    const packetStatsPromise =
      typeof primaryVideoTrack.computePacketStats === "function"
        ? primaryVideoTrack
            .computePacketStats(FRAME_RATE_SAMPLE_PACKET_COUNT, {
              skipLiveWait: true,
            })
            .catch(() => null)
        : Promise.resolve(null);
    const [displayWidth, displayHeight, firstTimestamp, packetStats] =
      await Promise.all([
        primaryVideoTrack.getDisplayWidth(),
        primaryVideoTrack.getDisplayHeight(),
        primaryVideoTrack.getFirstTimestamp(),
        packetStatsPromise,
      ]);

    const duration = isUrlSourceInput(sourceInput)
      ? metadataDuration
      : (sourceInput.metadata?.duration ?? metadataDuration);
    const estimatedFrameRate =
      packetStats !== null &&
      Number.isFinite(packetStats.averagePacketRate) &&
      packetStats.averagePacketRate > 0
        ? packetStats.averagePacketRate
        : null;
    const estimatedFrameCount =
      duration !== null && estimatedFrameRate !== null
        ? Math.max(1, Math.round(duration * estimatedFrameRate))
        : null;

    return {
      input,
      metadata: {
        audioTrackCount: audioTracks.length,
        canRead,
        duration,
        estimatedFrameCount,
        estimatedFrameRate,
        firstTimestamp,
        formatMimeType: format.mimeType,
        formatName: format.name,
        mimeType,
        primaryVideoHeight: displayHeight,
        primaryVideoWidth: displayWidth,
        trackCount: tracks.length,
        videoTrackCount: videoTracks.length,
      },
      sampleSink: new VideoSampleSink(primaryVideoTrack),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

function isUrlSourceInput(
  input: string | URL | Request | MediabunnyMediaSourceInput,
): input is string | URL | Request {
  return (
    typeof input === "string" ||
    (typeof URL === "function" && input instanceof URL) ||
    (typeof Request === "function" && input instanceof Request)
  );
}

export function createMediabunnyMediaRendererSource(
  sourceInput: MediabunnyMediaSourceInput,
): MediaRendererSource {
  return {
    open() {
      return openMediabunnyMediaSource(sourceInput);
    },
  };
}
