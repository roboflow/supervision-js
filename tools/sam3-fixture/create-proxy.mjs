#!/usr/bin/env node
/**
 * Rebuilds the forced-CFR 30fps WebM proxy that v1 fixture detections were
 * computed against, so the demo can play the timeline those detections
 * describe. Normalization runs in Chrome because mediabunny needs WebCodecs.
 */
import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "node:timers";

const DEFAULT_PROXY_URL = "http://127.0.0.1:5175/proxy.html";
const DEFAULT_CHROME_DEBUG_URL = "http://127.0.0.1:9223";
const DEFAULT_PROXY_FILE = "proxy-30fps.webm";
const SLICE_BYTES = 524_288;
/**
 * Rate of `basketball_sam3/basketball_sample.normalized.webm`, the one surviving
 * proxy from the original fixture runs. Mediabunny's own default has since risen
 * about sixfold, which turns a 70 second 1504x2016 sample into 627MB.
 */
const REFERENCE_BITS_PER_PIXEL = 0.07038;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const fixtureDir = resolve("demo/fixtures", options.sampleName);
const metaPath = resolve(fixtureDir, "fixture.meta.json");
const meta = JSON.parse(await readFile(metaPath, "utf8"));
const sourcePath = resolve(fixtureDir, meta.media.file);
const proxyPath = options.proxyPath
  ? resolve(options.proxyPath)
  : resolve(dirname(sourcePath), DEFAULT_PROXY_FILE);
const proxyFile = relativeFixturePath(fixtureDir, proxyPath);
const bitrate = options.bitrate ?? (await deriveBitrate(fixtureDir, options));

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

  console.log(
    `Normalizing ${basename(sourcePath)} to 30fps VP9 WebM at ${(bitrate / 1e6).toFixed(2)}Mbps...`,
  );

  const result = await evaluate(
    client,
    `window.buildFixtureProxy(${JSON.stringify({
      bitrate,
      sourceUrl: pathToViteFsUrl(sourcePath),
    })})`,
    { timeoutMs: options.timeoutMs },
  );

  console.log(
    `Encoded ${formatBytes(result.size)} from ${formatBytes(result.sourceSize)}. Writing ${proxyFile}...`,
  );

  const output = createWriteStream(proxyPath);

  try {
    for (let offset = 0; offset < result.size; offset += SLICE_BYTES) {
      const slice = await evaluate(
        client,
        `window.readFixtureProxySlice(${offset}, ${SLICE_BYTES})`,
      );
      output.write(Buffer.from(slice, "base64"));
    }
  } finally {
    await new Promise((resolvePromise, reject) => {
      output.end((error) =>
        error ? reject(error) : resolvePromise(undefined),
      );
    });
  }

  await evaluate(client, "window.releaseFixtureProxy(); 1");

  const media = { ...meta.media, proxyFile };
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        ...meta,
        media: Object.fromEntries(
          Object.keys(media)
            .sort()
            .map((key) => [key, media[key]]),
        ),
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `Wrote ${proxyPath} and declared media.proxyFile in ${metaPath}.`,
  );
} finally {
  client.close();
}

async function deriveBitrate(dir, runOptions) {
  const manifest = JSON.parse(
    await readFile(resolve(dir, "detections.manifest.json"), "utf8"),
  );
  const { frameRate, height, width } = manifest.video;

  if (!(width > 0 && height > 0 && frameRate > 0)) {
    throw new Error(
      `${dir}/detections.manifest.json does not describe the proxy frame geometry.`,
    );
  }

  return Math.round(runOptions.bitsPerPixel * width * height * frameRate);
}

function relativeFixturePath(fromDir, filePath) {
  const from = fromDir.split("/");
  const to = filePath.split("/");

  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }

  return [...from.map(() => ".."), ...to].join("/");
}

async function evaluate(client, expression, { timeoutMs } = {}) {
  const response = await client.send(
    "Runtime.evaluate",
    { awaitPromise: true, expression, returnByValue: true },
    { timeoutMs },
  );

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Proxy normalization failed in browser.",
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
  await evaluate(
    client,
    "new Promise((resolve) => { const wait = () => (window.buildFixtureProxy ? resolve(true) : setTimeout(wait, 100)); wait(); })",
  );
}

async function findOrCreatePageTarget(chromeDebugUrl, pageUrl) {
  const targets = await fetchTargets(chromeDebugUrl);
  const existingTarget = targets.find(
    (candidate) => candidate.type === "page" && candidate.url === pageUrl,
  );

  if (existingTarget?.webSocketDebuggerUrl) {
    return existingTarget;
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

  return createdResponse.json();
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
  let keepalive;

  socket.addEventListener("close", (event) => {
    clearInterval(keepalive);
    const reason = `Chrome debug socket closed (code ${event.code}${
      event.reason ? `, ${event.reason}` : ""
    }) with ${pending.size} request(s) in flight.`;
    for (const callbacks of pending.values()) {
      callbacks.reject(new Error(reason));
    }
    pending.clear();
  });

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

  return new Promise((resolvePromise, reject) => {
    socket.addEventListener(
      "open",
      () => {
        // A full-length encode holds one evaluate open for many minutes, which
        // otherwise drains Node's event loop into a silent exit.
        keepalive = setInterval(() => {
          if (socket.readyState === globalThis.WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                id: nextId++,
                method: "Runtime.evaluate",
                params: { expression: "0" },
              }),
            );
          }
        }, 15000);
        resolvePromise({
          close() {
            clearInterval(keepalive);
            socket.close();
          },
          send(method, params = {}, { timeoutMs = 60_000 } = {}) {
            const id = nextId;

            nextId += 1;

            return new Promise((messageResolve, messageReject) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                messageReject(
                  new Error(`${method} timed out after ${timeoutMs}ms`),
                );
              }, timeoutMs);
              pending.set(id, {
                reject: (error) => {
                  clearTimeout(timer);
                  messageReject(error);
                },
                resolve: (value) => {
                  clearTimeout(timer);
                  messageResolve(value);
                },
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
    bitrate: undefined,
    bitsPerPixel: REFERENCE_BITS_PER_PIXEL,
    chromeDebugUrl: DEFAULT_CHROME_DEBUG_URL,
    help: false,
    proxyPath: undefined,
    sampleName: undefined,
    timeoutMs: 3_600_000,
    url: DEFAULT_PROXY_URL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--bitrate" && next) {
      parsed.bitrate = Number(next);
      index += 1;
    } else if (arg === "--bits-per-pixel" && next) {
      parsed.bitsPerPixel = Number(next);
      index += 1;
    } else if (arg === "--chrome-debug-url" && next) {
      parsed.chromeDebugUrl = next;
      index += 1;
    } else if (arg === "--proxy-path" && next) {
      parsed.proxyPath = next;
      index += 1;
    } else if (arg === "--sample-name" && next) {
      parsed.sampleName = next;
      index += 1;
    } else if (arg === "--timeout" && next) {
      parsed.timeoutMs = Number(next) * 1000;
      index += 1;
    } else if (arg === "--url" && next) {
      parsed.url = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.sampleName) {
    throw new Error("--sample-name is required.");
  }

  for (const [flag, value] of [
    ["--bitrate", parsed.bitrate],
    ["--bits-per-pixel", parsed.bitsPerPixel],
    ["--timeout", parsed.timeoutMs],
  ]) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      throw new Error(`${flag} must be a positive number.`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
npm run fixture:sam3:proxy -- --sample-name horse_trail

Options:
  --bitrate <bits per second>  default: derived from --bits-per-pixel
  --bits-per-pixel <rate>      default: ${REFERENCE_BITS_PER_PIXEL}
  --chrome-debug-url <url>     default: ${DEFAULT_CHROME_DEBUG_URL}
  --proxy-path <path>          default: ${DEFAULT_PROXY_FILE} beside the source media
  --sample-name <slug>         required
  --timeout <seconds>          default: 3600
  --url <proxy page url>       default: ${DEFAULT_PROXY_URL}

Start the page first with: npm run fixture:sam3:dev`);
}

function pathToViteFsUrl(filePath) {
  return `/@fs/${filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function formatBytes(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}
