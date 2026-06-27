import type { MediaNormalizationInputMetadata } from "#types/media-normalization";

export interface MediaMetadataVideoTrack {
  canDecode?(): Promise<boolean>;
  getCodec?(): Promise<string | null>;
  getDisplayHeight(): Promise<number>;
  getDisplayWidth(): Promise<number>;
}

export interface MediaMetadataInput {
  canRead?(): Promise<boolean>;
  getDurationFromMetadata(
    tracks?: unknown,
    options?: { skipLiveWait?: boolean },
  ): Promise<number | null>;
  getFormat(): Promise<{ mimeType?: string; name?: string }>;
  getMimeType(): Promise<string | null>;
  getPrimaryVideoTrack(): Promise<MediaMetadataVideoTrack | null>;
}

export async function collectInputMetadata(
  input: MediaMetadataInput,
  source: Blob,
): Promise<MediaNormalizationInputMetadata> {
  const [format, detectedMimeType, duration, primaryVideoTrack] =
    await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
      input.getPrimaryVideoTrack(),
    ]);

  const [primaryVideoWidth, primaryVideoHeight] = primaryVideoTrack
    ? await Promise.all([
        primaryVideoTrack.getDisplayWidth(),
        primaryVideoTrack.getDisplayHeight(),
      ])
    : [null, null];

  return {
    detectedMimeType,
    duration,
    formatMimeType: format.mimeType ?? null,
    formatName: format.name ?? null,
    primaryVideoHeight,
    primaryVideoWidth,
    sourceMimeType: source.type || null,
  };
}
