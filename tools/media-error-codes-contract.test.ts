import { describe, expect, it } from "vitest";

import { VideoEngineErrorCode } from "supervision-js-web-video-engine";

import { MEDIA_PRODUCER_ERROR_CODES } from "../packages/web/src/media/media-errors";

describe("media producer error codes", () => {
  it("names every code the video engine refuses with, so none is left to a message match", () => {
    expect([...MEDIA_PRODUCER_ERROR_CODES]).toEqual(
      expect.arrayContaining(Object.values(VideoEngineErrorCode)),
    );
  });
});
