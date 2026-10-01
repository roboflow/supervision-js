import { afterEach, describe, expect, it, vi } from "vitest";

import { encodePng } from "../../../../../test/depth-png";
import { decodeDepthPreparationRequest } from "./frame-decode";
import { createDepthFramePreparer } from "./frame-preparer";
import type { DepthPreparationWorkerRequest } from "./worker-protocol";
import { RenderPreparationMode } from "#types/render-preparation";

afterEach(() => {
  vi.restoreAllMocks();
});

type Listener = (event: { data?: unknown; message?: string }) => void;

/**
 * A worker double that answers with the real decode, or fails the way a
 * blocked or crashed worker does.
 */
function createFakeWorker(behaviour: "decode" | "fail" | "hang" = "decode") {
  const listeners = new Map<string, Listener[]>();
  const posts: {
    message: DepthPreparationWorkerRequest;
    transfer: Transferable[];
  }[] = [];
  const emit = (type: string, event: { data?: unknown; message?: string }) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const worker = {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    postMessage(
      message: DepthPreparationWorkerRequest,
      transfer: Transferable[] = [],
    ) {
      // What is transferred moves, detaching the sender's buffer; the rest
      // is copied, as a structured clone does.
      const bytes = transfer.includes(message.bytes)
        ? structuredClone(message.bytes, { transfer: [message.bytes] })
        : message.bytes.slice(0);

      posts.push({ message, transfer });
      if (behaviour === "fail") {
        queueMicrotask(() => emit("error", { message: "Worker is blocked." }));
        return;
      }
      if (behaviour === "hang") return;
      void decodeDepthPreparationRequest({ ...message, bytes }).then(
        ({ response }) => emit("message", { data: response }),
      );
    },
    terminate: vi.fn(),
  };

  return { posts, worker };
}

async function depthPng() {
  const samples = Uint16Array.from({ length: 6 * 4 }, (_, i) => i * 1000);

  return {
    bytes: () =>
      encodePng({ height: 4, samples, width: 6 }).then(
        (png) => png.slice().buffer,
      ),
    samples,
  };
}

describe("depth frame preparer", () => {
  it("decodes in the worker and transfers the bytes in Worker mode", async () => {
    const { posts, worker } = createFakeWorker();
    const { bytes, samples } = await depthPng();
    const preparer = createDepthFramePreparer({
      mode: RenderPreparationMode.Worker,
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });
    const file = await bytes();

    const decoded = await preparer.decodeDepth(file);

    expect(decoded).toMatchObject({ height: 4, width: 6 });
    expect(decoded.values).toEqual(samples);
    expect(posts[0]!.message).toMatchObject({
      bitDepth: 16,
      type: "depth-decode",
    });
    expect(posts[0]!.transfer).toEqual([file]);
    expect(file.byteLength).toBe(0);
  });

  it("falls back to the main thread in Auto when the worker cannot run, and never in Worker mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { worker } = createFakeWorker("fail");
    const { bytes, samples } = await depthPng();
    const preparer = createDepthFramePreparer({
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });

    const first = await preparer.decodeDepth(await bytes());
    const second = await preparer.decodeDepth(await bytes());

    expect(first.values).toEqual(samples);
    expect(second.values).toEqual(samples);
    expect(warn).toHaveBeenCalledOnce();

    // Worker mode never falls back.
    const required = createDepthFramePreparer({
      mode: RenderPreparationMode.Worker,
      workerFactory: {
        createWorker: () =>
          createFakeWorker("fail").worker as unknown as Worker,
      },
    });

    await expect(required.decodeDepth(await bytes())).rejects.toThrow(
      "Worker is blocked.",
    );
  });

  it("reports a bad file as a RangeError and keeps using the worker", async () => {
    const { posts, worker } = createFakeWorker();
    const { bytes } = await depthPng();
    const preparer = createDepthFramePreparer({
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });

    await expect(
      preparer.decodeDepth(new Uint8Array(40).buffer),
    ).rejects.toThrow(new RangeError("Not a PNG file."));
    await preparer.decodeDepth(await bytes());

    expect(posts).toHaveLength(2);
  });
});
