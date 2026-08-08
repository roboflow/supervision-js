#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { createDetectionFixture } from "./fixture.mjs";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const rawPath = resolve(options.rawInput);
const trackPath = resolve(options.trackInput);
const outputPath = resolve(options.output);
const rawContent = await readFile(rawPath, "utf8");
const trackContent = await readFile(trackPath, "utf8");
const rawRecords = parseJsonl(rawContent);
const trackRecords = parseJsonl(trackContent);
const fixture = createDetectionFixture({
  rawRecords,
  trackRecords,
  options: {
    maxTracePoints: options.maxTracePoints,
    mediaFile: options.mediaFile,
    sampleName: options.sampleName,
    traceWindowSeconds: options.traceWindowSeconds,
  },
});
fixture.provenance.rawOutput.file = relative(dirname(outputPath), rawPath);
fixture.provenance.rawOutput.sha256 = sha256(rawContent);
fixture.provenance.tracking.file = relative(dirname(outputPath), trackPath);
fixture.provenance.tracking.sha256 = sha256(trackContent);

await writeFile(outputPath, `${JSON.stringify(fixture)}\n`);
console.log(`Wrote normalized fixture to ${outputPath}`);

function parseArgs(args) {
  const parsed = {
    help: false,
    maxTracePoints: 50,
    mediaFile: "people-walking.webm",
    output: "demo/fixtures/people_walking_detection_v1/detections.json",
    rawInput: "demo/fixtures/people_walking_detection_v1/raw-yolov8n-640.jsonl",
    sampleName: "people_walking_detection_v1",
    traceWindowSeconds: 2,
    trackInput:
      "demo/fixtures/people_walking_detection_v1/bytetrack-associations.jsonl",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--max-trace-points":
        parsed.maxTracePoints = Number(readFlagValue(args, ++index, arg));
        break;
      case "--media-file":
        parsed.mediaFile = readFlagValue(args, ++index, arg);
        break;
      case "--output":
        parsed.output = readFlagValue(args, ++index, arg);
        break;
      case "--raw-input":
        parsed.rawInput = readFlagValue(args, ++index, arg);
        break;
      case "--sample-name":
        parsed.sampleName = readFlagValue(args, ++index, arg);
        break;
      case "--trace-window-seconds":
        parsed.traceWindowSeconds = Number(readFlagValue(args, ++index, arg));
        break;
      case "--track-input":
        parsed.trackInput = readFlagValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parseJsonl(value) {
  return value
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readFlagValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: npm run fixture:inference:create -- [options]

Options:
  --raw-input <path>
  --track-input <path>
  --output <path>
  --media-file <relative path>
  --sample-name <id>
  --trace-window-seconds <seconds>  default: 2
  --max-trace-points <count>        default: 50`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
