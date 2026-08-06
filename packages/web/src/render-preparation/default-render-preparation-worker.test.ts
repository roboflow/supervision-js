import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRenderPreparationWorkerFactory } from "./default-render-preparation-worker";

describe("default render-preparation worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses one object URL for self-contained classic workers", () => {
    const blobs: Array<{
      readonly options?: BlobPropertyBag;
      readonly parts?: BlobPart[];
    }> = [];
    const workerCalls: Array<{
      readonly options?: WorkerOptions;
      readonly url: string | URL;
    }> = [];
    const createObjectURL = vi.fn(() => "blob:supervision-js-worker");

    class FakeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        blobs.push({ options, parts });
      }
    }

    class FakeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        workerCalls.push({ options, url });
      }
    }

    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("URL", { createObjectURL });
    vi.stubGlobal("Worker", FakeWorker);

    const factory = createDefaultRenderPreparationWorkerFactory();

    factory.createWorker();
    factory.createWorker();

    expect(blobs).toEqual([
      {
        options: { type: "text/javascript" },
        parts: ["__SUPERVISION_JS_EMBEDDED_MASK_PREPARATION_WORKER_SOURCE__"],
      },
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(workerCalls).toEqual([
      {
        options: { name: "supervision-js-render-preparation" },
        url: "blob:supervision-js-worker",
      },
      {
        options: { name: "supervision-js-render-preparation" },
        url: "blob:supervision-js-worker",
      },
    ]);
  });
});
