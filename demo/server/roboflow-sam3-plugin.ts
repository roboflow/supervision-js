import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const SAM3_PROXY_PATH = "/api/roboflow/sam3/concept_segment";
export const SAM3_STREAM_PATH = "/api/roboflow/sam3/concept_segment_stream";
const SAM3_ENDPOINT = "https://serverless.roboflow.com/sam3/concept_segment";
const API_KEY_HEADER = "x-roboflow-api-key";
const SAM3_MODEL_ID = "sam3/sam3_final";
const SAM3_BACKEND_CONCURRENCY = 10;
const SAM3_FRAME_MAX_ATTEMPTS = 3;
const SAM3_RETRY_BASE_DELAY_MS = 400;
const DEFAULT_OUTPUT_PROBABILITY_THRESHOLD = 0.1;
const DEFAULT_NMS_IOU_THRESHOLD = 0.5;

export function roboflowSam3Plugin(): Plugin {
  return {
    name: "supervision-js-demo-roboflow-sam3-proxy",
    configureServer(server) {
      server.middlewares.use(SAM3_PROXY_PATH, async (request, response) => {
        await handleSam3ProxyRequest(request, response);
      });
      server.middlewares.use(SAM3_STREAM_PATH, async (request, response) => {
        await handleSam3StreamRequest(request, response);
      });
    },
  };
}

interface Sam3StreamRequestBody {
  readonly frames: readonly Sam3StreamRequestFrame[];
  readonly prompts: readonly string[];
}

interface Sam3StreamRequestFrame {
  readonly duration: number;
  readonly frameIndex: number;
  readonly imageBase64: string;
  readonly mediaTime: number;
}

export async function handleSam3ProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const apiKey = getSingleHeader(request.headers[API_KEY_HEADER]);

  if (!apiKey) {
    sendJson(response, 400, {
      error: `Missing ${API_KEY_HEADER} header.`,
    });
    return;
  }

  try {
    const endpointUrl = new URL(SAM3_ENDPOINT);
    endpointUrl.searchParams.set("api_key", apiKey);

    const upstreamResponse = await globalThis.fetch(endpointUrl, {
      body: await readRequestBody(request),
      headers: {
        "content-type":
          getSingleHeader(request.headers["content-type"]) ??
          "application/json",
      },
      method: "POST",
    });
    const contentType = upstreamResponse.headers.get("content-type");

    response.statusCode = upstreamResponse.status;
    response.statusMessage = upstreamResponse.statusText;
    if (contentType) {
      response.setHeader("content-type", contentType);
    }
    response.end(await upstreamResponse.text());
  } catch (error) {
    sendJson(response, 502, {
      error:
        error instanceof Error
          ? error.message
          : "Roboflow SAM3 proxy request failed.",
    });
  }
}

export async function handleSam3StreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const apiKey = getSingleHeader(request.headers[API_KEY_HEADER]);

  if (!apiKey) {
    sendJson(response, 400, {
      error: `Missing ${API_KEY_HEADER} header.`,
    });
    return;
  }

  try {
    await streamSam3Batch({
      apiKey,
      request,
      response,
    });
  } catch (error) {
    if (response.destroyed) {
      return;
    }

    if (!response.headersSent) {
      sendJson(response, 502, {
        error:
          error instanceof Error
            ? error.message
            : "Roboflow SAM3 stream request failed.",
      });
      return;
    }

    writeNdjson(response, {
      error:
        error instanceof Error
          ? error.message
          : "Roboflow SAM3 stream request failed.",
      type: "stream_error",
    });
    response.end();
  }
}

async function streamSam3Batch(options: {
  readonly apiKey: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}) {
  const body = parseSam3StreamRequest(
    JSON.parse(await readRequestBody(options.request)) as unknown,
  );
  const abortController = new AbortController();

  options.response.on("close", () => {
    if (!options.response.writableEnded) {
      abortController.abort();
    }
  });

  options.response.statusCode = 200;
  options.response.setHeader("content-type", "application/x-ndjson");
  options.response.setHeader("cache-control", "no-cache, no-transform");
  options.response.setHeader("x-accel-buffering", "no");
  options.response.flushHeaders?.();

  await runWithConcurrency(
    body.frames,
    SAM3_BACKEND_CONCURRENCY,
    async (frame) => {
      if (abortController.signal.aborted || options.response.destroyed) {
        return;
      }

      writeNdjson(options.response, {
        duration: frame.duration,
        frameIndex: frame.frameIndex,
        mediaTime: frame.mediaTime,
        type: "frame_started",
      });

      const result = await requestSam3FrameWithRetry({
        onRetry: (event) => {
          writeNdjson(options.response, event);
        },
        request: {
          apiKey: options.apiKey,
          frame,
          prompts: body.prompts,
          signal: abortController.signal,
        },
      });

      if (abortController.signal.aborted || options.response.destroyed) {
        return;
      }

      writeNdjson(options.response, result);
    },
  );

  if (!options.response.destroyed) {
    writeNdjson(options.response, { type: "done" });
    options.response.end();
  }
}

async function requestSam3FrameWithRetry(options: {
  readonly onRetry: (event: Record<string, unknown>) => void;
  readonly request: {
    readonly apiKey: string;
    readonly frame: Sam3StreamRequestFrame;
    readonly prompts: readonly string[];
    readonly signal: AbortSignal;
  };
}): Promise<Record<string, unknown>> {
  let latestErrorResult: Record<string, unknown> | undefined;

  for (let attempt = 1; attempt <= SAM3_FRAME_MAX_ATTEMPTS; attempt += 1) {
    latestErrorResult = await requestSam3Frame({
      ...options.request,
      attempt,
    });

    if (latestErrorResult.type !== "frame_error") {
      return latestErrorResult;
    }

    if (
      attempt === SAM3_FRAME_MAX_ATTEMPTS ||
      options.request.signal.aborted ||
      !shouldRetrySam3Frame(latestErrorResult)
    ) {
      return latestErrorResult;
    }

    const retryDelayMs = getRetryDelayMs(attempt);

    options.onRetry({
      attempt,
      duration: options.request.frame.duration,
      frameIndex: options.request.frame.frameIndex,
      mediaTime: options.request.frame.mediaTime,
      retryDelayMs,
      type: "frame_retrying",
    });
    await sleep(retryDelayMs, options.request.signal);
  }

  if (latestErrorResult) {
    return latestErrorResult;
  }

  throw new Error("SAM3 frame retry loop completed without a result.");
}

async function requestSam3Frame(options: {
  readonly attempt: number;
  readonly apiKey: string;
  readonly frame: Sam3StreamRequestFrame;
  readonly prompts: readonly string[];
  readonly signal: AbortSignal;
}) {
  const endpointUrl = new URL(SAM3_ENDPOINT);
  endpointUrl.searchParams.set("api_key", options.apiKey);

  try {
    const upstreamResponse = await globalThis.fetch(endpointUrl, {
      body: JSON.stringify({
        format: "rle",
        image: {
          type: "base64",
          value: options.frame.imageBase64,
        },
        model_id: SAM3_MODEL_ID,
        nms_iou_threshold: DEFAULT_NMS_IOU_THRESHOLD,
        output_prob_thresh: DEFAULT_OUTPUT_PROBABILITY_THRESHOLD,
        prompts: options.prompts.map((text) => ({ text, type: "text" })),
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      signal: options.signal,
    });
    const responseText = await upstreamResponse.text();
    const parsedResponse = parseJsonIfPossible(responseText);
    const frameContext = {
      duration: options.frame.duration,
      frameIndex: options.frame.frameIndex,
      mediaTime: options.frame.mediaTime,
    };

    if (!upstreamResponse.ok) {
      return {
        ...frameContext,
        attempt: options.attempt,
        error:
          typeof parsedResponse === "string"
            ? parsedResponse
            : upstreamResponse.statusText,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        type: "frame_error",
      };
    }

    return {
      ...frameContext,
      attempt: options.attempt,
      response: parsedResponse,
      type: "frame_complete",
    };
  } catch (error) {
    return {
      attempt: options.attempt,
      duration: options.frame.duration,
      error:
        error instanceof Error
          ? error.message
          : "Roboflow SAM3 frame request failed.",
      frameIndex: options.frame.frameIndex,
      mediaTime: options.frame.mediaTime,
      type: "frame_error",
    };
  }
}

function shouldRetrySam3Frame(result: Record<string, unknown>) {
  const status = result.status;

  return (
    status === undefined ||
    (typeof status === "number" && (status === 429 || status >= 500))
  );
}

function getRetryDelayMs(attempt: number) {
  return SAM3_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

function sleep(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("SAM3 stream request was canceled."));
      return;
    }

    const timeoutRef: { current: ReturnType<typeof setTimeout> | null } = {
      current: null,
    };
    const abort = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      signal.removeEventListener("abort", abort);
      reject(new Error("SAM3 stream request was canceled."));
    };

    timeoutRef.current = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);

    signal.addEventListener("abort", abort, { once: true });
  });
}

function parseSam3StreamRequest(value: unknown): Sam3StreamRequestBody {
  if (!isRecord(value)) {
    throw new Error("SAM3 stream body must be an object.");
  }

  const prompts = value.prompts;
  const frames = value.frames;

  if (
    !Array.isArray(prompts) ||
    prompts.length === 0 ||
    !prompts.every((prompt) => typeof prompt === "string")
  ) {
    throw new Error("SAM3 stream body must include string prompts.");
  }

  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("SAM3 stream body must include frames.");
  }

  return {
    frames: frames.map(parseSam3StreamRequestFrame),
    prompts,
  };
}

function parseSam3StreamRequestFrame(value: unknown): Sam3StreamRequestFrame {
  if (!isRecord(value)) {
    throw new Error("SAM3 stream frame must be an object.");
  }

  const { duration, frameIndex, imageBase64, mediaTime } = value;

  if (
    typeof duration !== "number" ||
    typeof frameIndex !== "number" ||
    typeof imageBase64 !== "string" ||
    typeof mediaTime !== "number"
  ) {
    throw new Error(
      "SAM3 stream frame must include duration, frameIndex, imageBase64, and mediaTime.",
    );
  }

  return {
    duration,
    frameIndex,
    imageBase64,
    mediaTime,
  };
}

function readRequestBody(request: {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function sendJson(
  response: {
    end(body: string): void;
    setHeader(name: string, value: string): void;
    statusCode: number;
  },
  statusCode: number,
  body: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function getSingleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function writeNdjson(response: ServerResponse, value: Record<string, unknown>) {
  response.write(`${JSON.stringify(value)}\n`);
}

async function runWithConcurrency<Item>(
  items: readonly Item[],
  concurrency: number,
  runItem: (item: Item) => Promise<void>,
) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const itemIndex = nextIndex;
        const item = items[itemIndex];

        nextIndex += 1;

        if (item !== undefined) {
          await runItem(item);
        }
      }
    },
  );

  await Promise.all(workers);
}

function parseJsonIfPossible(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
