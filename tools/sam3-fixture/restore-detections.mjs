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
 * Each fixture's `detections.json` is a build intermediate: the demo reads the
 * committed chunks, and only the offline geometry merge still consumes the
 * single file. The digests are the bytes the committed capture normalizes to,
 * and `basketball_sam3` also records its own under
 * `provenance.sources[].inputSha256` in the chunk manifest.
 */
const FIXTURES = [
  {
    dir: "demo/fixtures/basketball_sam3",
    sha256: "2052a6acc0be93832da42ec656a16ffebed9b9bf3d6252d32a9dbe18588cef99",
  },
  {
    dir: "demo/fixtures/horse_trail",
    sha256: "fb3eeb098bf6a9467e04e35a67df249babca19201fc6b3d989f8c1c8ec7cdfce",
  },
];

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
  const fixtures = FIXTURES.map((fixture) => ({
    ...fixture,
    sampleName: path.basename(fixture.dir),
  }));

  if (sampleNames.length === 0) {
    return fixtures;
  }

  return sampleNames.map((sampleName) => {
    const fixture = fixtures.find((entry) => entry.sampleName === sampleName);

    if (!fixture) {
      throw new Error(
        `Unknown sample name ${sampleName}. Known: ${fixtures
          .map((entry) => entry.sampleName)
          .join(", ")}.`,
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
                                     (${FIXTURES.map((fixture) => path.basename(fixture.dir)).join(", ")})`);
}
