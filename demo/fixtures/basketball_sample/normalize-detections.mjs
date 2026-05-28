import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_FILE = "inference-events.jsonl";
const OUTPUT_FILE = "detections.json";

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const VIDEO_FRAME_RATE = 25;
const VIDEO_DURATION = 9;
const INFERENCE_FRAME_RATE = 30;
const MASK_HEIGHT = 567;
const MASK_WIDTH = 1008;

const roundTo = (value, decimals) => Number(value.toFixed(decimals));

function decodeCompressedRleCounts(counts) {
  const decoded = [];
  let index = 0;

  while (index < counts.length) {
    let value = 0;
    let shift = 0;
    let charCode;

    do {
      charCode = counts.charCodeAt(index) - 48;
      index += 1;
      value |= (charCode & 0x1f) << shift;
      shift += 5;
    } while (charCode & 0x20);

    if (charCode & 0x10) {
      value |= -1 << shift;
    }

    if (decoded.length > 2) {
      value += decoded[decoded.length - 2];
    }

    decoded.push(value);
  }

  return decoded;
}

function deriveMaskBox(mask) {
  const [height, width] = mask.size;

  if (height !== MASK_HEIGHT || width !== MASK_WIDTH) {
    throw new Error(`Unexpected mask size ${height}x${width}`);
  }

  const counts = decodeCompressedRleCounts(mask.counts);
  let offset = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index];
    const isForeground = index % 2 === 1;

    if (isForeground && runLength > 0) {
      let remaining = runLength;
      let runOffset = offset;

      while (remaining > 0) {
        const x = Math.floor(runOffset / height);
        const y = runOffset % height;
        const pixelsInColumn = Math.min(remaining, height - y);

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y + pixelsInColumn - 1);

        runOffset += pixelsInColumn;
        remaining -= pixelsInColumn;
      }
    }

    offset += runLength;
  }

  if (maxX < minX || maxY < minY) {
    throw new Error("Mask contains no foreground pixels");
  }

  const scaleX = VIDEO_WIDTH / width;
  const scaleY = VIDEO_HEIGHT / height;

  return {
    x: roundTo(minX * scaleX, 3),
    y: roundTo(minY * scaleY, 3),
    width: roundTo((maxX - minX + 1) * scaleX, 3),
    height: roundTo((maxY - minY + 1) * scaleY, 3),
  };
}

function normalizeMask(mask) {
  const [height, width] = mask.size;

  if (height !== MASK_HEIGHT || width !== MASK_WIDTH) {
    throw new Error(`Unexpected mask size ${height}x${width}`);
  }

  return {
    encoding: "compressedRle",
    width,
    height,
    counts: mask.counts,
  };
}

function getFrameIndex(eventId) {
  const finalSegment = eventId.split("/").at(-1);
  const frameIndex = Number(finalSegment);

  if (!Number.isInteger(frameIndex)) {
    throw new Error(`Could not extract frame index from event id: ${eventId}`);
  }

  return frameIndex;
}

function findMissingIndexes(frameIndexes) {
  const present = new Set(frameIndexes);
  const missing = [];

  for (
    let frameIndex = Math.min(...frameIndexes);
    frameIndex <= Math.max(...frameIndexes);
    frameIndex += 1
  ) {
    if (!present.has(frameIndex)) {
      missing.push(frameIndex);
    }
  }

  return missing;
}

function normalizeEvent(event) {
  const frameIndex = getFrameIndex(event.id);

  return {
    frameIndex,
    mediaTime: roundTo(frameIndex / INFERENCE_FRAME_RATE, 3),
    endTime: roundTo((frameIndex + 1) / INFERENCE_FRAME_RATE, 3),
    detections: event.result.map((detection) => {
      if (detection.type !== "mask") {
        throw new Error(`Unexpected detection type: ${detection.type}`);
      }

      return {
        id: detection.detection_id,
        className: detection.class,
        confidence: roundTo(detection.confidence, 6),
        rect: deriveMaskBox(detection.masks),
        mask: normalizeMask(detection.masks),
        metadata: {
          rapidClassId: detection.id,
          rapidType: detection.type,
        },
      };
    }),
  };
}

async function main() {
  const inputPath = path.join(FIXTURE_DIR, SOURCE_FILE);
  const outputPath = path.join(FIXTURE_DIR, OUTPUT_FILE);
  const lines = (await readFile(inputPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  const frames = lines
    .map((line) => JSON.parse(line))
    .filter((event) => Array.isArray(event.result))
    .map(normalizeEvent)
    .sort((a, b) => a.frameIndex - b.frameIndex);

  const frameIndexes = frames.map((frame) => frame.frameIndex);
  const missingFrameIndexes = findMissingIndexes(frameIndexes);
  const classCounts = {};

  for (const frame of frames) {
    for (const detection of frame.detections) {
      classCounts[detection.className] =
        (classCounts[detection.className] ?? 0) + 1;
    }
  }

  const payload = {
    schema: "supervision-js.demo.basketball-sample.detections",
    version: 2,
    video: {
      file: "basketball_sample.mp4",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      frameRate: VIDEO_FRAME_RATE,
      duration: VIDEO_DURATION,
    },
    inference: {
      sourceFile: SOURCE_FILE,
      frameRate: INFERENCE_FRAME_RATE,
      mask: {
        width: MASK_WIDTH,
        height: MASK_HEIGHT,
      },
      missingFrameIndexes,
    },
    frames,
  };

  await writeFile(
    outputPath,
    await prettier.format(JSON.stringify(payload), { parser: "json" }),
  );

  const detectionCount = frames.reduce(
    (total, frame) => total + frame.detections.length,
    0,
  );
  const classSummary = Object.entries(classCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([className, count]) => `${className}: ${count}`)
    .join(", ");

  console.log(
    [
      `frames: ${frames.length}`,
      `detections: ${detectionCount}`,
      `missing indexes: ${missingFrameIndexes.join(", ") || "none"}`,
      `class counts: ${classSummary}`,
    ].join("\n"),
  );
}

await main();
