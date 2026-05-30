export interface WorkerRpcMessage {
  readonly requestId: number;
}

interface PendingWorkerRpcRequest<Response> {
  reject(error: unknown): void;
  resolve(response: Response): void;
}

export interface WorkerRpcClient<
  Request extends WorkerRpcMessage,
  Response extends WorkerRpcMessage,
> {
  destroy(): void;
  getFailureMessage(): string | null;
  request(message: Omit<Request, "requestId">): Promise<Response>;
}

export function createWorkerRpcClient<
  Request extends WorkerRpcMessage,
  Response extends WorkerRpcMessage,
>(options: {
  readonly defaultErrorMessage: string;
  readonly isResponse: (value: unknown) => value is Response;
  readonly onOrphanedResponse?: (response: Response) => void;
  readonly worker: Worker;
}): WorkerRpcClient<Request, Response> {
  let failureMessage: string | null = null;
  let isDestroyed = false;
  let nextRequestId = 1;
  const pendingRequests = new Map<number, PendingWorkerRpcRequest<Response>>();

  options.worker.addEventListener("message", (event) => {
    handleWorkerMessage(event.data as unknown);
  });
  options.worker.addEventListener("error", (event) => {
    rejectPendingRequests(event.message || options.defaultErrorMessage);
  });
  options.worker.addEventListener("messageerror", () => {
    rejectPendingRequests(`${options.defaultErrorMessage}: message error.`);
  });

  return {
    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      rejectPendingRequests("Worker RPC client has been destroyed.", {
        markFailure: false,
      });
      options.worker.terminate();
    },

    getFailureMessage() {
      return failureMessage;
    },

    request(message) {
      if (isDestroyed) {
        return Promise.reject(
          new Error("Worker RPC client has been destroyed."),
        );
      }

      if (failureMessage) {
        return Promise.reject(new Error(failureMessage));
      }

      const request = {
        ...message,
        requestId: nextRequestId,
      } as Request;

      nextRequestId += 1;

      return new Promise<Response>((resolve, reject) => {
        pendingRequests.set(request.requestId, { reject, resolve });
        options.worker.postMessage(request);
      });
    },
  };

  function handleWorkerMessage(message: unknown) {
    if (!options.isResponse(message)) {
      return;
    }

    const pendingRequest = pendingRequests.get(message.requestId);

    if (!pendingRequest) {
      options.onOrphanedResponse?.(message);
      return;
    }

    pendingRequests.delete(message.requestId);
    pendingRequest.resolve(message);
  }

  function rejectPendingRequests(
    message: string,
    options: { readonly markFailure: boolean } = { markFailure: true },
  ) {
    if (options.markFailure) {
      failureMessage = message;
    }

    for (const pendingRequest of pendingRequests.values()) {
      pendingRequest.reject(new Error(message));
    }

    pendingRequests.clear();
  }
}
