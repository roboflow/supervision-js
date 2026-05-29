import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = new URL("../../", import.meta.url);
const inputUrl = new URL("demo/fixtures/basketball_sam3/detections.json", root);
const manifestUrl = new URL(
  "demo/fixtures/basketball_sam3/detections.manifest.json",
  root,
);
const chunksDirUrl = new URL("demo/fixtures/basketball_sam3/detections/", root);
const chunkDurationSeconds = 1;
const datasetId = "basketball_sam3_v1";

const fixture = JSON.parse(await readFile(inputUrl, "utf8"));
const frames = fixture.frames ?? [];
const duration = fixture.video?.duration ?? getFixtureDuration(frames);
const chunkCount = Math.max(1, Math.ceil(duration / chunkDurationSeconds));
const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => ({
  chunkIndex,
  endTime: Math.min(duration, (chunkIndex + 1) * chunkDurationSeconds),
  frames: [],
  startTime: chunkIndex * chunkDurationSeconds,
}));

for (const frame of frames) {
  const startChunkIndex = getChunkIndex(frame.mediaTime);
  const endChunkIndex = getFrameEndChunkIndex(frame, startChunkIndex);

  for (
    let chunkIndex = startChunkIndex;
    chunkIndex <= endChunkIndex;
    chunkIndex += 1
  ) {
    chunks[chunkIndex]?.frames.push(frame);
  }
}

await rm(chunksDirUrl, { force: true, recursive: true });
await mkdir(chunksDirUrl, { recursive: true });

const manifestChunks = [];

for (const chunk of chunks) {
  const filename = `${chunk.chunkIndex.toString().padStart(6, "0")}.json`;
  const chunkUrl = new URL(filename, chunksDirUrl);

  await writeJson(chunkUrl, { frames: chunk.frames });
  manifestChunks.push({
    chunkIndex: chunk.chunkIndex,
    endTime: chunk.endTime,
    frameCount: chunk.frames.length,
    src: `detections/${filename}`,
    startTime: chunk.startTime,
  });
}

await writeJson(manifestUrl, {
  chunkDurationSeconds,
  chunks: manifestChunks,
  datasetId,
  detectionCount: frames.reduce(
    (total, frame) => total + frame.detections.length,
    0,
  ),
  duration,
  frameCount: frames.length,
  frameRate: fixture.inference?.frameRate ?? fixture.video?.frameRate,
  inference: fixture.inference,
  schema: "supervision-js.detection-frame-chunk-manifest",
  sourceFile: relative(
    dirname(fileURLToPath(manifestUrl)),
    fileURLToPath(inputUrl),
  ),
  version: 1,
  video: fixture.video,
});

console.log(
  `Wrote ${manifestChunks.length} detection chunks to ${fileURLToPath(
    chunksDirUrl,
  )}`,
);

function getChunkIndex(mediaTime) {
  return Math.max(0, Math.floor(mediaTime / chunkDurationSeconds));
}

function getFrameEndChunkIndex(frame, startChunkIndex) {
  if (frame.endTime === undefined) {
    return startChunkIndex;
  }

  return Math.max(
    startChunkIndex,
    Math.ceil(frame.endTime / chunkDurationSeconds) - 1,
  );
}

function getFixtureDuration(detectionFrames) {
  const lastFrame = detectionFrames.at(-1);

  return lastFrame?.endTime ?? lastFrame?.mediaTime ?? 0;
}

function writeJson(url, value) {
  return writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
}
