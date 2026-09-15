import { describe, expect, it } from "vitest";

import { MediaErrorKind } from "supervision-js-core";
import {
  MEDIA_PRODUCER_ERROR_CODES,
  MediaSourceError,
  getMediaErrorKind,
  isMediaSourceError,
  toMediaSourceError,
} from "#media/media-errors";

describe("media errors", () => {
  it("preserves the originating failure as the cause", () => {
    const cause = new Error("Mediabunny could not demux this file.");

    const error = toMediaSourceError(cause);

    expect(isMediaSourceError(error)).toBe(true);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Mediabunny could not demux this file.");
  });

  it("classifies vendor failures into stable kinds", () => {
    const cases: ReadonlyArray<[string, MediaErrorKind]> = [
      ["No matching decoder for this codec.", MediaErrorKind.UnsupportedFormat],
      ["Unsupported container.", MediaErrorKind.UnsupportedFormat],
      ["Failed to demux the track.", MediaErrorKind.Decode],
      ["Network request failed.", MediaErrorKind.Network],
      ["Something else entirely.", MediaErrorKind.Unknown],
    ];

    for (const [message, kind] of cases) {
      expect(toMediaSourceError(new Error(message)).kind).toBe(kind);
    }
  });

  it("reads an engine refusal's own code rather than its message", () => {
    const cases: ReadonlyArray<[string, string, MediaErrorKind]> = [
      [
        "CONTAINER_UNREADABLE",
        "openInput: the demuxer does not read this file's container",
        MediaErrorKind.Unreadable,
      ],
      [
        "VIDEO_TRACK_UNREADABLE",
        "openInput: the container opened and the demuxer parsed no track out of it",
        MediaErrorKind.UnsupportedFormat,
      ],
      [
        "NO_VIDEO_TRACK",
        "openInput: the container's tracks read and none of them carries video",
        MediaErrorKind.NoVideoTrack,
      ],
      [
        "BACKEND_CRASHED",
        "web video engine command timed out waiting for the worker",
        MediaErrorKind.Decode,
      ],
    ];

    for (const [code, message, kind] of cases) {
      expect(
        getMediaErrorKind(Object.assign(new Error(message), { code })),
      ).toBe(kind);
    }
  });

  it("classifies every code in its vocabulary by the code, not the message", () => {
    const kinds: Record<
      (typeof MEDIA_PRODUCER_ERROR_CODES)[number],
      MediaErrorKind
    > = {
      ABORTED: MediaErrorKind.Unknown,
      BACKEND_CRASHED: MediaErrorKind.Decode,
      CONTAINER_UNREADABLE: MediaErrorKind.Unreadable,
      DECODER_STALLED: MediaErrorKind.Decode,
      DECODE_UNSUPPORTED: MediaErrorKind.UnsupportedFormat,
      NO_VIDEO_TRACK: MediaErrorKind.NoVideoTrack,
      PRESENTATION_MISMATCH: MediaErrorKind.Unknown,
      RATE_UNSUPPORTED: MediaErrorKind.Unknown,
      SOURCE_UNREADABLE: MediaErrorKind.Unreadable,
      VIDEO_TRACK_UNREADABLE: MediaErrorKind.UnsupportedFormat,
    };

    for (const code of MEDIA_PRODUCER_ERROR_CODES) {
      const failure = Object.assign(new Error("Network request failed."), {
        code,
      });

      expect(getMediaErrorKind(failure)).toBe(kinds[code]);
    }
  });

  it("ignores a code that is not an engine refusal", () => {
    const domLike = Object.assign(new Error("The operation was aborted."), {
      code: 20,
    });

    expect(getMediaErrorKind(domLike)).toBe(MediaErrorKind.Network);
  });

  it("keeps a kind chosen at the point of failure", () => {
    const error = new MediaSourceError(
      MediaErrorKind.NoVideoTrack,
      "No video track found in media source.",
    );

    expect(toMediaSourceError(error)).toBe(error);
    expect(getMediaErrorKind(error)).toBe(MediaErrorKind.NoVideoTrack);
  });

  it("classifies an unwrapped failure that reached a consumer", () => {
    expect(getMediaErrorKind(new Error("Network request failed."))).toBe(
      MediaErrorKind.Network,
    );
    expect(getMediaErrorKind(new Error("Something else entirely."))).toBe(
      MediaErrorKind.Unknown,
    );
  });

  it("represents non-error throws without inventing a kind", () => {
    const error = toMediaSourceError("boom", "Unable to open this media.");

    expect(error.kind).toBe(MediaErrorKind.Unknown);
    expect(error.message).toBe("Unable to open this media.");
    expect(error.cause).toBe("boom");
    expect(getMediaErrorKind("boom")).toBe(MediaErrorKind.Unknown);
  });
});
