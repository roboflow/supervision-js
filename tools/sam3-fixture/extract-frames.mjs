#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CHROME_DEBUG_URL = "http://127.0.0.1:9223";
const DEFAULT_FIXTURE_URL = "http://127.0.0.1:5175/";
const DEFAULT_OUTPUT = "tools/sam3-fixture/output/frames.jsonl";
const DEFAULT_COUNT = 270;
const DEFAULT_QUALITY = 0.92;

const options = parseArgs(process.argv.slice(2));

await mkdir(path.dirname(options.output), { recursive: true });

const target = await findPageTarget(options.chromeDebugUrl, options.url);
const client = await createCdpClient(target.webSocketDebuggerUrl);

try {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: "window.prepareBasketballSam3Fixture()",
    returnByValue: true,
  });

  const output = createWriteStream(options.output, { encoding: "utf8" });

  try {
    for (
      let frameIndex = options.startFrame;
      frameIndex < options.startFrame + options.count;
      frameIndex += options.batchSize
    ) {
      const count = Math.min(
        options.batchSize,
        options.startFrame + options.count - frameIndex,
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

async function evaluateFixtureBatch(client, options) {
  const response = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `window.getBasketballSam3FrameBatch(${JSON.stringify({
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

async function findPageTarget(chromeDebugUrl, pageUrl) {
  const response = await globalThis.fetch(`${chromeDebugUrl}/json`);
  const targets = await response.json();
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.url === pageUrl,
  );

  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No Chrome page target found for ${pageUrl}.`);
  }

  return target;
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
    count: DEFAULT_COUNT,
    output: DEFAULT_OUTPUT,
    quality: DEFAULT_QUALITY,
    startFrame: 0,
    url: DEFAULT_FIXTURE_URL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--batch-size" && next) {
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
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid numeric option: ${key}`);
    }
  }

  if (parsed.batchSize <= 0 || parsed.count <= 0 || parsed.startFrame < 0) {
    throw new Error("Frame extraction options must be positive.");
  }

  return parsed;
}
