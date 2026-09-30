import { afterEach, describe, expect, it, vi } from "vitest";

import { encodePng } from "../../../../test/depth-png";
import { DepthPreparationWorkerMessageType } from "./depth-preparation-worker-protocol";

type MessageListener = (event: { data: unknown }) => void;

/** Loads the worker script against a fake worker scope. */
async function loadWorker() {
  const listeners: MessageListener[] = [];
  const posted: { message: unknown; transfer: Transferable[] }[] = [];
  const replied = new Promise<void>((resolve) => {
    vi.stubGlobal(
      "addEventListener",
      (type: string, listener: MessageListener) => {
        if (type === "message") listeners.push(listener);
      },
    );
    vi.stubGlobal(
      "postMessage",
      (message: unknown, transfer: Transferable[] = []) => {
        posted.push({ message, transfer });
        resolve();
      },
    );
  });

  vi.resetModules();
  await import("./mask-preparation.worker");

  return {
    posted,
    replied,
    send: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("render-preparation worker", () => {
  it("decodes a depth PNG and transfers the samples back", async () => {
    const worker = await loadWorker();
    const samples = Uint16Array.from({ length: 3 * 2 }, (_, i) => i * 4000);
    const png = await encodePng({ height: 2, samples, width: 3 });

    worker.send({
      bitDepth: 16,
      bytes: png.slice().buffer,
      padRowsForWebGl: true,
      requestId: 7,
      type: DepthPreparationWorkerMessageType.Decode,
    });
    await worker.replied;

    const [{ message, transfer }] = worker.posted as [
      {
        message: {
          paddedUpload: { bytes: ArrayBuffer; textureWidth: number };
          values: ArrayBuffer;
        };
        transfer: Transferable[];
      },
    ];

    expect(message).toMatchObject({
      bitDepth: 16,
      height: 2,
      requestId: 7,
      type: DepthPreparationWorkerMessageType.Complete,
      width: 3,
    });
    expect(new Uint16Array(message.values)).toEqual(samples);
    expect(message.paddedUpload.textureWidth).toBe(4);
    expect(transfer).toEqual([message.values, message.paddedUpload.bytes]);
  });

  it("answers a file that does not decode with an error reply", async () => {
    const worker = await loadWorker();

    worker.send({
      bitDepth: 8,
      bytes: new ArrayBuffer(16),
      requestId: 3,
      type: DepthPreparationWorkerMessageType.Decode,
    });
    await worker.replied;

    expect(worker.posted[0]).toEqual({
      message: {
        error: "Not a PNG file.",
        requestId: 3,
        type: DepthPreparationWorkerMessageType.Error,
      },
      transfer: [],
    });
  });
});
