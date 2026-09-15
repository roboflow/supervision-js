#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const DEFAULT_INPUT = "demo/fixtures/basketball_sam3/detections.json";
const DEFAULT_CHUNK_DURATION_SECONDS = 1;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const inputPath = resolve(options.input);
const fixtureDir = resolve(options.fixtureDir ?? dirname(inputPath));
const manifestPath = resolve(
  options.manifestOutput ?? `${fixtureDir}/detections.manifest.json`,
);
const chunksDir = resolve(options.chunksDir ?? `${fixtureDir}/detections`);
const fixture = JSON.parse(await readFile(inputPath, "utf8"));
const frames = fixture.frames ?? [];
const duration = fixture.video?.duration ?? getFixtureDuration(frames);
/** Source frame intervals can end past the reported duration on VFR media. */
const timelineEndTime = Math.max(duration, getFixtureDuration(frames));
const chunkCount = Math.max(
  1,
  Math.ceil(timelineEndTime / options.chunkDurationSeconds),
);
const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => ({
  chunkIndex,
  endTime: Math.min(
    timelineEndTime,
    (chunkIndex + 1) * options.chunkDurationSeconds,
  ),
  frames: [],
  startTime: chunkIndex * options.chunkDurationSeconds,
}));

for (const frame of frames) {
  const startChunkIndex = getChunkIndex(
    frame.mediaTime,
    options.chunkDurationSeconds,
  );
  const endChunkIndex = getFrameEndChunkIndex(
    frame,
    startChunkIndex,
    options.chunkDurationSeconds,
  );

  for (
    let chunkIndex = startChunkIndex;
    chunkIndex <= endChunkIndex;
    chunkIndex += 1
  ) {
    chunks[chunkIndex]?.frames.push(frame);
  }
}

await rm(chunksDir, { force: true, recursive: true });
await mkdir(chunksDir, { recursive: true });

const manifestChunks = [];

for (const chunk of chunks) {
  const filename = `${chunk.chunkIndex.toString().padStart(6, "0")}.json`;
  const chunkPath = resolve(chunksDir, filename);

  await writeJson(chunkPath, { frames: chunk.frames });
  manifestChunks.push({
    chunkIndex: chunk.chunkIndex,
    endTime: chunk.endTime,
    frameCount: chunk.frames.length,
    src: `detections/${filename}`,
    startTime: chunk.startTime,
  });
}

await writeJson(manifestPath, {
  ...(fixture.classNames ? { classNames: fixture.classNames } : {}),
  chunkDurationSeconds: options.chunkDurationSeconds,
  chunks: manifestChunks,
  datasetId: options.datasetId ?? fixture.source?.sampleName ?? "sam3_fixture",
  detectionCount: frames.reduce(
    (total, frame) => total + frame.detections.length,
    0,
  ),
  duration,
  frameCount: frames.length,
  frameRate: fixture.inference?.frameRate ?? fixture.video?.frameRate,
  ...(fixture.geometry ? { geometry: fixture.geometry } : {}),
  inference: fixture.inference,
  ...(fixture.provenance ? { provenance: fixture.provenance } : {}),
  schema: "supervision-js.detection-frame-chunk-manifest",
  source: fixture.source,
  sourceFile: relative(dirname(manifestPath), inputPath),
  version: 1,
  video: fixture.video,
});

console.log(`Wrote ${manifestChunks.length} detection chunks to ${chunksDir}`);

function parseArgs(args) {
  const parsed = {
    chunkDurationSeconds: DEFAULT_CHUNK_DURATION_SECONDS,
    chunksDir: undefined,
    compact: false,
    datasetId: undefined,
    fixtureDir: undefined,
    help: false,
    input: DEFAULT_INPUT,
    manifestOutput: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--compact":
        parsed.compact = true;
        break;
      case "--chunk-duration":
        parsed.chunkDurationSeconds = parsePositiveNumber(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--chunks-dir":
        parsed.chunksDir = readFlagValue(args, (index += 1), arg);
        break;
      case "--dataset-id":
        parsed.datasetId = readFlagValue(args, (index += 1), arg);
        break;
      case "--fixture-dir":
        parsed.fixtureDir = readFlagValue(args, (index += 1), arg);
        break;
      case "--input":
        parsed.input = readFlagValue(args, (index += 1), arg);
        break;
      case "--manifest-output":
        parsed.manifestOutput = readFlagValue(args, (index += 1), arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
node tools/sam3-fixture/chunk-detections.mjs \\
  --input demo/fixtures/my_sample/detections.json \\
  --fixture-dir demo/fixtures/my_sample \\
  --dataset-id my_sample_v1

Options:
  --chunk-duration <seconds>          default: ${DEFAULT_CHUNK_DURATION_SECONDS}
  --chunks-dir <path>
  --compact                           write chunk JSON without indentation
  --dataset-id <id>
  --fixture-dir <path>
  --input <path>                      default: ${DEFAULT_INPUT}
  --manifest-output <path>`);
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }

  return parsed;
}

function getChunkIndex(mediaTime, chunkDurationSeconds) {
  return Math.max(0, Math.floor(mediaTime / chunkDurationSeconds));
}

function getFrameEndChunkIndex(frame, startChunkIndex, chunkDurationSeconds) {
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

function writeJson(path, value) {
  return writeFile(
    path,
    `${JSON.stringify(value, null, options.compact ? undefined : 2)}\n`,
  );
}
