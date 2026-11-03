import { describe, expect, it } from "vitest";
import { SourceKind } from "supervision/web-video-engine";

import type { DemoFixtureDefinition } from "../fixtures/demo-fixtures";
import {
  createFilePlayerSource,
  findVideoFile,
  isVideoFile,
  listPlayerSamples,
  toEngineSource,
} from "./player-source";

describe("player source", () => {
  it("takes a video by its MIME type, or by its name when the browser gave none", () => {
    expect(isVideoFile({ name: "clip.bin", type: "video/mp4" })).toBe(true);
    expect(isVideoFile({ name: "clip.MKV", type: "" })).toBe(true);
    expect(isVideoFile({ name: "notes.txt", type: "" })).toBe(false);
    expect(isVideoFile({ name: "photo.png", type: "image/png" })).toBe(false);
  });

  it("picks the first video out of a mixed drop", () => {
    const notes = new File(["a"], "notes.txt", { type: "text/plain" });
    const clip = new File(["b"], "clip.webm", { type: "video/webm" });

    expect(findVideoFile([notes, clip])).toBe(clip);
    expect(findVideoFile([notes])).toBeNull();
  });

  it("reads a file in place and a sample over HTTP", () => {
    const file = new File(["c"], "clip.mp4", { type: "video/mp4" });

    expect(toEngineSource(createFilePlayerSource(file))).toEqual({
      blob: file,
      kind: SourceKind.Blob,
    });
    expect(
      toEngineSource({
        id: "horse",
        kind: "sample",
        label: "Horse",
        url: "/media/horse.mov",
      }),
    ).toEqual({ kind: SourceKind.Url, url: "/media/horse.mov" });
  });

  it("lists a video shared by several samples once, under the first", () => {
    const fixture = (sampleName: string, videoSrc: string) =>
      ({
        displayName: sampleName,
        sampleName,
        videoSrc,
      }) as DemoFixtureDefinition;

    expect(
      listPlayerSamples([
        fixture("boxes", "/media/court.mp4"),
        fixture("regions", "/media/court.mp4"),
        fixture("horse", "/media/horse.mov"),
      ]).map((sample) => sample.id),
    ).toEqual(["boxes", "horse"]);
  });
});
