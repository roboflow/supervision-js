#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const RUN_SAM3_SCRIPT = path.join(ROOT_DIR, "tools/sam3-fixture/run-sam3.mjs");

/**
 * `detections.json` is a git-ignored build intermediate, so this pinned digest
 * is the only committed record of its bytes. The demo fixture tests read the
 * same file to check each chunk manifest's `provenance.sources[].inputSha256`,
 * which has no file beside it to hash.
 */
const PINNED_DIGESTS_FILE = path.join(
  ROOT_DIR,
  "tools/sam3-fixture/restorable-detections.json",
);
const FIXTURES = JSON.parse(
  await readFile(PINNED_DIGESTS_FILE, "utf8"),
).fixtures.map((fixture) => ({
  dir: `demo/fixtures/${fixture.sampleName}`,
  sampleName: fixture.sampleName,
  sha256: fixture.detectionsSha256,
}));

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const selected = selectFixtures(options.sampleNames);

for (const fixture of selected) {
  await restoreFixture(fixture);
}

async function restoreFixture(fixture) {
  const fixtureDir = path.join(ROOT_DIR, fixture.dir);
  const manifestPath = path.join(fixtureDir, "detections.manifest.json");
  const detectionsPath = path.join(fixtureDir, "detections.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  await runNormalize([
    "--normalize-only",
    "--raw-output",
    path.join(fixtureDir, manifest.inference.sourceFile),
    "--frames-meta",
    manifestPath,
    "--detections-output",
    detectionsPath,
    "--model-id",
    manifest.inference.modelId,
    "--classes",
    manifest.inference.prompts.join(","),
    "--sample-name",
    fixture.sampleName,
    "--source-file",
    manifest.video.file,
  ]);

  const digest = await sha256File(detectionsPath);

  if (digest !== fixture.sha256) {
    throw new Error(
      `${fixture.dir}/detections.json restored to ${digest}, expected ${fixture.sha256}.`,
    );
  }

  console.log(`restored ${fixture.dir}/detections.json at sha256 ${digest}`);
}

function runNormalize(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [RUN_SAM3_SCRIPT, ...args], {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });

    child.once("error", rejectPromise);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`run-sam3.mjs exited with ${code}`)),
    );
  });
}

function sha256File(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function selectFixtures(sampleNames) {
  if (sampleNames.length === 0) {
    return FIXTURES;
  }

  return sampleNames.map((sampleName) => {
    const fixture = FIXTURES.find((entry) => entry.sampleName === sampleName);

    if (!fixture) {
      throw new Error(
        `Unknown sample name ${sampleName}. Known: ${FIXTURES.map(
          (entry) => entry.sampleName,
        ).join(", ")}.`,
      );
    }

    return fixture;
  });
}

function parseArgs(args) {
  const parsed = {
    help: false,
    sampleNames: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--sample-name":
        parsed.sampleNames.push(readFlagValue(args, (index += 1), arg));
        break;
      default:
        throw new Error(`Unknown argument ${arg}.`);
    }
  }

  return parsed;
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage:
npm run fixture:sam3:restore
npm run fixture:sam3:restore -- --sample-name basketball_sam3

Rebuilds each fixture's git-ignored detections.json from its committed
raw-sam3.jsonl and chunk manifest, then verifies the result against the digest
the fixture was committed at. Calls no model and needs no API key.

Options:
  --sample-name <name>               can be repeated; default: every fixture
                                     (${FIXTURES.map((fixture) => fixture.sampleName).join(", ")})`);
}
