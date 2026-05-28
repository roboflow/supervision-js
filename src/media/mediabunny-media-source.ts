import type { DecodedMediaSource } from "./media-source";

export async function openMediabunnyMediaSource(
  src: string,
): Promise<DecodedMediaSource> {
  const { Input, MATROSKA, MP4, QTFF, UrlSource, VideoSampleSink, WEBM } =
    await import("mediabunny");
  const input = new Input({
    formats: [MP4, QTFF, WEBM, MATROSKA],
    source: new UrlSource(src),
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

    return {
      input,
      metadata: {
        audioTrackCount: audioTracks.length,
        canRead,
        duration: metadataDuration,
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
