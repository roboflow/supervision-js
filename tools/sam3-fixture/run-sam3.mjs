#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import prettier from "prettier";

const ENDPOINT = "https://serverless.roboflow.com/sam3/concept_segment";
const FRAME_RATE = 30;
const DEFAULT_PROMPTS = [
  "white team player",
  "yellow team player",
  "basketball",
];
const OUTPUT_PROB_THRESH = 0.1;
const RAW_RESPONSE_SCHEMA =
  "supervision-js.tools.sam3-fixture.raw-sam3-response";
const DETECTIONS_SCHEMA = "supervision-js.tools.sam3-fixture.detections";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!options.input || !options.rawOutput) {
  printHelp();
  throw new Error("--input and --raw-output are required.");
}

const apiKey = process.env.ROBOFLOW_API_KEY;

if (!apiKey) {
  throw new Error(
    "ROBOFLOW_API_KEY is required. The key must come from the environment and must not be written into fixture files.",
  );
}

await main(options, apiKey);

async function main(runOptions, apiKeyValue) {
  const frames = selectFrames(await readExtractedFrames(runOptions.input), {
    limit: runOptions.limit,
    startFrame: runOptions.startFrame,
  });
  const completedFrameIndexes = await readCompletedFrameIndexes(
    runOptions.rawOutput,
  );
  const pendingFrames = frames.filter(
    (frame) => !completedFrameIndexes.has(frame.frameIndex),
  );

  await mkdir(path.dirname(runOptions.rawOutput), { recursive: true });

  const rawStream = createWriteStream(runOptions.rawOutput, { flags: "a" });

  try {
    await runWithConcurrency(
      pendingFrames,
      Math.max(1, runOptions.concurrency),
      async (frame) => {
        const rawRecord = await callSam3(frame, runOptions, apiKeyValue);
        rawStream.write(`${JSON.stringify(rawRecord)}\n`);
        if ("error" in rawRecord) {
          throw new Error(`SAM3 request failed for frame ${frame.frameIndex}.`);
        }

        console.log(`wrote raw SAM3 response for frame ${frame.frameIndex}`);
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      rawStream.end((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(undefined);
      });
    });
  }

  if (runOptions.detectionsOutput) {
    const rawRecords = await readRawRecords(runOptions.rawOutput);
    const detectionsFixture = normalizeSam3Responses(rawRecords, {
      modelId: runOptions.modelId,
      prompts: runOptions.prompts,
      rawOutput: runOptions.rawOutput,
      sampleName: runOptions.sampleName,
      sourceFile: runOptions.sourceFile,
    });

    await mkdir(path.dirname(runOptions.detectionsOutput), { recursive: true });
    await writeFile(
      runOptions.detectionsOutput,
      await prettier.format(JSON.stringify(detectionsFixture), {
        parser: "json",
      }),
    );
    console.log(
      `wrote normalized detections to ${runOptions.detectionsOutput}`,
    );
  }
}

function parseArgs(args) {
  const parsed = {
    concurrency: 1,
    format: "rle",
    limit: undefined,
    modelId: "sam3/sam3_final",
    nmsIouThreshold: 0.5,
    prompts: undefined,
    sampleName: undefined,
    sourceFile: undefined,
    startFrame: 0,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--input":
        parsed.input = readFlagValue(args, (index += 1), arg);
        break;
      case "--raw-output":
        parsed.rawOutput = readFlagValue(args, (index += 1), arg);
        break;
      case "--detections-output":
        parsed.detectionsOutput = readFlagValue(args, (index += 1), arg);
        break;
      case "--limit":
        parsed.limit = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--start-frame":
        parsed.startFrame = parseNonNegativeInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--concurrency":
        parsed.concurrency = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--class":
        parsed.prompts = [
          ...(parsed.prompts ?? []),
          readFlagValue(args, (index += 1), arg),
        ];
        break;
      case "--classes":
        parsed.prompts = parsePromptList(
          readFlagValue(args, (index += 1), arg),
        );
        break;
      case "--format":
        parsed.format = readFlagValue(args, (index += 1), arg);
        break;
      case "--model-id":
        parsed.modelId = readFlagValue(args, (index += 1), arg);
        break;
      case "--nms-iou-threshold":
        parsed.nmsIouThreshold = parseProbability(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--sample-name":
        parsed.sampleName = readFlagValue(args, (index += 1), arg);
        break;
      case "--source-file":
        parsed.sourceFile = readFlagValue(args, (index += 1), arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.prompts = normalizePrompts(parsed.prompts);

  return parsed;
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  return parsed;
}

function parseProbability(value, flag) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between 0 and 1.`);
  }

  return parsed;
}

function parsePromptList(value) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePrompts(prompts) {
  const normalized = (prompts ?? DEFAULT_PROMPTS)
    .map((prompt) => prompt.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error("At least one class prompt is required.");
  }

  return [...new Set(normalized)];
}

function printHelp() {
  console.log(`Usage:
node tools/sam3-fixture/run-sam3.mjs \\
  --input tools/sam3-fixture/frames.jsonl \\
  --raw-output tools/sam3-fixture/raw-sam3.jsonl \\
  --detections-output tools/sam3-fixture/detections.json \\
  --classes "person, horse"

Options:
  --class <prompt>                   can be repeated
  --classes <prompt,prompt>
  --limit <count>
  --start-frame <frameIndex>
  --concurrency <count>              default: 1
  SAM3 output_prob_thresh is fixed at ${OUTPUT_PROB_THRESH}
  --format <format>                  default: rle
  --model-id <id>                    default: sam3/sam3_final
  --nms-iou-threshold <0..1>          default: 0.5
  --sample-name <name>
  --source-file <filename>`);
}

async function readExtractedFrames(inputPath) {
  const lines = await readJsonl(inputPath);
  const frames = [];

  for (const value of lines) {
    frames.push(...extractFrames(value));
  }

  return frames
    .map(normalizeExtractedFrame)
    .sort((left, right) => left.frameIndex - right.frameIndex);
}

function extractFrames(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.frames)) {
    return value.frames;
  }

  return [value];
}

function normalizeExtractedFrame(value) {
  if (!isRecord(value)) {
    throw new Error("Extracted frame JSONL entries must be objects.");
  }

  const frameIndex = value.frameIndex;
  const mediaTime =
    typeof value.mediaTime === "number"
      ? value.mediaTime
      : typeof frameIndex === "number"
        ? frameIndex / FRAME_RATE
        : undefined;
  const image = isRecord(value.image) ? value.image : undefined;
  const imageValue =
    typeof value.jpegBase64 === "string"
      ? value.jpegBase64
      : typeof image?.value === "string"
        ? image.value
        : undefined;

  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error("Extracted frame is missing a valid frameIndex.");
  }

  if (typeof imageValue !== "string" || imageValue.length === 0) {
    throw new Error(
      `Extracted frame ${frameIndex} is missing JPEG base64 image data.`,
    );
  }

  return {
    decodedDuration: numberOrNull(value.decodedDuration),
    decodedTimestamp: numberOrNull(value.decodedTimestamp),
    frameIndex,
    height: numberOrNull(value.height),
    imageBase64: stripDataUrlPrefix(imageValue),
    mediaTime,
    requestedMediaTime: numberOrNull(value.requestedMediaTime),
    sampleQueryTime: numberOrNull(value.sampleQueryTime),
    width: numberOrNull(value.width),
  };
}

function selectFrames(frames, selection) {
  const filtered = frames.filter(
    (frame) => frame.frameIndex >= selection.startFrame,
  );

  return selection.limit === undefined
    ? filtered
    : filtered.slice(0, selection.limit);
}

async function readCompletedFrameIndexes(rawOutputPath) {
  const indexes = new Set();

  for (const record of await readRawRecords(rawOutputPath)) {
    if (
      isRecord(record) &&
      Number.isInteger(record.frameIndex) &&
      isRecord(record.response)
    ) {
      indexes.add(record.frameIndex);
    }
  }

  return indexes;
}

async function readRawRecords(rawOutputPath) {
  try {
    return await readJsonl(rawOutputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readJsonl(inputPath) {
  const content = await readFile(inputPath, "utf8");

  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function runWithConcurrency(items, concurrency, runItem) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await runItem(item);
      }
    },
  );

  await Promise.all(workers);
}

async function callSam3(frame, runOptions, apiKeyValue) {
  const payload = {
    format: runOptions.format,
    image: {
      type: "base64",
      value: frame.imageBase64,
    },
    model_id: runOptions.modelId,
    nms_iou_threshold: runOptions.nmsIouThreshold,
    output_prob_thresh: OUTPUT_PROB_THRESH,
    prompts: runOptions.prompts.map((text) => ({ text, type: "text" })),
  };
  const endpointUrl = new URL(ENDPOINT);
  endpointUrl.searchParams.set("api_key", apiKeyValue);
  const response = await globalThis.fetch(endpointUrl, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const responseText = await response.text();
  const parsedResponse = parseJsonIfPossible(responseText);
  const rawRecord = {
    frame: {
      height: frame.height,
      image: { omitted: true, type: "base64" },
      width: frame.width,
    },
    frameIndex: frame.frameIndex,
    mediaTime: frame.mediaTime,
    timing: {
      decodedDuration: frame.decodedDuration,
      decodedTimestamp: frame.decodedTimestamp,
      requestedMediaTime: frame.requestedMediaTime,
      sampleQueryTime: frame.sampleQueryTime,
    },
    request: {
      endpoint: ENDPOINT,
      format: runOptions.format,
      model_id: runOptions.modelId,
      nms_iou_threshold: runOptions.nmsIouThreshold,
      output_prob_thresh: OUTPUT_PROB_THRESH,
      prompts: runOptions.prompts,
    },
    schema: RAW_RESPONSE_SCHEMA,
    version: 1,
  };

  if (!response.ok) {
    return {
      ...rawRecord,
      error: {
        body: parsedResponse,
        status: response.status,
        statusText: response.statusText,
      },
    };
  }

  return {
    ...rawRecord,
    response: parsedResponse,
  };
}

function normalizeSam3Responses(rawRecords, context) {
  const frames = [];

  for (const rawRecord of rawRecords) {
    if (!isRecord(rawRecord) || !isRecord(rawRecord.response)) {
      continue;
    }

    const frameIndex = rawRecord.frameIndex;

    if (!Number.isInteger(frameIndex)) {
      continue;
    }

    const mediaTime =
      numberOrNull(rawRecord.mediaTime) ?? frameIndex / FRAME_RATE;
    const decodedDuration = numberOrNull(rawRecord.timing?.decodedDuration);

    frames.push({
      detections: normalizeFrameDetections(rawRecord.response, {
        prompts: getPromptsForRawRecord(rawRecord, context.prompts),
      }),
      endTime:
        decodedDuration === null
          ? (frameIndex + 1) / FRAME_RATE
          : mediaTime + decodedDuration,
      frameIndex,
      mediaTime,
    });
  }

  frames.sort((left, right) => left.frameIndex - right.frameIndex);

  const firstFrameMetadata = rawRecords.find(
    (record) => isRecord(record) && isRecord(record.frame),
  )?.frame;
  const firstMaskSize = findFirstMaskSize(frames);
  const width =
    firstMaskSize?.width ?? numberOrNull(firstFrameMetadata?.width) ?? 0;
  const height =
    firstMaskSize?.height ?? numberOrNull(firstFrameMetadata?.height) ?? 0;

  return {
    frames,
    inference: {
      frameRate: FRAME_RATE,
      mask: {
        height,
        width,
      },
      missingFrameIndexes: findMissingIndexes(
        frames.map((frame) => frame.frameIndex),
      ),
      modelId: context.modelId,
      prompts: context.prompts,
      sourceFile: path.basename(context.rawOutput),
    },
    schema: DETECTIONS_SCHEMA,
    source: removeUndefinedProperties({
      file: context.sourceFile,
      sampleName: context.sampleName,
    }),
    version: 1,
    video: {
      duration: frames.length === 0 ? 0 : frames.at(-1).endTime,
      file: context.sourceFile ?? "source media",
      frameRate: FRAME_RATE,
      height: numberOrNull(firstFrameMetadata?.height) ?? height,
      width: numberOrNull(firstFrameMetadata?.width) ?? width,
    },
  };
}

function normalizeFrameDetections(response, context) {
  return extractPromptResultEntries(response).flatMap((entry, promptIndex) => {
    const promptText = getPromptText(entry.promptResult, {
      promptIndex,
      prompts: context.prompts,
    });
    const predictions = extractPredictions(entry.promptResult);

    return predictions.map((prediction, predictionIndex) =>
      normalizePrediction(prediction, {
        promptIndex,
        promptText,
        predictionIndex,
      }),
    );
  });
}

function getPromptsForRawRecord(rawRecord, fallbackPrompts) {
  const prompts = isRecord(rawRecord.request)
    ? rawRecord.request.prompts
    : undefined;

  return Array.isArray(prompts)
    ? prompts.filter((prompt) => typeof prompt === "string")
    : fallbackPrompts;
}

function extractPromptResultEntries(response) {
  const promptResults =
    getArrayProperty(response, "prompt_results") ??
    getArrayProperty(response, "promptResults");

  if (promptResults) {
    return promptResults.map((promptResult) => ({ promptResult }));
  }

  return [{ promptResult: response }];
}

function getPromptText(promptResult, context) {
  if (isRecord(promptResult)) {
    const echo = isRecord(promptResult.echo) ? promptResult.echo : undefined;
    const candidates = [
      echo?.text,
      echo?.prompt,
      promptResult.text,
      promptResult.prompt,
      promptResult.class,
      promptResult.className,
    ];
    const match = candidates.find((candidate) => typeof candidate === "string");

    if (match) {
      return match;
    }
  }

  return (
    context.prompts[context.promptIndex] ?? `prompt ${context.promptIndex}`
  );
}

function extractPredictions(promptResult) {
  if (!isRecord(promptResult)) {
    return [];
  }

  return (
    getArrayProperty(promptResult, "predictions") ??
    getArrayProperty(promptResult, "detections") ??
    getArrayProperty(promptResult, "results") ??
    []
  ).filter(isRecord);
}

function normalizePrediction(prediction, context) {
  const mask = extractMask(prediction);
  const polygonPoints = extractPolygonPoints(prediction, mask);
  const rle = extractRle(mask);
  const rect =
    polygonPoints.length > 0
      ? deriveRectFromPoints(polygonPoints)
      : rle
        ? deriveRectFromRle(rle)
        : undefined;
  const normalizedMask =
    rle && typeof rle.counts === "string"
      ? {
          counts: rle.counts,
          encoding: "compressedRle",
          height: rle.height,
          width: rle.width,
        }
      : undefined;
  const rawMaskNote =
    rle && typeof rle.counts !== "string"
      ? "SAM3 returned an uncompressed or non-COCO RLE shape. The runner derives a box when possible and preserves the raw mask metadata instead of pretending it is supervision-js compressedRle."
      : undefined;

  return removeUndefinedProperties({
    className: getPredictionClassName(prediction, context),
    confidence: getPredictionConfidence(prediction),
    id: getPredictionId(prediction, context),
    mask: normalizedMask,
    metadata: removeUndefinedProperties({
      sam3MaskNote: rawMaskNote,
      sam3Prompt: context.promptText,
      sam3PromptIndex: context.promptIndex,
      sam3RawMask: normalizedMask ? undefined : mask,
    }),
    rect,
  });
}

function extractMask(prediction) {
  if (!isRecord(prediction)) {
    return undefined;
  }

  return firstRecord([
    prediction.mask,
    prediction.masks,
    prediction.segmentation,
    prediction.rle,
  ]);
}

function extractPolygonPoints(prediction, mask) {
  const polygonSource =
    getArrayProperty(prediction, "polygon") ??
    getArrayProperty(prediction, "points") ??
    getArrayProperty(mask, "polygon") ??
    getArrayProperty(mask, "points") ??
    getArrayProperty(mask, "vertices");

  if (!polygonSource) {
    return [];
  }

  return polygonSource.flatMap((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      const [x, y] = point;

      return typeof x === "number" && typeof y === "number" ? [{ x, y }] : [];
    }

    if (isRecord(point)) {
      const x = point.x;
      const y = point.y;

      return typeof x === "number" && typeof y === "number" ? [{ x, y }] : [];
    }

    return [];
  });
}

function extractRle(mask) {
  if (!isRecord(mask)) {
    return undefined;
  }

  const counts = mask.counts;
  const size = Array.isArray(mask.size) ? mask.size : undefined;
  const width = numberOrNull(mask.width) ?? numberOrNull(size?.[1]);
  const height = numberOrNull(mask.height) ?? numberOrNull(size?.[0]);

  if (
    (typeof counts !== "string" && !isNumberArray(counts)) ||
    !width ||
    !height
  ) {
    return undefined;
  }

  return {
    counts,
    height,
    width,
  };
}

function deriveRectFromPoints(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    height: roundTo(maxY - minY, 3),
    width: roundTo(maxX - minX, 3),
    x: roundTo(minX, 3),
    y: roundTo(minY, 3),
  };
}

function deriveRectFromRle(rle) {
  const counts =
    typeof rle.counts === "string"
      ? decodeCompressedRleCounts(rle.counts)
      : rle.counts;
  let offset = 0;
  let minX = rle.width;
  let minY = rle.height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index];
    const isForeground = index % 2 === 1;

    if (isForeground && runLength > 0) {
      let remaining = runLength;
      let runOffset = offset;

      while (remaining > 0) {
        const x = Math.floor(runOffset / rle.height);
        const y = runOffset % rle.height;
        const pixelsInColumn = Math.min(remaining, rle.height - y);

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
    return undefined;
  }

  return {
    height: roundTo(maxY - minY + 1, 3),
    width: roundTo(maxX - minX + 1, 3),
    x: roundTo(minX, 3),
    y: roundTo(minY, 3),
  };
}

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

function getPredictionClassName(prediction, context) {
  const candidates = [
    prediction.className,
    prediction.class_name,
    prediction.class,
    prediction.label,
    context.promptText,
  ];

  return candidates.find((candidate) => typeof candidate === "string");
}

function getPredictionConfidence(prediction) {
  const candidates = [
    prediction.confidence,
    prediction.score,
    prediction.probability,
  ];

  return candidates.find((candidate) => typeof candidate === "number");
}

function getPredictionId(prediction, context) {
  const candidates = [
    prediction.detection_id,
    prediction.detectionId,
    prediction.id,
  ];
  const match = candidates.find(
    (candidate) =>
      typeof candidate === "string" || typeof candidate === "number",
  );

  return match ?? `${context.promptIndex}:${context.predictionIndex}`;
}

function findFirstMaskSize(frames) {
  for (const frame of frames) {
    for (const detection of frame.detections) {
      if (isRecord(detection.mask)) {
        return {
          height: detection.mask.height,
          width: detection.mask.width,
        };
      }
    }
  }

  return undefined;
}

function findMissingIndexes(frameIndexes) {
  if (frameIndexes.length === 0) {
    return [];
  }

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

function parseJsonIfPossible(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripDataUrlPrefix(value) {
  const commaIndex = value.indexOf(",");

  return value.startsWith("data:") && commaIndex !== -1
    ? value.slice(commaIndex + 1)
    : value;
}

function getArrayProperty(value, key) {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : undefined;
}

function firstRecord(values) {
  return values.find(isRecord);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "number")
  );
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function removeUndefinedProperties(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function roundTo(value, decimals) {
  return Number(value.toFixed(decimals));
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
