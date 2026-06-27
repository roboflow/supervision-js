import { describe, expect, it, vi } from "vitest";

import {
  createWorkerRpcClient,
  type WorkerRpcMessage,
} from "./worker-rpc-client";

interface TestWorkerRequest extends WorkerRpcMessage {
  readonly payload: string;
  readonly type: "request";
}

interface TestWorkerResponse extends WorkerRpcMessage {
  readonly payload: string;
  readonly type: "response";
}

describe("worker rpc client", () => {
  it("matches responses to requests by request id", async () => {
    const fakeWorker = createFakeWorker();
    const client = createWorkerRpcClient<TestWorkerRequest, TestWorkerResponse>(
      {
        defaultErrorMessage: "Test worker failed.",
        isResponse: isTestResponse,
        worker: fakeWorker.worker,
      },
    );
    const responsePromise = client.request({
      payload: "hello",
      type: "request",
    });

    expect(fakeWorker.messages).toEqual([
      {
        payload: "hello",
        requestId: 1,
        type: "request",
      },
    ]);

    fakeWorker.emitMessage({
      payload: "hello back",
      requestId: 1,
      type: "response",
    });

    await expect(responsePromise).resolves.toEqual({
      payload: "hello back",
      requestId: 1,
      type: "response",
    });

    client.destroy();
  });

  it("rejects pending and future requests after worker failure", async () => {
    const fakeWorker = createFakeWorker();
    const client = createWorkerRpcClient<TestWorkerRequest, TestWorkerResponse>(
      {
        defaultErrorMessage: "Test worker failed.",
        isResponse: isTestResponse,
        worker: fakeWorker.worker,
      },
    );
    const responsePromise = client.request({
      payload: "hello",
      type: "request",
    });

    fakeWorker.emitError("worker exploded");

    await expect(responsePromise).rejects.toThrow("worker exploded");
    await expect(
      client.request({ payload: "again", type: "request" }),
    ).rejects.toThrow("worker exploded");
    expect(client.getFailureMessage()).toBe("worker exploded");

    client.destroy();
  });

  it("rejects and marks the client failed when posting to the worker throws", async () => {
    const fakeWorker = createFakeWorker({
      postMessageError: new Error("post failed"),
    });
    const client = createWorkerRpcClient<TestWorkerRequest, TestWorkerResponse>(
      {
        defaultErrorMessage: "Test worker failed.",
        isResponse: isTestResponse,
        worker: fakeWorker.worker,
      },
    );

    await expect(
      client.request({
        payload: "hello",
        type: "request",
      }),
    ).rejects.toThrow("post failed");
    await expect(
      client.request({ payload: "again", type: "request" }),
    ).rejects.toThrow("post failed");
    expect(client.getFailureMessage()).toBe("post failed");

    client.destroy();
  });

  it("passes orphaned responses to the caller for cleanup", () => {
    const fakeWorker = createFakeWorker();
    const onOrphanedResponse = vi.fn();
    const client = createWorkerRpcClient<TestWorkerRequest, TestWorkerResponse>(
      {
        defaultErrorMessage: "Test worker failed.",
        isResponse: isTestResponse,
        onOrphanedResponse,
        worker: fakeWorker.worker,
      },
    );
    const response = {
      payload: "orphan",
      requestId: 99,
      type: "response" as const,
    };

    fakeWorker.emitMessage(response);

    expect(onOrphanedResponse).toHaveBeenCalledWith(response);

    client.destroy();
  });
});

function createFakeWorker(options: { readonly postMessageError?: Error } = {}) {
  const messageListeners: Array<(event: MessageEvent<unknown>) => void> = [];
  const errorListeners: Array<(event: ErrorEvent) => void> = [];
  const messages: unknown[] = [];
  const worker = {
    addEventListener(type: string, listener: EventListener) {
      if (type === "message") {
        messageListeners.push(
          listener as (event: MessageEvent<unknown>) => void,
        );
      }

      if (type === "error") {
        errorListeners.push(listener as (event: ErrorEvent) => void);
      }
    },

    postMessage(message: unknown) {
      if (options.postMessageError) {
        throw options.postMessageError;
      }

      messages.push(message);
    },

    terminate: vi.fn(),
  } as unknown as Worker;

  return {
    emitError(message: string) {
      for (const listener of errorListeners) {
        listener({ message } as ErrorEvent);
      }
    },

    emitMessage(message: unknown) {
      for (const listener of messageListeners) {
        listener({ data: message } as MessageEvent<unknown>);
      }
    },

    messages,
    worker,
  };
}

function isTestResponse(value: unknown): value is TestWorkerResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    "type" in value &&
    value.type === "response"
  );
}
