#!/usr/bin/env node
import {
  access,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { URL } from "node:url";

const DEFAULT_FIXTURE_URL = "http://127.0.0.1:5175/";
const DEFAULT_CHROME_DEBUG_URL = "http://127.0.0.1:9223";
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_EXTRACT_BATCH_SIZE = 1;
const DEFAULT_QUALITY = 0.92;
const DEFAULT_CHUNK_DURATION_SECONDS = 1;
const DEFAULT_CHROME_USER_DATA_DIR = "/tmp/supervision-js-sam3-fixture-chrome";
const DEFAULT_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
].filter(Boolean);

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!process.env.ROBOFLOW_API_KEY) {
  throw new Error(
    "ROBOFLOW_API_KEY is required. Export it in your shell; the fixture creator will not write it to disk.",
  );
}

await main(options);

async function main(runOptions) {
  const inputPath = resolveUserPath(runOptions.input);
  const sampleName = validateSampleName(runOptions.sampleName);
  const sourceFile = basename(inputPath);
  const fixtureDir = resolve("demo/fixtures", sampleName);
  const stagingFixtureDir = resolve(
    "demo/fixtures",
    `.${sampleName}.generating-${process.pid}`,
  );
  const copiedSourcePath = resolve(stagingFixtureDir, sourceFile);
  const framesPath = resolve(
    "tools/sam3-fixture/output",
    sampleName,
    "frames.jsonl",
  );
  const rawOutputPath = resolve(stagingFixtureDir, "raw-sam3.jsonl");
  const detectionsPath = resolve(stagingFixtureDir, "detections.json");
  const datasetId = `${sampleName}_v1`;
  const displayName = runOptions.displayName ?? createDisplayName(sampleName);
  let serverProcess;
  let chromeProcess;

  try {
    await cleanupStaleIncompleteFixture(fixtureDir);
    await cleanupGeneratedArtifacts(stagingFixtureDir, framesPath);
    await mkdir(stagingFixtureDir, { recursive: true });
    await copyFile(inputPath, copiedSourcePath);

    if (!runOptions.noStartServer) {
      serverProcess = await ensureFixtureServer(runOptions.fixtureUrl);
    }

    if (!runOptions.noStartChrome) {
      chromeProcess = await ensureChromeDebugging({
        chromeDebugUrl: runOptions.chromeDebugUrl,
        fixtureUrl: runOptions.fixtureUrl,
      });
    }

    const sourceUrl = pathToViteFsUrl(copiedSourcePath);
    await runNodeScript("tools/sam3-fixture/extract-frames.mjs", [
      "--output",
      framesPath,
      "--sample-name",
      sampleName,
      "--source-file",
      sourceFile,
      "--source-url",
      sourceUrl,
      "--batch-size",
      String(runOptions.extractBatchSize),
      "--quality",
      String(runOptions.quality),
      "--start-frame",
      String(runOptions.startFrame),
      "--url",
      runOptions.fixtureUrl,
      "--chrome-debug-url",
      runOptions.chromeDebugUrl,
      ...(runOptions.limit === undefined
        ? []
        : ["--count", String(runOptions.limit)]),
    ]);

    await runNodeScript("tools/sam3-fixture/run-sam3.mjs", [
      "--input",
      framesPath,
      "--raw-output",
      rawOutputPath,
      "--detections-output",
      detectionsPath,
      "--sample-name",
      sampleName,
      "--source-file",
      sourceFile,
      "--classes",
      runOptions.classes.join(","),
      "--concurrency",
      String(runOptions.concurrency),
      "--start-frame",
      String(runOptions.startFrame),
      ...(runOptions.limit === undefined
        ? []
        : ["--limit", String(runOptions.limit)]),
    ]);

    await runNodeScript("tools/sam3-fixture/chunk-detections.mjs", [
      "--input",
      detectionsPath,
      "--fixture-dir",
      stagingFixtureDir,
      "--dataset-id",
      datasetId,
      "--chunk-duration",
      String(DEFAULT_CHUNK_DURATION_SECONDS),
    ]);

    await writeFixtureMeta({
      datasetId,
      displayName,
      fixtureDir: stagingFixtureDir,
      sampleName,
      sourceFile,
    });
    await writeFixtureReadme({
      classes: runOptions.classes,
      displayName,
      fixtureDir: stagingFixtureDir,
      sampleName,
      sourceFile,
    });
    await replaceFixtureDirectory(stagingFixtureDir, fixtureDir);

    console.log(`Created SAM3 fixture: demo/fixtures/${sampleName}`);
  } catch (error) {
    // Extraction can take an hour; a late inference failure must not burn it.
    // The staging dir and frames stay for a resumed run, and the next start
    // cleans them itself.
    console.error(
      `Fixture creation failed. Keeping ${stagingFixtureDir} and ${framesPath} for inspection; rerun tools/sam3-fixture/run-sam3.mjs with --input ${framesPath} to resume inference without re-extracting.`,
    );
    throw error;
  } finally {
    serverProcess?.kill();
    chromeProcess?.kill();
  }
}

function parseArgs(args) {
  const parsed = {
    chromeDebugUrl: DEFAULT_CHROME_DEBUG_URL,
    classes: undefined,
    concurrency: DEFAULT_CONCURRENCY,
    displayName: undefined,
    extractBatchSize: DEFAULT_EXTRACT_BATCH_SIZE,
    fixtureUrl: DEFAULT_FIXTURE_URL,
    help: false,
    input: undefined,
    limit: undefined,
    noStartChrome: false,
    noStartServer: false,
    quality: DEFAULT_QUALITY,
    sampleName: undefined,
    startFrame: 0,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--chrome-debug-url":
        parsed.chromeDebugUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--class":
        parsed.classes = [
          ...(parsed.classes ?? []),
          readFlagValue(args, (index += 1), arg),
        ];
        break;
      case "--classes":
        parsed.classes = parseClassList(readFlagValue(args, (index += 1), arg));
        break;
      case "--concurrency":
        parsed.concurrency = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--display-name":
        parsed.displayName = readFlagValue(args, (index += 1), arg);
        break;
      case "--extract-batch-size":
        parsed.extractBatchSize = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--fixture-url":
        parsed.fixtureUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--input":
        parsed.input = readFlagValue(args, (index += 1), arg);
        break;
      case "--limit":
        parsed.limit = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--no-start-chrome":
        parsed.noStartChrome = true;
        break;
      case "--no-start-server":
        parsed.noStartServer = true;
        break;
      case "--quality":
        parsed.quality = parseProbability(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--sample-name":
        parsed.sampleName = readFlagValue(args, (index += 1), arg);
        break;
      case "--start-frame":
        parsed.startFrame = parseNonNegativeInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.help) {
    return parsed;
  }

  if (!parsed.input) {
    throw new Error("--input is required.");
  }

  if (!parsed.sampleName) {
    throw new Error("--sample-name is required.");
  }

  parsed.classes = normalizeClasses(parsed.classes);

  return parsed;
}

function printHelp() {
  console.log(`Usage:
ROBOFLOW_API_KEY=... npm run fixture:sam3:create -- \\
  --input /absolute/path/video.mov \\
  --sample-name horse_trail \\
  --classes "person, horse"

Options:
  --class <prompt>                   can be repeated
  --classes <prompt,prompt>          required unless --class is used
  --chrome-debug-url <url>            default: ${DEFAULT_CHROME_DEBUG_URL}
  --concurrency <count>              default: ${DEFAULT_CONCURRENCY}
  --display-name <label>
  --extract-batch-size <count>        default: ${DEFAULT_EXTRACT_BATCH_SIZE}
  --fixture-url <url>                 default: ${DEFAULT_FIXTURE_URL}
  --input <path>                      required
  --limit <frames>                    optional smoke-test subset
  --no-start-chrome                   use an already-running remote-debug Chrome
  --no-start-server                   use an already-running fixture Vite server
  --quality <0..1>                    default: ${DEFAULT_QUALITY}
  --sample-name <slug>                required
  --start-frame <frameIndex>          default: 0

SAM3 output_prob_thresh is fixed at 0.1.`);
}

async function ensureFixtureServer(fixtureUrl) {
  if (await isHttpReachable(fixtureUrl)) {
    return undefined;
  }

  const child = spawn("npm", ["run", "fixture:sam3:dev"], {
    env: process.env,
    stdio: "inherit",
  });

  await waitForHttp(fixtureUrl, {
    failureMessage: "Timed out waiting for the SAM3 fixture Vite server.",
  });

  return child;
}

async function ensureChromeDebugging(options) {
  if (await isHttpReachable(`${options.chromeDebugUrl}/json`)) {
    return undefined;
  }

  const chromePath = DEFAULT_CHROME_PATHS[0];

  if (!chromePath) {
    throw new Error(
      `Unable to find Chrome. Start Chrome with --remote-debugging-port=9223 or set CHROME_PATH.`,
    );
  }

  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${new URL(options.chromeDebugUrl).port}`,
      `--user-data-dir=${DEFAULT_CHROME_USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      options.fixtureUrl,
    ],
    { env: process.env, stdio: "ignore" },
  );

  await waitForHttp(`${options.chromeDebugUrl}/json`, {
    failureMessage: "Timed out waiting for Chrome remote debugging.",
  });

  return child;
}

async function waitForHttp(url, options) {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (await isHttpReachable(url)) {
      return;
    }

    await delay(500);
  }

  throw new Error(options.failureMessage);
}

async function isHttpReachable(url) {
  try {
    const response = await globalThis.fetch(url);

    return response.ok;
  } catch {
    return false;
  }
}

async function runNodeScript(scriptPath, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: process.env,
      stdio: "inherit",
    });

    child.addListener("error", reject);
    child.addListener("exit", (code) => {
      if (code === 0) {
        resolvePromise(undefined);
        return;
      }

      reject(new Error(`${scriptPath} exited with code ${code}.`));
    });
  });
}

async function replaceFixtureDirectory(sourceDir, destinationDir) {
  await rm(destinationDir, { force: true, recursive: true });
  await mkdir(resolve(destinationDir, ".."), { recursive: true });
  await rename(sourceDir, destinationDir);
}

async function cleanupGeneratedArtifacts(fixtureDir, framesPath) {
  await Promise.all([
    rm(fixtureDir, { force: true, recursive: true }),
    rm(resolve(framesPath, ".."), { force: true, recursive: true }),
  ]);
}

async function cleanupStaleIncompleteFixture(fixtureDir) {
  const fixtureMetaPath = resolve(fixtureDir, "fixture.meta.json");
  const manifestPath = resolve(fixtureDir, "detections.manifest.json");

  if (
    (await fileExists(fixtureMetaPath)) &&
    !(await fileExists(manifestPath))
  ) {
    await rm(fixtureDir, { force: true, recursive: true });
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFixtureMeta(options) {
  await writeJson(resolve(options.fixtureDir, "fixture.meta.json"), {
    datasetId: options.datasetId,
    displayName: options.displayName,
    inferenceLabel: "SAM3",
    media: {
      file: options.sourceFile,
      loadingStatusLabel: `opening ${options.displayName}`,
      readyStatusLabel: `${options.displayName} | web video engine, source ${extname(options.sourceFile).slice(1).toUpperCase()}`,
    },
    sampleName: options.sampleName,
    schema: "supervision-js.demo.sam3-fixture-meta",
    version: 1,
  });
}

async function writeFixtureReadme(options) {
  await writeFile(
    resolve(options.fixtureDir, "README.md"),
    `# ${options.displayName}

Generated SAM3 fixture for \`${options.sourceFile}\`.

## Runtime Shape

The demo plays this original media file. Detections were extracted from the same
file's own frames at its native frame rate, so \`frameIndex\` counts presented
source frames and detections land on the pixels they were computed from. The
demo loads them from committed JSON chunks instead of calling SAM3 at runtime.

## Prompts

${options.classes.map((className) => `- \`${className}\``).join("\n")}

## Files

- \`${options.sourceFile}\`: original source media copied by the fixture tool
- \`raw-sam3.jsonl\`: SAM3 responses with image payloads and API key omitted
- \`detections.json\`: normalized detection timeline
- \`detections.manifest.json\` and \`detections/\`: chunked demo runtime source

Temporary extracted frames are written outside the fixture folder at
\`tools/sam3-fixture/output/${options.sampleName}/frames.jsonl\`.
`,
  );
}

function pathToViteFsUrl(filePath) {
  return `/@fs/${filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parseClassList(value) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeClasses(classes) {
  const normalized = (classes ?? [])
    .map((className) => className.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error("At least one --class or --classes prompt is required.");
  }

  return [...new Set(normalized)];
}

function validateSampleName(sampleName) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sampleName)) {
    throw new Error(
      "--sample-name may only contain letters, numbers, underscores, and hyphens.",
    );
  }

  return sampleName;
}

function resolveUserPath(value) {
  if (value === "~") {
    return process.env.HOME ?? value;
  }

  if (value.startsWith("~/")) {
    return resolve(process.env.HOME ?? ".", value.slice(2));
  }

  return resolve(value);
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

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${flag} must be greater than 0 and at most 1.`);
  }

  return parsed;
}

function createDisplayName(sampleName) {
  return sampleName
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    globalThis.setTimeout(resolvePromise, ms);
  });
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
