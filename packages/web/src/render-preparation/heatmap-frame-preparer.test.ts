import { describe, expect, it, vi } from "vitest";
import { annotationRenderers } from "supervision-js-core";
import { RenderPreparationMode } from "#types/render-preparation";
import { createHeatmapFramePreparer } from "./heatmap-frame-preparer";
import { HeatmapPreparationWorkerMessageType } from "./heatmap-preparation-worker-protocol";

describe("heatmap frame preparer", () => {
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
