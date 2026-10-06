import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

import {
  handleSam3StreamRequest,
  SAM3_STREAM_PATH,
} from "../../server/roboflow-sam3-plugin";
import { inferSam3FrameBatchStream } from "./roboflow-sam3";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("closes the SAM3 connection and aborts another frame after a frame error", async () => {
  const networkFetch = globalThis.fetch;
  const upstreamAborted = deferred<void>();
  const connectionClosed = deferred<boolean>();
  const handlerFinished = deferred<void>();
  const abortController = new AbortController();
  let pendingSignal: AbortSignal | undefined;
  const server = createServer((request, response) => {
    response.once("close", () => {
      connectionClosed.resolve(response.writableEnded);
    });
    void handleSam3StreamRequest(request, response).then(
      handlerFinished.resolve,
      handlerFinished.reject,
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a local TCP server address.");
    }
    const endpoint = `http://127.0.0.1:${address.port}${SAM3_STREAM_PATH}`;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (input === SAM3_STREAM_PATH) {
          return networkFetch(endpoint, init);
        }
        if (
          !(input instanceof URL) ||
          input.origin !== "https://serverless.roboflow.com" ||
          typeof init?.body !== "string" ||
          !init.signal
        ) {
          throw new Error("Unexpected fetch in local SAM3 test.");
        }

        const body = JSON.parse(init.body) as { image: { value: string } };
        if (body.image.value === "failed-frame") {
          return Promise.resolve(
            new Response("Invalid image", {
              status: 400,
              statusText: "Bad Request",
            }),
          );
        }

        const signal = init.signal;
        pendingSignal = signal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              upstreamAborted.resolve();
              reject(new Error("Mock upstream request aborted"));
            },
            { once: true },
          );
        });
      }),
    );

    const iterator = inferSam3FrameBatchStream({
      apiKey: "test-key",
      frames: ["failed-frame", "pending-frame"].map(
        (imageBase64, frameIndex) => ({
          duration: 1,
          frameIndex,
          imageBase64,
          mediaTime: frameIndex,
        }),
      ),
      prompts: ["object"],
      signal: abortController.signal,
    });

    await expect(iterator.next()).rejects.toThrow(
      "SAM3 frame #0 failed: 400 Bad Request Invalid image",
    );
    await vi.waitFor(() => expect(pendingSignal?.aborted).toBe(true));
    await upstreamAborted.promise;
    expect(await connectionClosed.promise).toBe(false);
    await handlerFinished.promise;
  } finally {
    abortController.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
