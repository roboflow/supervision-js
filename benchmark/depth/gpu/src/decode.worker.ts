import { decodePng16 } from "../../../../packages/web/src/render-preparation/depth-png16";

interface DecodeRequest {
  readonly id: number;
  readonly bytes: ArrayBuffer;
}

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DecodeRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

/** The same decoder the render-preparation worker runs, timed inside the worker. */
scope.addEventListener("message", (event) => {
  const { bytes, id } = event.data;
  const start = performance.now();

  decodePng16(bytes).then(
    (decoded) => {
      scope.postMessage(
        {
          decodeMs: performance.now() - start,
          id,
          values: decoded.values.buffer,
        },
        [decoded.values.buffer],
      );
    },
    (error: unknown) => {
      scope.postMessage({ error: String(error), id });
    },
  );
});
