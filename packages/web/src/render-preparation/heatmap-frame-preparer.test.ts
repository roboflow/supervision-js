import { describe, expect, it, vi } from "vitest";
import { annotationRenderers } from "supervision-js-core";
import { RenderPreparationMode } from "#types/render-preparation";
import { createHeatmapFramePreparer } from "./heatmap-frame-preparer";
import { HeatmapPreparationWorkerMessageType } from "./heatmap-preparation-worker-protocol";

describe("heatmap frame preparer", () => {
  it("does not colorize after a deferred main-thread job is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const preparer = createHeatmapFramePreparer({
        mode: RenderPreparationMode.MainThread,
      });
      const preparation = preparer.prepare(
        {
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          width: 1,
          height: 1,
          values: [0.5],
        },
        annotationRenderers.heatmap(),
      );
      const rejection = expect(preparation).rejects.toThrow("destroyed");
      preparer.destroy();
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops copying a large map when its worker is cancelled", async () => {
    const postMessage = vi.fn();
    const terminate = vi.fn();
    const preparer = createHeatmapFramePreparer({
      mode: RenderPreparationMode.Worker,
      workerFactory: {
        createWorker: () =>
          ({
            addEventListener: vi.fn(),
            postMessage,
            terminate,
          }) as unknown as Worker,
      },
    });
    const preparation = preparer.prepare(
      {
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        width: 131_073,
        height: 1,
        values: new Float32Array(131_073),
      },
      annotationRenderers.heatmap(),
    );

    preparer.destroy();
    await expect(preparation).rejects.toThrow("destroyed");
    expect(postMessage).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("transfers a private exact-score copy, leaving the caller's array intact", async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const postMessage = vi.fn(
      (
        message: { requestId: number; map: { values: Float64Array } },
        transfer: Transferable[],
      ) => {
        expect(message.map.values).toBeInstanceOf(Float64Array);
        expect(message.map.values[0]).toBe(0.12345678912345678);
        expect(transfer).toEqual([message.map.values.buffer]);
        listeners.get("message")?.({
          data: {
            error: "test complete",
            requestId: message.requestId,
            type: HeatmapPreparationWorkerMessageType.Error,
          },
        } as MessageEvent);
      },
    );
    const worker = {
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        listeners.set(type, listener);
      },
      postMessage,
      terminate: vi.fn(),
    } as unknown as Worker;
    const preparer = createHeatmapFramePreparer({
      mode: RenderPreparationMode.Worker,
      workerFactory: { createWorker: () => worker },
    });
    const values = [0.12345678912345678];

    await expect(
      preparer.prepare(
        {
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          width: 1,
          height: 1,
          values,
        },
        annotationRenderers.heatmap(),
      ),
    ).rejects.toThrow("test complete");
    expect(values).toEqual([0.12345678912345678]);
    expect(postMessage).toHaveBeenCalledOnce();
    preparer.destroy();
  });

  it("does not retry invalid heatmap data on the main thread", async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const terminate = vi.fn();
    const worker = {
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        listeners.set(type, listener);
      },
      postMessage(message: { requestId: number }) {
        listeners.get("message")?.({
          data: {
            error: "Invalid heatmap dimensions.",
            requestId: message.requestId,
            type: HeatmapPreparationWorkerMessageType.Error,
          },
        } as MessageEvent);
      },
      terminate,
    } as unknown as Worker;
    const preparer = createHeatmapFramePreparer({
      mode: RenderPreparationMode.Auto,
      workerFactory: { createWorker: () => worker },
    });
    const map = {
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      width: 1,
      height: 1,
      values: [0.5],
    };

    await expect(
      preparer.prepare(map, annotationRenderers.heatmap()),
    ).rejects.toThrow("Invalid heatmap dimensions.");
    expect(terminate).not.toHaveBeenCalled();
    preparer.destroy();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
