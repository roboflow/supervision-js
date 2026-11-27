import { describe, expect, it, vi } from "vitest";

import { readNdjsonStream } from "./ndjson-stream";

const encoder = new TextEncoder();

describe("readNdjsonStream", () => {
  it("reads complete lines and a trailing line without cancelling at EOF", async () => {
    const { cancel, stream } = createStream(
      [encoder.encode(' \n{"frame":1}\n\n{"frame":2}')],
      { close: true },
    );

    expect(await readAll(stream)).toEqual([{ frame: 1 }, { frame: 2 }]);
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("releases an empty stream without cancelling at EOF", async () => {
    const { cancel, stream } = createStream([], { close: true });

    expect(await readAll(stream)).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("preserves UTF-8 characters and JSON lines split across chunks", async () => {
    const bytes = encoder.encode('{"text":"café 🏀"}\n{"frame":2}\n');
    const { cancel, stream } = createStream(
      Array.from(bytes, (byte) => Uint8Array.of(byte)),
      { close: true },
    );

    expect(await readAll(stream)).toEqual([{ text: "café 🏀" }, { frame: 2 }]);
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("cancels an unfinished stream when the consumer breaks", async () => {
    const { cancel, stream } = createStream([
      encoder.encode('{"frame":1}\n{"frame":2}\n'),
    ]);
    const events: unknown[] = [];

    for await (const event of readNdjsonStream(stream)) {
      events.push(event);
      break;
    }

    expect(events).toEqual([{ frame: 1 }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("cancels an unfinished stream on explicit iterator return", async () => {
    const { cancel, stream } = createStream([encoder.encode('{"frame":1}\n')]);
    const iterator = readNdjsonStream(stream);

    await iterator.next();
    expect(await iterator.return()).toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("waits for cancellation before releasing the reader lock", async () => {
    let finishCancellation!: () => void;
    const { cancel, stream } = createStream([encoder.encode('{"frame":1}\n')], {
      cancel: () =>
        new Promise<void>((resolve) => {
          finishCancellation = resolve;
        }),
    });
    const iterator = readNdjsonStream(stream);

    await iterator.next();
    const returned = iterator.return();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(stream.locked).toBe(true);

    finishCancellation();
    await returned;
    expect(stream.locked).toBe(false);
  });

  it.each([false, true])(
    "cancels on malformed JSON even if cancellation rejects (%s)",
    async (rejectCancellation) => {
      const { cancel, stream } = createStream(
        [encoder.encode("invalid JSON\n")],
        {
          cancel: rejectCancellation
            ? () => Promise.reject(new Error("Cancellation failed"))
            : undefined,
        },
      );

      await expect(readNdjsonStream(stream).next()).rejects.toBeInstanceOf(
        SyntaxError,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );

  it("does not cancel when parsing a malformed trailing line after EOF", async () => {
    const { cancel, stream } = createStream([encoder.encode("invalid JSON")], {
      close: true,
    });

    await expect(readNdjsonStream(stream).next()).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("preserves an injected consumer error if cancellation fails", async () => {
    const { cancel, stream } = createStream([encoder.encode('{"frame":1}\n')], {
      cancel: () => Promise.reject(new Error("Cancellation failed")),
    });
    const iterator = readNdjsonStream(stream);
    const consumerError = new Error("Consumer failed");

    await iterator.next();
    await expect(iterator.throw(consumerError)).rejects.toBe(consumerError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("releases the lock on return even if cancellation fails", async () => {
    const { cancel, stream } = createStream([encoder.encode('{"frame":1}\n')], {
      cancel: () => Promise.reject(new Error("Cancellation failed")),
    });
    const iterator = readNdjsonStream(stream);

    await iterator.next();
    await expect(iterator.return()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("preserves a read error and releases the lock", async () => {
    const readError = new Error("Read failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(readError);
      },
    });

    await expect(readNdjsonStream(stream).next()).rejects.toBe(readError);
    expect(stream.locked).toBe(false);
  });
});

function createStream(
  chunks: readonly Uint8Array[],
  options: { close?: boolean; cancel?: () => void | Promise<void> } = {},
) {
  const cancel = vi.fn(options.cancel);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (options.close) {
        controller.close();
      }
    },
    cancel,
  });

  return { cancel, stream };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const events: unknown[] = [];
  for await (const event of readNdjsonStream(stream)) {
    events.push(event);
  }
  return events;
}
