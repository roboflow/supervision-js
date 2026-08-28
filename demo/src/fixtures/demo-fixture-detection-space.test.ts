/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProjectedDetectionFrameSource,
  type DetectionCoordinateSpace,
  type DetectionFrame,
} from "supervision";

import {
  createDemoFixtureDetectionSource,
  demoFixtures,
  type DemoFixtureDetectionManifest,
} from "./demo-fixtures";

/** Frame size of the committed `horse_trail/proxy-1080p.mp4` delivery proxy. */
const HORSE_PROXY_SPACE: DetectionCoordinateSpace = {
  height: 1080,
  width: 806,
};
const fixturesRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));

function readFixtureManifest(sampleName: string) {
  return JSON.parse(
    readFileSync(
      join(fixturesRoot, sampleName, "detections.manifest.json"),
      "utf8",
    ),
  ) as DemoFixtureDetectionManifest;
}

function requireFixture(sampleName: string) {
  const definition = demoFixtures.find(
    (candidate) => candidate.sampleName === sampleName,
  );

  if (!definition) {
    throw new Error(`Missing demo fixture ${sampleName}.`);
  }

  return definition;
}

function serveFixtureChunksFromDisk(sampleName: string) {
  vi.stubGlobal("fetch", async (url: string) => ({
    json: async () =>
      JSON.parse(
        readFileSync(
          join(
            fixturesRoot,
            sampleName,
            "detections",
            url.split("/").at(-1) ?? "",
          ),
          "utf8",
        ),
      ),
    ok: true,
  }));
}

function readFirstChunkDetection(
  manifest: DemoFixtureDetectionManifest,
  sampleName: string,
) {
  const chunkSrc = manifest.chunks[0]?.src;

  if (!chunkSrc) {
    throw new Error(`Fixture ${sampleName} has no detection chunks.`);
  }

  const chunk = JSON.parse(
    readFileSync(join(fixturesRoot, sampleName, chunkSrc), "utf8"),
  ) as { readonly frames: readonly DetectionFrame[] };
  const detection = chunk.frames[0]?.detections[0];

  if (!detection?.rect || !detection.mask) {
    throw new Error(`Fixture ${sampleName} has no masked box to compare.`);
  }

  return { mask: detection.mask, rect: detection.rect };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fixture detections against a delivery proxy", () => {
  it("scales horse trail boxes onto the smaller presented frame", async () => {
    const definition = requireFixture("horse_trail");
    const manifest = readFixtureManifest("horse_trail");
    const sourceDetection = readFirstChunkDetection(manifest, "horse_trail");

    serveFixtureChunksFromDisk("horse_trail");

    const fixtureSource = createDemoFixtureDetectionSource(
      manifest,
      definition,
    );
    const presented = createProjectedDetectionFrameSource(
      fixtureSource.detectionSource,
      () => HORSE_PROXY_SPACE,
    );
    const frames = await presented.loadFrames(0, 0.02);
    const detection = frames[0]?.detections[0];

    const scaleX = HORSE_PROXY_SPACE.width / manifest.video.width;
    const scaleY = HORSE_PROXY_SPACE.height / manifest.video.height;

    expect(detection?.rect).toEqual({
      height: sourceDetection.rect.height * scaleY,
      width: sourceDetection.rect.width * scaleX,
      x: sourceDetection.rect.x * scaleX,
      y: sourceDetection.rect.y * scaleY,
    });
    expect(detection?.rect?.x).toBeLessThan(sourceDetection.rect.x);
    expect(detection?.rect?.y).toBeLessThan(sourceDetection.rect.y);

    fixtureSource.destroy();
  });

  it("leaves horse trail masks in their own intrinsic pixels", async () => {
    const definition = requireFixture("horse_trail");
    const manifest = readFixtureManifest("horse_trail");
    const sourceDetection = readFirstChunkDetection(manifest, "horse_trail");

    serveFixtureChunksFromDisk("horse_trail");

    const fixtureSource = createDemoFixtureDetectionSource(
      manifest,
      definition,
    );
    const presented = createProjectedDetectionFrameSource(
      fixtureSource.detectionSource,
      () => HORSE_PROXY_SPACE,
    );
    const frames = await presented.loadFrames(0, 0.02);

    expect(frames[0]?.detections[0]?.mask).toEqual(sourceDetection.mask);

    fixtureSource.destroy();
  });

  it("leaves basketball detections untouched, proxy and source being one size", async () => {
    const definition = requireFixture("basketball_sam3");
    const manifest = readFixtureManifest("basketball_sam3");

    serveFixtureChunksFromDisk("basketball_sam3");

    const fixtureSource = createDemoFixtureDetectionSource(
      manifest,
      definition,
    );
    const mediaSpace: DetectionCoordinateSpace = {
      height: manifest.video.height,
      width: manifest.video.width,
    };
    const loaded = await fixtureSource.detectionSource.loadFrames(0, 0.02, {
      coordinateSpace: mediaSpace,
    });
    const presented = createProjectedDetectionFrameSource(
      fixtureSource.detectionSource,
      () => mediaSpace,
    );
    const frames = await presented.loadFrames(0, 0.02);

    expect(frames[0]?.detections[0]).toEqual(loaded[0]?.detections[0]);

    fixtureSource.destroy();
  });
});

describe("fixture detection space guard", () => {
  it("refuses frames that never say which space they are in", async () => {
    const definition = requireFixture("horse_trail");
    const manifest = readFixtureManifest("horse_trail");

    serveFixtureChunksFromDisk("horse_trail");

    const fixtureSource = createDemoFixtureDetectionSource(
      manifest,
      definition,
      (frames) =>
        frames.map(({ coordinateSpace: _coordinateSpace, ...frame }) => frame),
    );

    await expect(
      fixtureSource.detectionSource.loadFrames(0, 0.02, {
        coordinateSpace: HORSE_PROXY_SPACE,
      }),
    ).rejects.toThrow(
      /plays 806x1080 media while its detections were computed at 1504x2016/,
    );

    fixtureSource.destroy();
  });

  it("refuses a manifest that states no detection frame size", async () => {
    const definition = requireFixture("horse_trail");
    const manifest = readFixtureManifest("horse_trail");

    serveFixtureChunksFromDisk("horse_trail");

    const fixtureSource = createDemoFixtureDetectionSource(
      { ...manifest, video: { ...manifest.video, height: 0, width: 0 } },
      definition,
    );

    await expect(
      fixtureSource.detectionSource.loadFrames(0, 0.02, {
        coordinateSpace: HORSE_PROXY_SPACE,
      }),
    ).rejects.toThrow(/does not say what size its detections were computed at/);

    fixtureSource.destroy();
  });
});
