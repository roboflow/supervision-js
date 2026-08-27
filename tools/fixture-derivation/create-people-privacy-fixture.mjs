#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sourceFixtureDir = resolve(repositoryRoot, "demo/fixtures/horse_trail");
const fixtureDir = resolve(
  repositoryRoot,
  "demo/fixtures/people_privacy_segmentation",
);
const durationSeconds = 3;
const frameRate = 30;
const sourceVideo = resolve(sourceFixtureDir, "1min-horse-video.mov");
const fixtureVideo = resolve(fixtureDir, "people_privacy.webm");

await mkdir(resolve(fixtureDir, "detections"), { recursive: true });
await createVideo();
await createDetectionChunks();
await writeFixtureMetadata();
await writeReadme();

async function createVideo() {
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourceVideo,
    "-t",
    String(durationSeconds),
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${frameRate}`,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "32",
    "-b:v",
    "0",
    fixtureVideo,
  ]);
}

async function createDetectionChunks() {
  const chunks = [];
  let detectionCount = 0;

  for (let chunkIndex = 0; chunkIndex < durationSeconds; chunkIndex += 1) {
    const source = JSON.parse(
      await readFile(
        resolve(
          sourceFixtureDir,
          "detections",
          `${String(chunkIndex).padStart(6, "0")}.json`,
        ),
        "utf8",
      ),
    );
    const frames = source.frames.map((frame) => ({
      ...frame,
      detections: frame.detections.filter(
        (detection) => detection.className === "person",
      ),
    }));
    detectionCount += frames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    );
    const src = `detections/${String(chunkIndex).padStart(6, "0")}.json`;
    await writeJson(resolve(fixtureDir, src), { frames });
    chunks.push({
      chunkIndex,
      endTime: chunkIndex + 1,
      frameCount: frames.length,
      src,
      startTime: chunkIndex,
    });
  }

  await writeJson(resolve(fixtureDir, "detections.manifest.json"), {
    classNames: ["person"],
    chunkDurationSeconds: 1,
    chunks,
    datasetId: "people_privacy_segmentation_v1",
    detectionCount,
    duration: durationSeconds,
    frameCount: durationSeconds * frameRate,
    frameRate,
    geometry: {
      boxDetectionCount: detectionCount,
      keypointDetectionCount: 0,
      maskDetectionCount: detectionCount,
      polygonDetectionCount: 0,
      polylineDetectionCount: 0,
    },
    inference: {
      frameRate,
      mask: { height: 2016, width: 1504 },
      missingFrameIndexes: [],
      modelId: "sam3/sam3_final",
      prompts: ["person"],
      sourceFile: "../horse_trail/raw-sam3.jsonl",
    },
    provenance: {
      derivation: {
        command:
          "node tools/fixture-derivation/create-people-privacy-fixture.mjs",
        frameRange:
          "0-89 inclusive from horse_trail's normalized 30fps timeline",
        mediaTransform:
          "first 3 seconds, 30fps VP9 WebM, no audio; geometry remains at the source 1504x2016 media dimensions",
        sourceFixture: "horse_trail",
      },
      source: {
        modelId: "sam3/sam3_final",
        prompt: "person",
      },
    },
    schema: "supervision-js.detection-frame-chunk-manifest",
    version: 1,
    video: {
      duration: durationSeconds,
      file: "people_privacy.webm",
      frameRate,
      height: 2016,
      width: 1504,
    },
  });
}

async function writeFixtureMetadata() {
  await writeJson(resolve(fixtureDir, "fixture.meta.json"), {
    datasetId: "people_privacy_segmentation_v1",
    displayName: "People Privacy Effects",
    inferenceLabel: "Frozen SAM3 person segmentation",
    media: {
      file: "people_privacy.webm",
      loadingStatusLabel: "loading 3s person privacy fixture",
      normalizeInBrowser: false,
      readyStatusLabel: "3s person fixture | frozen SAM3 masks | VP9 WebM",
    },
    presentation: {
      boxesEnabled: false,
      focusEnabled: false,
      keypointsEnabled: false,
      labelsEnabled: false,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    },
    sampleName: "people_privacy_segmentation",
    schema: "supervision-js.demo.fixture-meta",
    showInDemo: false,
    version: 1,
  });
}

async function writeReadme() {
  await writeFile(
    resolve(fixtureDir, "README.md"),
    `# People Privacy Effects\n\nA three-second, person-only privacy fixture derived from the committed \`horse_trail\` SAM3 fixture. The scene shows a rider; it is named for the privacy use case rather than claiming people are walking.\n\n## Provenance\n\n- Source fixture: [horse_trail](../horse_trail/README.md)\n- Source model and prompt: \`sam3/sam3_final\` with \`person\`\n- Frame range: 0 through 89 of the source fixture's normalized 30fps timeline\n- Media: first three seconds of the committed source video, re-encoded as 30fps VP9 WebM with audio removed\n- Detection data: the committed SAM3 frames filtered to \`className: "person"\`; masks and center-based rectangles are preserved without synthetic geometry\n\nRegenerate this fixture after changing the source fixture with:\n\n\`\`\`sh\nnode tools/fixture-derivation/create-people-privacy-fixture.mjs\n\`\`\`\n\nThe fixture is used by the Regions documentation playground for blur, pixelate, and the existing focus/spotlight composition. It never calls inference at runtime.\n`,
  );
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} exited with ${code ?? "an unknown status"}.`),
        );
    });
  });
}
