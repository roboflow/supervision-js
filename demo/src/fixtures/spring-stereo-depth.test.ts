/// <reference types="node" />

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseDepthManifest } from "supervision";
import meta from "../../fixtures/spring_stereo_depth/fixture.meta.json";
import { listFixtureDepthFiles } from "../../server/fixture-depth-files-plugin";
import { demoFixtureCatalog, parseDemoFixtureDepth } from "./demo-fixtures";

/**
 * CI checks out without Git LFS, so every PNG and MP4 here may be a pointer
 * file. These tests read manifests, pointers and container headers only, and
 * never decode a PNG.
 */
const fixtureRoot = fileURLToPath(
  new URL("../../fixtures/spring_stereo_depth", import.meta.url),
);
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1\n";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const FRAME_COUNT = 192;
/** Both manifests name their frames `exact/{index:06}.png`, checked below. */
const exactFile = (index: number) =>
  `exact/${String(index).padStart(6, "0")}.png`;

const depth = parseDemoFixtureDepth(meta.depth);
const manifests = depth.layers.map((layer) => ({
  layer,
  manifest: parseDepthManifest(
    JSON.parse(readFileSync(join(fixtureRoot, layer.manifest), "utf8")),
  ),
  folder: join(fixtureRoot, layer.manifest, ".."),
}));
const hashes = new Map(
  readFileSync(join(fixtureRoot, "outputs.sha256"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, path] = line.split(/ {2}/);
      return [path, hash] as const;
    }),
);

describe("Spring stereo depth fixture", () => {
  it("offers a ground-truth layer and a stereo matcher layer, opening on the matcher", () => {
    expect(depth).toEqual({
      defaultLayer: "sgbm",
      layers: [
        {
          id: "ground-truth",
          label: "Ground truth (Spring)",
          manifest: "ground-truth/depth.json",
          source: "ground_truth",
        },
        {
          id: "sgbm",
          label: "Stereo matcher (OpenCV SGBM)",
          manifest: "sgbm/depth.json",
          source: "prediction",
        },
      ],
    });
  });

  it("opens from the catalog for depth alone, served from its own folder", () => {
    const fixture = demoFixtureCatalog.find(
      ({ sampleName }) => sampleName === "spring_stereo_depth",
    );

    expect(fixture).toMatchObject({
      detectionsManifestSrc: null,
      depth: {
        defaultLayer: "sgbm",
        layers: [
          {
            id: "ground-truth",
            manifestSrc:
              "/fixtures/spring_stereo_depth/ground-truth/depth.json",
          },
          {
            id: "sgbm",
            manifestSrc: "/fixtures/spring_stereo_depth/sgbm/depth.json",
          },
        ],
      },
    });
    expect(fixture?.videoSrc).toMatch(/left\.mp4$/);
  });

  it("describes both layers as exact disparity for every frame of the left view", () => {
    for (const { manifest } of manifests) {
      expect(manifest).toMatchObject({
        camera: {
          baselineM: 0.065,
          cxPx: 640,
          cyPx: 360,
          doffsPx: 0,
          fxPx: 1346.8013,
        },
        frames: { count: FRAME_COUNT, exact: "exact/{index:06}.png" },
        height: 720,
        kind: "disparity_px",
        storage: { format: "png16", noDepth: 0, scale: 1024 },
        view: "left",
        width: 1280,
      });
      expect(manifest.frames?.timesS).toBeUndefined();
      expect(manifest.preview).toMatchObject({
        codec: "avc1.64001f",
        file: "preview.mp4",
        levels: "tv",
        reservedMax: 31,
      });
    }
  });

  it("commits a PNG, or its LFS pointer, for every frame of both layers", () => {
    for (const { folder } of manifests) {
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        const file = join(folder, exactFile(index));

        expect(existsSync(file), file).toBe(true);

        const head = readFileSync(file).subarray(0, 64);

        expect(
          head.subarray(0, 8).equals(PNG_SIGNATURE) ||
            head.toString("utf8").startsWith(LFS_POINTER_PREFIX),
          file,
        ).toBe(true);
      }
      expect(existsSync(join(folder, exactFile(FRAME_COUNT)))).toBe(false);
    }
  });

  it("matches every committed file to the hash the fixture build recorded", () => {
    const committed = [
      "left.mp4",
      ...manifests.flatMap(({ layer, manifest }) => {
        const folder = layer.manifest.replace(/depth\.json$/, "");

        return [
          layer.manifest,
          `${folder}${manifest.preview!.file}`,
          ...Array.from(
            { length: FRAME_COUNT },
            (_, index) => `${folder}${exactFile(index)}`,
          ),
        ];
      }),
    ];

    expect([...hashes.keys()].sort()).toEqual([...committed].sort());
    for (const path of committed) {
      expect(committedSha256(join(fixtureRoot, path)), path).toBe(
        hashes.get(path),
      );
    }
  });

  it("goes into the demo build file for file, under its own names", async () => {
    const shipped = (
      await listFixtureDepthFiles(join(fixtureRoot, ".."))
    ).filter((file) => file.startsWith(fixtureRoot));

    expect(
      shipped.map((file) => file.slice(fixtureRoot.length + 1)).sort(),
    ).toEqual([...hashes.keys()].filter((path) => path !== "left.mp4").sort());
  });

  it("plays 192 frames at 24 fps, one per depth frame", () => {
    const bytes = readFileSync(join(fixtureRoot, meta.media.file));

    if (isLfsPointer(bytes)) return;

    expect(readMp4VideoTiming(bytes)).toEqual({
      frameCount: FRAME_COUNT,
      frameRate: 24,
    });
  });

  it("keeps the dataset's CC BY 4.0 attribution with the data", () => {
    const readme = readFileSync(join(fixtureRoot, "README.md"), "utf8");

    expect(readme).toContain("**CC BY 4.0, not MIT**");
    expect(readme).toContain("https://doi.org/10.18419/darus-3376");
    expect(readme).toContain(
      "The Spring movie assets\n> (https://cloud.blender.org/spring) by Blender Foundation are licensed under CC BY 4.0.",
    );
    expect(readme).toContain("Changes made:");
  });
});

function isLfsPointer(bytes: Buffer) {
  return bytes.subarray(0, 64).toString("utf8").startsWith(LFS_POINTER_PREFIX);
}

/** A pointer names its object's SHA-256; a checked-out file is hashed. */
function committedSha256(path: string) {
  const bytes = readFileSync(path);

  if (isLfsPointer(bytes)) {
    const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(bytes.toString("utf8"));

    if (!oid) throw new Error(`${path} is an LFS pointer without an oid.`);
    return oid[1];
  }

  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads the video track's sample count and timescale from an MP4's `moov`,
 * without decoding: `mdhd` gives the timescale and duration, `stsz` the
 * number of frames.
 */
function readMp4VideoTiming(bytes: Buffer) {
  const find = (
    start: number,
    end: number,
    path: readonly string[],
  ): number => {
    let offset = start;

    while (offset + 8 <= end) {
      const size = bytes.readUInt32BE(offset);
      const type = bytes.toString("latin1", offset + 4, offset + 8);

      if (size < 8) break;
      if (type === path[0]) {
        return path.length === 1
          ? offset
          : find(offset + 8, offset + size, path.slice(1));
      }
      offset += size;
    }

    return -1;
  };
  const trak = ["moov", "trak", "mdia"];
  const mdhd = find(0, bytes.length, [...trak, "mdhd"]);
  const stsz = find(0, bytes.length, [...trak, "minf", "stbl", "stsz"]);

  if (mdhd < 0 || stsz < 0) throw new Error("No video track timing found.");

  // Version 0 mdhd: size, type, version+flags, created, modified, timescale, duration.
  const timescale = bytes.readUInt32BE(mdhd + 20);
  const duration = bytes.readUInt32BE(mdhd + 24);
  // stsz: size, type, version+flags, sample_size, sample_count.
  const frameCount = bytes.readUInt32BE(stsz + 16);

  return {
    frameCount,
    frameRate: Math.round((frameCount * timescale) / duration),
  };
}
