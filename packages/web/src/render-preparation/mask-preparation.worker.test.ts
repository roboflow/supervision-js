import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeBinaryMask } from "supervision-js-core";

import { encodePng } from "../../../../test/depth-png";
import { DepthPreparationWorkerMessageType } from "./depth/worker-protocol";
import { MaskPreparationWorkerMessageType } from "./mask-preparation-worker-protocol";
import type { MaskPreparationWorkerCompleteMessage } from "./mask-preparation-worker-protocol";

type MessageListener = (event: { data: unknown }) => void;

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
  it.each([0, 100])(
    "transfers screen stroke paths for detection %i without baking their width into the mask",
    async (detectionIndex) => {
      vi.stubGlobal(
        "ImageData",
        class {
          constructor(
            readonly data: Uint8ClampedArray,
            readonly width: number,
            readonly height: number,
          ) {}
        },
      );
      const worker = await loadWorker();
      worker.send({
        type: MaskPreparationWorkerMessageType.Prepare,
        requestId: 9,
        job: {
          key: "screen-outline",
          instructions: [
            {
              alpha: 0.45,
              color: 0xff0000,
              detectionIndex,
              mask: encodeBinaryMask(
                new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]),
                3,
                3,
              ),
              stroke: {
                alpha: 1,
                color: 0x00ff00,
                width: 2,
                widthUnit: "screen",
              },
            },
          ],
        },
      });
      await worker.replied;
      const [{ message, transfer }] = worker.posted as [
        {
          message: MaskPreparationWorkerCompleteMessage;
          transfer: Transferable[];
        },
      ];
      expect(message.type).toBe(MaskPreparationWorkerMessageType.Complete);
      expect(message.screenStrokes?.[0]).toMatchObject({
        detectionIndex,
        width: 2,
      });
      expect(message.screenStrokes?.[0]?.paths).toHaveLength(2);
      for (const path of message.screenStrokes![0]!.paths)
        expect(transfer).toContain(path.buffer);
      if (detectionIndex === 0) expect(message.hasStroke).toBe(false);
      else
        expect([...message.imageData!.data.slice(0, 4)]).toEqual([
          255, 0, 0, 115,
        ]);
    },
  );

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

  it("copies a preview frame's luma, transfers it back and closes the frame", async () => {
    const worker = await loadWorker();
    const frame = {
      allocationSize: () => 4 * 2 * 2,
      close: vi.fn(),
      codedHeight: 2,
      codedWidth: 4,
      async copyTo(destination: ArrayBuffer) {
        new Uint8Array(destination).set([20, 21, 22, 23, 24, 25, 26, 27]);
        return [{ offset: 0, stride: 4 }];
      },
      format: "I420",
      visibleRect: { height: 2, width: 4, x: 0, y: 0 },
    };

    worker.send({
      correction: null,
      frame,
      requestId: 5,
      type: DepthPreparationWorkerMessageType.PreviewLuma,
    });
    await worker.replied;

    const [{ message, transfer }] = worker.posted as [
      {
        message: { luma: ArrayBuffer; path: string; type: string };
        transfer: Transferable[];
      },
    ];

    expect(message.type).toBe(
      DepthPreparationWorkerMessageType.PreviewLumaComplete,
    );
    expect([...new Uint8Array(message.luma)]).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27,
    ]);
    expect(message.path).toBe("plane");
    expect(transfer).toEqual([message.luma]);
    await vi.waitFor(() => expect(frame.close).toHaveBeenCalledOnce());
  });
});
