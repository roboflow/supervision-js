export async function* readNdjsonStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine) {
          yield JSON.parse(trimmedLine) as unknown;
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      yield JSON.parse(buffer) as unknown;
    }
  } finally {
    reader.releaseLock();
  }
}
