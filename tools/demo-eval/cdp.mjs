/* Minimal Chrome DevTools Protocol client for the demo evaluation tool. */

import { clearTimeout, setTimeout } from "node:timers";

const { WebSocket, fetch, AbortSignal } = globalThis;

const DEFAULT_TIMEOUT_MS = 30_000;
const EVAL_CHUNK_BYTES = 262_144;
const CHUNK_BUFFER = "globalThis.__demoEvalChunkBuffer";

export async function isReachable(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listTargets(chromeDebugUrl, timeoutMs = 5000) {
  const response = await fetch(`${chromeDebugUrl}/json`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${chromeDebugUrl}/json responded ${response.status}`);
  }
  return response.json();
}

export async function openTarget(chromeDebugUrl, url, timeoutMs = 15_000) {
  const response = await fetch(
    `${chromeDebugUrl}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT", signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) {
    throw new Error(`could not open ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

export async function closeTarget(chromeDebugUrl, targetId, timeoutMs = 5000) {
  try {
    await fetch(`${chromeDebugUrl}/json/close/${targetId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /* A target that already vanished needs no closing. */
  }
}

export class CdpSession {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #closeError = null;
  #traceEvents = null;
  #traceComplete = null;
  #navigations = 0;
  #devServerPatches = 0;

  static async attach(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`could not connect to ${webSocketDebuggerUrl}`)),
        { once: true },
      );
    });
    return new CdpSession(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (message) => {
      this.#handleMessage(JSON.parse(message.data));
    });
    // A silently dropped socket would leave every awaited request pending and
    // drain the event loop without an error, so failure has to travel outward.
    socket.addEventListener("close", (event) => {
      this.#fail(
        new Error(
          `CDP socket closed with code ${event.code}` +
            (event.reason ? ` (${event.reason})` : ""),
        ),
      );
    });
    socket.addEventListener("error", () => {
      this.#fail(new Error("CDP socket errored"));
    });
  }

  get navigations() {
    return this.#navigations;
  }

  /* Vite announces every hot patch on the console. A patch re-renders the app
   * mid-window, which shows up as paint and layout the app would not otherwise
   * do, so a window that contains one is not a measurement of the app. */
  get devServerPatches() {
    return this.#devServerPatches;
  }

  #fail(error) {
    this.#closeError ??= error;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
    this.#traceComplete?.reject(error);
    this.#traceComplete = null;
  }

  #handleMessage(message) {
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${message.error.message} (${entry.method})`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method === "Tracing.dataCollected" && this.#traceEvents) {
      this.#traceEvents.push(...message.params.value);
    } else if (message.method === "Tracing.tracingComplete") {
      this.#traceComplete?.resolve();
      this.#traceComplete = null;
    } else if (
      message.method === "Page.frameNavigated" &&
      !message.params.frame.parentId
    ) {
      this.#navigations += 1;
    } else if (message.method === "Runtime.consoleAPICalled") {
      const first = message.params.args?.[0]?.value;
      if (typeof first === "string" && first.startsWith("[vite]")) {
        this.#devServerPatches += 1;
      }
    }
  }

  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.#closeError) return Promise.reject(this.#closeError);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      const { exception, text } = result.exceptionDetails;
      throw new Error(exception?.description ?? text ?? "page threw");
    }
    return result.result?.value;
  }

  /**
   * Reads a page value as JSON in fixed-size slices. A single returnByValue
   * payload is capped by the protocol transport, so a large result comes back
   * truncated or not at all instead of failing loudly.
   */
  async readJson(expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const length = await this.evaluate(
      `(async () => {
        const value = await (${expression});
        ${CHUNK_BUFFER} = JSON.stringify(value ?? null);
        return ${CHUNK_BUFFER}.length;
      })()`,
      { timeoutMs },
    );
    if (typeof length !== "number") {
      throw new Error("page did not return a serializable value");
    }
    let serialized = "";
    for (let offset = 0; offset < length; offset += EVAL_CHUNK_BYTES) {
      const slice = await this.evaluate(
        `${CHUNK_BUFFER}.slice(${offset}, ${offset + EVAL_CHUNK_BYTES})`,
      );
      if (typeof slice !== "string") {
        throw new Error("page buffer vanished mid-read (page reloaded?)");
      }
      serialized += slice;
    }
    await this.evaluate(`delete ${CHUNK_BUFFER}; 1`);
    return JSON.parse(serialized);
  }

  async trace(categories, holdMs, { completeTimeoutMs = 30_000 } = {}) {
    this.#traceEvents = [];
    await this.send("Tracing.start", {
      traceConfig: { includedCategories: categories },
      transferMode: "ReportEvents",
    });
    await delay(holdMs);
    const complete = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Tracing.tracingComplete never arrived")),
        completeTimeoutMs,
      );
      this.#traceComplete = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    await this.send("Tracing.end");
    await complete;
    const events = this.#traceEvents;
    this.#traceEvents = null;
    return events;
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* Already gone. */
    }
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
