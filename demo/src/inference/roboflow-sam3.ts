import type { DetectionFrame } from "supervision-js";
import { readNdjsonStream } from "./ndjson-stream";
import { normalizeSam3Detections } from "./sam3-response-normalizer";

const SAM3_PROXY_ENDPOINT = "/api/roboflow/sam3/concept_segment";
const SAM3_STREAM_ENDPOINT = "/api/roboflow/sam3/concept_segment_stream";
const API_KEY_HEADER = "x-roboflow-api-key";
const SAM3_MODEL_ID = "sam3/sam3_final";
const DEFAULT_OUTPUT_PROBABILITY_THRESHOLD = 0.1;
const DEFAULT_NMS_IOU_THRESHOLD = 0.5;

export interface Sam3FrameRequest {
  readonly apiKey: string;
  readonly prompts: readonly string[];
  readonly imageBase64: string;
  readonly signal?: AbortSignal;
}

export interface Sam3FrameContext {
  readonly frameIndex: number;
  readonly mediaTime: number;
  readonly duration: number;
}

export interface Sam3StreamFrameRequest extends Sam3FrameContext {
  readonly imageBase64: string;
}

export interface Sam3FrameBatchRequest {
  readonly apiKey: string;
  readonly frames: readonly Sam3StreamFrameRequest[];
  readonly prompts: readonly string[];
  readonly signal?: AbortSignal;
}

export async function inferSam3Frame(
  request: Sam3FrameRequest,
  context: Sam3FrameContext,
): Promise<DetectionFrame> {
  const response = await fetch(SAM3_PROXY_ENDPOINT, {
    body: JSON.stringify(createSam3FrameRequestBody(request)),
    headers: {
      "content-type": "application/json",
      [API_KEY_HEADER]: request.apiKey,
    },
    method: "POST",
    signal: request.signal,
  });
  const responseText = await response.text();
  const parsedResponse = parseJsonIfPossible(responseText);

  if (!response.ok) {
    throw new Error(formatSam3Error(response, parsedResponse));
  }

  return createDetectionFrame(parsedResponse, request.prompts, context);
}

export async function* inferSam3FrameBatchStream(
  request: Sam3FrameBatchRequest,
): AsyncGenerator<DetectionFrame, void, unknown> {
  const response = await fetch(SAM3_STREAM_ENDPOINT, {
    body: JSON.stringify({
      frames: request.frames,
      prompts: request.prompts,
    }),
    headers: {
      "content-type": "application/json",
      [API_KEY_HEADER]: request.apiKey,
    },
    method: "POST",
    signal: request.signal,
  });

  if (!response.ok) {
    throw new Error(
      formatSam3Error(response, parseJsonIfPossible(await response.text())),
    );
  }

  if (!response.body) {
    throw new Error("SAM3 stream response did not include a readable body.");
  }

  for await (const event of readNdjsonStream(response.body)) {
    if (isFrameStartedEvent(event) || isFrameRetryingEvent(event)) {
      continue;
    }

    if (isDoneEvent(event)) {
      return;
    }

    if (isFrameErrorEvent(event)) {
      throw new Error(formatSam3StreamFrameError(event));
    }

    if (isFrameCompleteEvent(event)) {
      yield createDetectionFrame(event.response, request.prompts, event);
      continue;
    }

    if (isStreamErrorEvent(event)) {
      throw new Error(event.error);
    }

    throw new Error("SAM3 stream returned an unknown event.");
  }
}

function createSam3FrameRequestBody(request: {
  readonly imageBase64: string;
  readonly prompts: readonly string[];
}) {
  return {
    format: "rle",
    image: {
      type: "base64",
      value: request.imageBase64,
    },
    model_id: SAM3_MODEL_ID,
    nms_iou_threshold: DEFAULT_NMS_IOU_THRESHOLD,
    output_prob_thresh: DEFAULT_OUTPUT_PROBABILITY_THRESHOLD,
    prompts: request.prompts.map((text) => ({ text, type: "text" })),
  };
}

function createDetectionFrame(
  response: unknown,
  prompts: readonly string[],
  context: Sam3FrameContext,
): DetectionFrame {
  return {
    detections: normalizeSam3Detections(response, prompts),
    endTime: context.mediaTime + context.duration,
    frameIndex: context.frameIndex,
    mediaTime: context.mediaTime,
  };
}

function parseJsonIfPossible(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function formatSam3Error(response: Response, body: unknown) {
  return `SAM3 request failed: ${response.status} ${response.statusText}${
    typeof body === "string" ? ` ${body}` : ""
  }`;
}

function isFrameStartedEvent(value: unknown): value is {
  readonly type: "frame_started";
} {
  return isRecord(value) && value.type === "frame_started";
}

function isFrameRetryingEvent(value: unknown): value is {
  readonly type: "frame_retrying";
} {
  return isRecord(value) && value.type === "frame_retrying";
}

function isDoneEvent(value: unknown): value is { readonly type: "done" } {
  return isRecord(value) && value.type === "done";
}

function isFrameCompleteEvent(value: unknown): value is Sam3FrameContext & {
  readonly response: unknown;
  readonly type: "frame_complete";
} {
  return (
    isRecord(value) &&
    value.type === "frame_complete" &&
    typeof value.duration === "number" &&
    typeof value.frameIndex === "number" &&
    typeof value.mediaTime === "number"
  );
}

function isFrameErrorEvent(value: unknown): value is {
  readonly duration?: number;
  readonly error: string;
  readonly frameIndex: number;
  readonly mediaTime?: number;
  readonly status?: number;
  readonly statusText?: string;
  readonly type: "frame_error";
} {
  return (
    isRecord(value) &&
    value.type === "frame_error" &&
    typeof value.error === "string" &&
    typeof value.frameIndex === "number"
  );
}

function isStreamErrorEvent(value: unknown): value is {
  readonly error: string;
  readonly type: "stream_error";
} {
  return (
    isRecord(value) &&
    value.type === "stream_error" &&
    typeof value.error === "string"
  );
}

function formatSam3StreamFrameError(error: {
  readonly error: string;
  readonly frameIndex: number;
  readonly status?: number;
  readonly statusText?: string;
}) {
  const status = error.status
    ? ` ${error.status}${error.statusText ? ` ${error.statusText}` : ""}`
    : "";

  return `SAM3 frame #${error.frameIndex} failed:${status} ${error.error}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
