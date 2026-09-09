import type { SourceResidencyDiagnostics } from "supervision/web-video-engine";

import type { TimelineRange } from "../session/demo-session-types";

const BYTES_PER_MEBIBYTE = 1024 * 1024;

export const SOURCE_RESIDENCY_TOOLTIP =
  "The stretches of the video file this page is holding, so a seek into one costs no network at all. It counts what this session has pulled since it opened and nothing else: the browser may still be holding more from an earlier visit, and there is no way to ask it. The engine keeps bytes only when Source residency is Hold or Prefetch in the Session panel, or the matching URL override selects one; this reads off otherwise. Each band is placed by its bytes' share of the file, so its edges land within the bitrate's own variation of the moment they name rather than on a frame.";

/**
 * Places held byte runs on the clock by their share of the file. Offsets are all
 * residency sees, because every read it serves is the demuxer asking for bytes,
 * so a run's edge lands within the bitrate's own variation of the moment it
 * names.
 */
export function readSourceResidencyRanges(
  residency: SourceResidencyDiagnostics | null,
  duration: number | null,
): readonly TimelineRange[] {
  if (
    residency === null ||
    residency.totalBytes === null ||
    residency.totalBytes <= 0 ||
    duration === null ||
    duration <= 0
  ) {
    return [];
  }

  const secondsPerByte = duration / residency.totalBytes;

  return residency.ranges.map((range) => ({
    endTime: range.end * secondsPerByte,
    startTime: range.start * secondsPerByte,
  }));
}

/**
 * A lane drawing nothing because the feature is off looks exactly like one
 * drawing nothing because the file is unread, so the reading says which.
 */
export function formatSourceResidency(
  residency: SourceResidencyDiagnostics | null,
): string {
  if (residency === null) {
    return "off";
  }

  const held = `${(residency.residentBytes / BYTES_PER_MEBIBYTE).toFixed(1)} MiB`;
  const warming = residency.warming ? " · filling" : "";

  if (residency.totalBytes === null || residency.totalBytes <= 0) {
    return `${held}${warming}`;
  }

  const share = Math.round(
    (residency.residentBytes / residency.totalBytes) * 100,
  );

  return `${share}% · ${held}${warming}`;
}
