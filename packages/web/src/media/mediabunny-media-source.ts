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

export async function openMediabunnyMediaSource(
  sourceInput: string | MediabunnyMediaSourceInput,
): Promise<DecodedMediaSource> {
  const { Input, MATROSKA, MP4, QTFF, UrlSource, VideoSampleSink, WEBM } =
    await import("mediabunny");
  const source =
    typeof sourceInput === "string"
      ? new UrlSource(sourceInput)
      : sourceInput.source;
  const formats =
    typeof sourceInput === "string"
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

    const [displayWidth, displayHeight, firstTimestamp] = await Promise.all([
      primaryVideoTrack.getDisplayWidth(),
      primaryVideoTrack.getDisplayHeight(),
      primaryVideoTrack.getFirstTimestamp(),
    ]);

    const duration =
      typeof sourceInput === "string"
        ? metadataDuration
        : (sourceInput.metadata?.duration ?? metadataDuration);

    return {
      input,
      metadata: {
        audioTrackCount: audioTracks.length,
        canRead,
        duration,
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

export function createMediabunnyMediaRendererSource(
  sourceInput: MediabunnyMediaSourceInput,
): MediaRendererSource {
  return {
    open() {
      return openMediabunnyMediaSource(sourceInput);
    },
  };
}
