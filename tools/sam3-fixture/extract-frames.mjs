#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CHROME_DEBUG_URL = "http://127.0.0.1:9223";
const DEFAULT_FIXTURE_URL = "http://127.0.0.1:5175/";
const DEFAULT_OUTPUT = "tools/sam3-fixture/output/frames.jsonl";
const DEFAULT_QUALITY = 0.92;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

await mkdir(path.dirname(options.output), { recursive: true });

const target = await findOrCreatePageTarget(
  options.chromeDebugUrl,
  options.url,
);
const client = await createCdpClient(target.webSocketDebuggerUrl);

try {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Page.navigate", { url: options.url });
  await waitForPageLoad(client);

  const manifest = await evaluateFixturePrepare(client, {
    sampleName: options.sampleName,
    sourceFile: options.sourceFile,
    sourceUrl: options.sourceUrl,
  });
  const frameCount = options.count ?? manifest.video.estimatedFrameCount;

  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error(
      "Unable to infer frame count from the normalized fixture manifest. Pass --count explicitly.",
    );
  }

  const output = createWriteStream(options.output, { encoding: "utf8" });

  try {
    for (
      let frameIndex = options.startFrame;
      frameIndex < options.startFrame + frameCount;
      frameIndex += options.batchSize
    ) {
      const count = Math.min(
        options.batchSize,
        options.startFrame + frameCount - frameIndex,
      );
      const batch = await evaluateFixtureBatch(client, {
        count,
        frameIndex,
        quality: options.quality,
      });

      output.write(`${JSON.stringify(batch)}\n`);
      process.stdout.write(
        `extracted frames ${frameIndex}-${frameIndex + count - 1}\n`,
      );
    }
  } finally {
    await new Promise((resolve, reject) => {
      output.end((error) => (error ? reject(error) : resolve()));
    });
  }
} finally {
  client.close();
}

async function evaluateFixturePrepare(client, options) {
  const response = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `window.prepareSam3Fixture(${JSON.stringify(removeUndefinedProperties(options))})`,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.text ??
        "Fixture preparation failed in browser.",
    );
  }

  return response.result.value;
}

async function evaluateFixtureBatch(client, options) {
  const response = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `window.getSam3FrameBatch(${JSON.stringify({
      count: options.count,
      quality: options.quality,
      startFrameIndex: options.frameIndex,
    })})`,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.text ?? "Frame extraction failed in browser.",
    );
  }

  return response.result.value;
}

async function waitForPageLoad(client) {
  await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression:
      "document.readyState === 'complete' ? true : new Promise((resolve) => window.addEventListener('load', () => resolve(true), { once: true }))",
    returnByValue: true,
  });
}

async function findOrCreatePageTarget(chromeDebugUrl, pageUrl) {
  const targets = await fetchTargets(chromeDebugUrl);
  const existingTarget = targets.find(
    (candidate) => candidate.type === "page" && candidate.url === pageUrl,
  );

  if (existingTarget?.webSocketDebuggerUrl) {
    return existingTarget;
  }

  const reusableTarget = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      typeof candidate.webSocketDebuggerUrl === "string",
  );

  if (reusableTarget?.webSocketDebuggerUrl) {
    return reusableTarget;
  }

  const createdResponse = await globalThis.fetch(
    `${chromeDebugUrl}/json/new?${encodeURIComponent(pageUrl)}`,
    { method: "PUT" },
  );

  if (!createdResponse.ok) {
    throw new Error(
      `Unable to create Chrome page target: ${createdResponse.status} ${createdResponse.statusText}`,
    );
  }

  const createdTarget = await createdResponse.json();

  if (!createdTarget?.webSocketDebuggerUrl) {
    throw new Error(`Chrome did not return a websocket target for ${pageUrl}.`);
  }

  return createdTarget;
}

async function fetchTargets(chromeDebugUrl) {
  const response = await globalThis.fetch(`${chromeDebugUrl}/json`);

  if (!response.ok) {
    throw new Error(
      `Unable to reach Chrome remote debugging at ${chromeDebugUrl}. Start Chrome with --remote-debugging-port=9223.`,
    );
  }

  return response.json();
}

function createCdpClient(webSocketUrl) {
  const socket = new globalThis.WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (!message.id) {
      return;
    }

    const callbacks = pending.get(message.id);

    if (!callbacks) {
      return;
    }

    pending.delete(message.id);

    if (message.error) {
      callbacks.reject(new Error(message.error.message));
      return;
    }

    callbacks.resolve(message.result);
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => {
        resolve({
          close() {
            socket.close();
          },
          send(method, params = {}) {
            const id = nextId;

            nextId += 1;

            return new Promise((messageResolve, messageReject) => {
              pending.set(id, {
                reject: messageReject,
                resolve: messageResolve,
              });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        });
      },
      { once: true },
    );
    socket.addEventListener("error", reject, { once: true });
  });
}

function parseArgs(args) {
  const parsed = {
    batchSize: 1,
    chromeDebugUrl: DEFAULT_CHROME_DEBUG_URL,
    count: undefined,
    help: false,
    output: DEFAULT_OUTPUT,
    quality: DEFAULT_QUALITY,
    sampleName: undefined,
    sourceFile: undefined,
    sourceUrl: undefined,
    startFrame: 0,
    url: DEFAULT_FIXTURE_URL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--batch-size" && next) {
      parsed.batchSize = Number(next);
      index += 1;
    } else if (arg === "--chrome-debug-url" && next) {
      parsed.chromeDebugUrl = next;
      index += 1;
    } else if (arg === "--count" && next) {
      parsed.count = Number(next);
      index += 1;
    } else if (arg === "--output" && next) {
      parsed.output = next;
      index += 1;
    } else if (arg === "--quality" && next) {
      parsed.quality = Number(next);
      index += 1;
    } else if (arg === "--sample-name" && next) {
      parsed.sampleName = next;
      index += 1;
    } else if (arg === "--source-file" && next) {
      parsed.sourceFile = next;
      index += 1;
    } else if (arg === "--source-url" && next) {
      parsed.sourceUrl = next;
      index += 1;
    } else if (arg === "--start-frame" && next) {
      parsed.startFrame = Number(next);
      index += 1;
    } else if (arg === "--url" && next) {
      parsed.url = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  for (const [key, value] of Object.entries({
    batchSize: parsed.batchSize,
    count: parsed.count,
    quality: parsed.quality,
    startFrame: parsed.startFrame,
  })) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Invalid numeric option: ${key}`);
    }
  }

  if (
    parsed.batchSize <= 0 ||
    (parsed.count !== undefined && parsed.count <= 0) ||
    parsed.startFrame < 0
  ) {
    throw new Error("Frame extraction options must be positive.");
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
node tools/sam3-fixture/extract-frames.mjs \\
  --output demo/fixtures/my_sample/frames.jsonl \\
  --sample-name my_sample \\
  --source-file source.mov \\
  --source-url /@fs//absolute/repo/path/demo/fixtures/my_sample/source.mov

Options:
  --batch-size <count>               default: 1
  --chrome-debug-url <url>            default: ${DEFAULT_CHROME_DEBUG_URL}
  --count <frames>                    default: normalized manifest frame count
  --output <path>                     default: ${DEFAULT_OUTPUT}
  --quality <0..1>                    default: ${DEFAULT_QUALITY}
  --sample-name <name>
  --source-file <name>
  --source-url <url>
  --start-frame <frameIndex>          default: 0
  --url <fixture page url>            default: ${DEFAULT_FIXTURE_URL}`);
}

function removeUndefinedProperties(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
