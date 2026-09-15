/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openFrameProvider, openScrubSource } from "./decode-source";
import type { Rotation } from "./rotation";
import { SourceKind } from "./types";

/**
 * Real files, built here rather than committed, opened through the real open
 * path. What only a real file can settle is the sign: ffmpeg, ffprobe and
 * mediabunny each name a quarter turn their own way, and a table written from
 * the wrong one is 180 degrees out on exactly the two cases that matter.
 *
 * The clips are built from one landscape master by stream copy, so the pixels
 * are identical across the rotated set and only the display matrix differs.
 */
interface Fixture {
  readonly file: string;
  /** What `-display_rotation` was handed to ffmpeg, or null for no matrix. */
  readonly ffmpegDisplayRotation: number | null;
  /** What ffprobe prints as the stream's rotation side data. */
  readonly ffprobeRotation: number | null;
  /** What mediabunny, and therefore the engine, calls the same turn. */
  readonly rotation: Rotation;
  readonly coded: readonly [number, number];
  readonly display: readonly [number, number];
}

const FIXTURES: readonly Fixture[] = [
  {
    file: "rot_0.mp4",
    ffmpegDisplayRotation: null,
    ffprobeRotation: null,
    rotation: 0,
    coded: [640, 360],
    display: [640, 360],
  },
  {
    file: "rot_90.mp4",
    ffmpegDisplayRotation: 90,
    ffprobeRotation: 90,
    rotation: 270,
    coded: [640, 360],
    display: [360, 640],
  },
  {
    file: "rot_180.mp4",
    ffmpegDisplayRotation: 180,
    ffprobeRotation: -180,
    rotation: 180,
    coded: [640, 360],
    display: [640, 360],
  },
  {
    file: "rot_270.mp4",
    ffmpegDisplayRotation: 270,
    ffprobeRotation: -90,
    rotation: 90,
    coded: [640, 360],
    display: [360, 640],
  },
  {
    // The control: portrait pixels, no display matrix. A fix that turns frames
    // on their dimensions rather than on the matrix turns this one too.
    file: "portrait_no_matrix.mp4",
    ffmpegDisplayRotation: null,
    ffprobeRotation: null,
    rotation: 0,
    coded: [360, 640],
    display: [360, 640],
  },
];

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const QUADRANTS = [
  "drawbox=x=0:y=0:w=320:h=180:color=red@1:t=fill",
  "drawbox=x=320:y=0:w=320:h=180:color=lime@1:t=fill",
  "drawbox=x=0:y=180:w=320:h=180:color=blue@1:t=fill",
  "drawbox=x=320:y=180:w=320:h=180:color=white@1:t=fill",
].join(",");

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    stdio: "ignore",
  });
}

function buildFixtures(dir: string): void {
  const master = join(dir, "rot_0.mp4");
  ffmpeg([
    ...["-f", "lavfi", "-i", "color=c=0x202020:s=640x360:r=30:d=1"],
    ...["-vf", QUADRANTS],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30"],
    ...["-profile:v", "main", master],
  ]);
  for (const fixture of FIXTURES) {
    if (fixture.ffmpegDisplayRotation === null) continue;
    // `-metadata:s:v:0 rotate=N` is silently dropped on a stream copy; only the
    // input-side flag writes a real display matrix.
    ffmpeg([
      ...["-display_rotation", String(fixture.ffmpegDisplayRotation)],
      ...["-i", master, "-c", "copy", join(dir, fixture.file)],
    ]);
  }
  ffmpeg([
    ...["-i", master, "-vf", "transpose=1"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30"],
    ...["-profile:v", "main", join(dir, "portrait_no_matrix.mp4")],
  ]);
}

interface ProbedStream {
  readonly width: number;
  readonly height: number;
  readonly side_data_list?: ReadonlyArray<{ readonly rotation?: number }>;
}

function ffprobe(file: string): ProbedStream {
  const json = execFileSync("ffprobe", [
    ...["-v", "error", "-select_streams", "v:0"],
    ...["-show_entries", "stream=width,height:stream_side_data=rotation"],
    ...["-of", "json", file],
  ]).toString();
  return (JSON.parse(json) as { streams: ProbedStream[] }).streams[0];
}

const describeWithFfmpeg = hasFfmpeg()
  ? describe
  : describe.skip.bind(describe);

describeWithFfmpeg("rotation, on real files", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ve-rotation-"));
    buildFixtures(dir);
    // The open path refuses a track the realm cannot decode. Node has no
    // WebCodecs and these tests never decode: they read what the container
    // says and what the engine publishes from it.
    class StubVideoDecoder {
      static isConfigSupported(): Promise<{ supported: boolean }> {
        return Promise.resolve({ supported: true });
      }
    }
    vi.stubGlobal("VideoDecoder", StubVideoDecoder);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(FIXTURES)(
    "$file: ffprobe says $ffprobeRotation, mediabunny says $rotation",
    (fixture) => {
      const probed = ffprobe(join(dir, fixture.file));

      expect([probed.width, probed.height]).toEqual([...fixture.coded]);
      expect(probed.side_data_list?.[0]?.rotation ?? null).toBe(
        fixture.ffprobeRotation,
      );
    },
  );

  it.each(FIXTURES)(
    "$file: publishes the display size once, not the display size turned again",
    async (fixture) => {
      const blob = new Blob([readFileSync(join(dir, fixture.file))]);

      const handle = await openScrubSource({
        source: { kind: SourceKind.Blob, blob },
      });
      const provider = openFrameProvider(handle);

      expect(provider.track.rotation).toBe(fixture.rotation);
      expect([provider.track.width, provider.track.height]).toEqual([
        ...fixture.display,
      ]);
      expect([provider.track.decodeWidth, provider.track.decodeHeight]).toEqual(
        [...fixture.display],
      );
      // The path this fix had to reach: AVCC H.264 routes to the session, and
      // the session is what was painting these files unturned.
      expect(provider.decodePath).toBe("session");
      await provider.dispose();
    },
  );
});
