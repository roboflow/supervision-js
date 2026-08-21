import { describe, expect, it } from "vitest";

import { MediaErrorKind } from "supervision-js-core";
import {
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
