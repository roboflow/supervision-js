import { afterEach, describe, expect, it, vi } from "vitest";

import { createEngineWorker } from "./worker-bridge";

describe("createEngineWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spawns classic workers from one shared object URL", () => {
    const blobs: Array<{ options?: BlobPropertyBag; parts?: BlobPart[] }> = [];
    const workerCalls: Array<{ options?: WorkerOptions; url: string | URL }> =
      [];
    const createObjectURL = vi.fn(() => "blob:supervision-js-web-video-engine");

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

    createEngineWorker();
    createEngineWorker();

    expect(blobs).toEqual([
      {
        options: { type: "text/javascript" },
        parts: ["__SUPERVISION_JS_EMBEDDED_ENGINE_WORKER_SOURCE__"],
      },
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(workerCalls).toEqual([
      {
        options: { name: "supervision-js-web-video-engine" },
        url: "blob:supervision-js-web-video-engine",
      },
      {
        options: { name: "supervision-js-web-video-engine" },
        url: "blob:supervision-js-web-video-engine",
      },
    ]);
  });
});
