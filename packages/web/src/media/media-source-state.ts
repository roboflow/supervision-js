import type { DecodedMediaSourceMetadata } from "./media-source";
import { MediaSourceStatus } from "#types/media-renderer";
import type { MediaSourceState } from "#types/media-renderer";

export function createLoadingMediaSourceState(): MediaSourceState {
  return {
    audioTrackCount: null,
    canRead: null,
    duration: null,
    firstTimestamp: null,
    errorMessage: null,
    formatMimeType: null,
    formatName: null,
    mimeType: null,
    primaryVideoHeight: null,
    primaryVideoWidth: null,
    status: MediaSourceStatus.Loading,
    trackCount: null,
    videoTrackCount: null,
  };
}

export function createReadyMediaSourceState(
  metadata: DecodedMediaSourceMetadata,
): MediaSourceState {
  return {
    audioTrackCount: metadata.audioTrackCount,
    canRead: metadata.canRead,
    duration: metadata.duration,
    firstTimestamp: metadata.firstTimestamp,
    errorMessage: null,
    formatMimeType: metadata.formatMimeType,
    formatName: metadata.formatName,
    mimeType: metadata.mimeType,
    primaryVideoHeight: metadata.primaryVideoHeight,
    primaryVideoWidth: metadata.primaryVideoWidth,
    status: MediaSourceStatus.Ready,
    trackCount: metadata.trackCount,
    videoTrackCount: metadata.videoTrackCount,
  };
}
