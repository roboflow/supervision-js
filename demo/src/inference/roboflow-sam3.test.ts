import { afterEach, describe, expect, it, vi } from "vitest";

import { inferSam3FrameBatchStream } from "./roboflow-sam3";

const request = {
  apiKey: "test-key",
  frames: [
    { duration: 1, frameIndex: 0, imageBase64: "test-image", mediaTime: 0 },
  ],
  prompts: ["object"],
};
const completeEvent = {
  duration: 1,
  frameIndex: 0,
  mediaTime: 0,
  response: { predictions: [] },
  type: "frame_complete",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inferSam3FrameBatchStream", () => {
  it.each([
    {
      event: {
        error: "Invalid image",
        frameIndex: 0,
        status: 400,
        statusText: "Bad Request",
        type: "frame_error",
      },
      message: "SAM3 frame #0 failed: 400 Bad Request Invalid image",
    },
    {
      event: { error: "Stream failed", type: "stream_error" },
      message: "Stream failed",
    },
    {
      event: { type: "unexpected" },
      message: "SAM3 stream returned an unknown event.",
    },
    {
      event: { type: "frame_complete", frameIndex: "invalid" },
      message: "SAM3 stream returned an unknown event.",
    },
  ])(
    "cancels the response body after $event.type",
    async ({ event, message }) => {
      const { cancel, stream } = mockStreamResponse([event]);

      await expect(inferSam3FrameBatchStream(request).next()).rejects.toThrow(
        message,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );

  it("cancels the response body on the done event", async () => {
    const { cancel, stream } = mockStreamResponse([{ type: "done" }]);

    expect(await inferSam3FrameBatchStream(request).next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("cancels the response body when the frame consumer breaks", async () => {
    const { cancel, stream } = mockStreamResponse([completeEvent]);

    for await (const frame of inferSam3FrameBatchStream(request)) {
      expect(frame).toEqual({
        detections: [],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      });
      break;
    }

    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("preserves the frame error if response cancellation fails", async () => {
    const { cancel, stream } = mockStreamResponse(
      [{ error: "Invalid image", frameIndex: 0, type: "frame_error" }],
      { cancel: () => Promise.reject(new Error("Cancellation failed")) },
    );

    await expect(inferSam3FrameBatchStream(request).next()).rejects.toThrow(
      "SAM3 frame #0 failed: Invalid image",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("consumes progress and frame events through EOF without cancelling", async () => {
    const { cancel, stream } = mockStreamResponse(
      [
        { frameIndex: 0, type: "frame_started" },
        { frameIndex: 0, type: "frame_retrying" },
        completeEvent,
      ],
      { close: true },
    );

    const frames = [];
    for await (const frame of inferSam3FrameBatchStream(request)) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { detections: [], endTime: 1, frameIndex: 0, mediaTime: 0 },
    ]);
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
});

function mockStreamResponse(
  events: readonly unknown[],
  options: { close?: boolean; cancel?: () => void | Promise<void> } = {},
) {
  const cancel = vi.fn(options.cancel);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          events.map((event) => `${JSON.stringify(event)}\n`).join(""),
        ),
      );
      if (options.close) {
        controller.close();
      }
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));

  return { cancel, stream };
}
