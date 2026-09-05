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
  [MediaErrorKind.Decode]:
    "This video stopped partway through. The file may be damaged.",
  [MediaErrorKind.EnvironmentUnsupported]:
    "This browser is missing an API this video needs. Try the latest Chrome or Edge.",
  [MediaErrorKind.Network]:
    "This video could not be downloaded. Check the link and try again.",
  [MediaErrorKind.NoVideoTrack]:
    "This file holds no video, only other kinds of track.",
  [MediaErrorKind.Unknown]: null,
  [MediaErrorKind.Unreadable]:
    "This file is not in a format we can open. Convert it to MP4 and try again.",
  [MediaErrorKind.UnsupportedFormat]:
    "The video in this file is in a format we cannot play. Convert it to H.264 MP4 and try again.",
};

export function mediaFailureHeadline(
  kind: MediaErrorKind | null | undefined,
): string | null {
  return kind ? HEADLINES[kind] : null;
}
