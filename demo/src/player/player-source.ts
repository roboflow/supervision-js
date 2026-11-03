import type { WebVideoEngineMediaSourceOptions } from "supervision";
import { SourceKind } from "supervision/web-video-engine";

import {
  defaultDemoFixture,
  demoFixtures,
  type DemoFixtureDefinition,
} from "../fixtures/demo-fixtures";

/** What the player has open: a bundled sample read over HTTP, or a file read
 *  straight off the viewer's disk. */
export type PlayerSource =
  | {
      readonly id: string;
      readonly kind: "sample";
      readonly label: string;
      readonly url: string;
    }
  | {
      readonly file: File;
      readonly kind: "file";
      readonly label: string;
    };

export type PlayerSampleSource = Extract<PlayerSource, { kind: "sample" }>;

/** Containers Mediabunny demuxes. Some browsers hand a `.mkv` or `.mov` over
 *  with no MIME type at all, so the name is the only thing left to go on. */
const VIDEO_FILE_EXTENSION = /\.(m4v|mkv|mov|mp4|webm)$/i;

/**
 * The samples the workbench offers, played from the file each one names. The
 * workbench plays a sample's proxy when it has one, because its detections were
 * computed on that copy; with nothing drawn over the picture there is nothing
 * to keep in step, so the player opens the original. Samples that share one
 * video differ only in what they draw over it, so each video is listed once.
 */
export function listPlayerSamples(
  fixtures: readonly DemoFixtureDefinition[] = demoFixtures,
): readonly PlayerSampleSource[] {
  const seen = new Set<string>();

  return fixtures.flatMap((fixture) => {
    if (seen.has(fixture.videoSrc)) {
      return [];
    }

    seen.add(fixture.videoSrc);
    return [toSampleSource(fixture)];
  });
}

/** The workbench's default sample, as the very entry the list holds, so picking
 *  it again is no change and reopens nothing. */
export function defaultPlayerSource(
  samples: readonly PlayerSampleSource[],
): PlayerSource {
  return (
    samples.find((sample) => sample.id === defaultDemoFixture.sampleName) ??
    toSampleSource(defaultDemoFixture)
  );
}

export function createFilePlayerSource(file: File): PlayerSource {
  return { file, kind: "file", label: file.name };
}

export function isVideoFile(file: Pick<File, "name" | "type">) {
  return (
    file.type.startsWith("video/") ||
    (file.type === "" && VIDEO_FILE_EXTENSION.test(file.name))
  );
}

/** The first video among what was dropped or picked, if any. */
export function findVideoFile(files: Iterable<File> | ArrayLike<File>) {
  return Array.from(files).find(isVideoFile) ?? null;
}

/** A file is read in place through `Blob` slices and a sample over HTTP
 *  range requests; neither is downloaded in one piece first. */
export function toEngineSource(
  source: PlayerSource,
): WebVideoEngineMediaSourceOptions["source"] {
  return source.kind === "file"
    ? { blob: source.file, kind: SourceKind.Blob }
    : { kind: SourceKind.Url, url: source.url };
}

function toSampleSource(fixture: DemoFixtureDefinition): PlayerSampleSource {
  return {
    id: fixture.sampleName,
    kind: "sample",
    label: fixture.displayName,
    url: fixture.videoSrc,
  };
}
