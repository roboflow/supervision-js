import { MediaErrorKind } from "supervision";

/**
 * Viewer-facing headline for each failure the library classifies. Its
 * `errorMessage` is diagnostic text naming engine internals and the codec,
 * which the detail line under this headline carries.
 *
 * An unclassified failure has no headline: the reporting subsystem's label and
 * that diagnostic say more than a generic sentence would.
 */
const HEADLINES: Record<MediaErrorKind, string | null> = {
  [MediaErrorKind.Decode]: "This video stopped decoding",
  [MediaErrorKind.EnvironmentUnsupported]:
    "This browser is missing an API this video needs",
  [MediaErrorKind.Network]: "This video could not be downloaded",
  [MediaErrorKind.NoVideoTrack]: "This file has no video track",
  [MediaErrorKind.Unknown]: null,
  [MediaErrorKind.Unreadable]: "This file could not be opened",
  [MediaErrorKind.UnsupportedFormat]: "This browser cannot decode this video",
};

export function mediaFailureHeadline(
  kind: MediaErrorKind | null | undefined,
): string | null {
  return kind ? HEADLINES[kind] : null;
}
