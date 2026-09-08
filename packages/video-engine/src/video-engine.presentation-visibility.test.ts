import { afterEach, describe, expect, it, vi } from "vitest";

import { HANG_RECOVERY } from "./constants";
import { FrameTimeline } from "./frame-timeline";
import { asFps, WebVideoEngineErrorCode } from "./types";
import { WebVideoEngine, type EngineWorkerPort } from "./video-engine";
import type { EngineCommand, EngineEvent } from "./worker-protocol";
import { LOAD_CONFIG } from "../test/fake-engine-deps";

class FakeVisibilityDocument {
  hidden = true;
  added = 0;
  removed = 0;
  private readonly listeners = new Set<EventListener>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== "visibilitychange" || typeof listener !== "function") return;
    this.added += 1;
    this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    if (type !== "visibilitychange" || typeof listener !== "function") return;
    this.removed += 1;
    this.listeners.delete(listener);
  }

  becomeVisible(): void {
    this.hidden = false;
    const event = new Event("visibilitychange");
    for (const listener of this.listeners) listener(event);
  }
}

class VisibilityStallingPort implements EngineWorkerPort {
  readonly commands: EngineCommand[] = [];
  terminated = false;
  private listener: ((event: MessageEvent<EngineEvent>) => void) | null = null;

  postMessage(command: EngineCommand): void {
    this.commands.push(command);
    if (command.type === "load") {
      this.deliver({
        type: "ready",
        requestId: command.requestId,
        metadata: {
          durationMs: 10_000,
          nativeFps: asFps(30),
          naturalWidth: 1280,
          naturalHeight: 720,
          firstTimestampMs: 0,
          timeline: FrameTimeline.uniform(30, 300).toData(),
          codec: null,
          canDecode: true,
        },
      });
    }
    if (command.type === "dispose") {
      this.deliver({ type: "ack", requestId: command.requestId });
    }
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<EngineEvent>) => void,
  ): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  fail(requestId: number): void {
    this.deliver({
      type: "error",
      requestId,
      error: {
        code: WebVideoEngineErrorCode.DecoderStalled,
        message: "decoder rejected while hidden",
      },
    });
  }

  acknowledge(requestId: number, outputChanged?: boolean): void {
    this.deliver({ type: "ack", requestId, outputChanged });
  }

  private deliver(event: EngineEvent): void {
    this.listener?.({ data: event } as MessageEvent<EngineEvent>);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebVideoEngine presentation visibility", () => {
  it.each([true, false])(
    "exposes display resizing and returns the worker output-change result %s",
    async (changed) => {
      const port = new VisibilityStallingPort();
      const engine = new WebVideoEngine(
        { source: LOAD_CONFIG.source },
        () => port,
      );
      await engine.load();
      const display = { boxWidth: 640, boxHeight: 360, devicePixelRatio: 1 };
      let finished = false;
      const resizing = engine
        .toHandle()
        .setDisplay(display)
        .then((result) => {
          expect(result).toBe(changed);
          finished = true;
        });
      const command = port.commands.at(-1);
      expect(command).toMatchObject({ type: "setDisplay", display });
      if (command?.type !== "setDisplay")
        throw new Error("expected setDisplay");
      await Promise.resolve();
      expect(finished).toBe(false);
      port.acknowledge(command.requestId, changed);
      await resizing;
      expect(finished).toBe(true);
      await engine.dispose();
    },
  );

  it("does not register visibility after disposal", async () => {
    const document = new FakeVisibilityDocument();
    vi.stubGlobal("document", document);
    const createWorker = vi.fn(() => new VisibilityStallingPort());
    const engine = new WebVideoEngine(
      { source: LOAD_CONFIG.source },
      createWorker,
    );
    await engine.dispose();

    await expect(engine.load()).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });

    expect(document.added).toBe(0);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("removes visibility tracking when worker creation fails", async () => {
    const document = new FakeVisibilityDocument();
    vi.stubGlobal("document", document);
    const engine = new WebVideoEngine({ source: LOAD_CONFIG.source }, () => {
      throw new Error("worker creation failed");
    });

    await expect(engine.load()).rejects.toThrow("worker creation failed");

    expect(document.added).toBe(1);
    expect(document.removed).toBe(1);
    expect(() => document.becomeVisible()).not.toThrow();
    await engine.dispose();
  });

  it("removes visibility tracking when the first load fails and restores it on retry", async () => {
    const document = new FakeVisibilityDocument();
    vi.stubGlobal("document", document);
    const port = new VisibilityStallingPort();
    const postMessage = port.postMessage.bind(port);
    let failLoad = true;
    vi.spyOn(port, "postMessage").mockImplementation((command) => {
      if (command.type === "load" && failLoad) port.fail(command.requestId);
      else postMessage(command);
    });
    const engine = new WebVideoEngine(
      { source: LOAD_CONFIG.source },
      () => port,
    );

    await expect(engine.load()).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.DecoderStalled,
    });
    expect(document.removed).toBe(1);
    const count = port.commands.length;
    document.becomeVisible();
    expect(port.commands).toHaveLength(count);

    failLoad = false;
    await engine.load();
    expect(document.added).toBe(2);
    failLoad = true;
    await expect(engine.load()).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.DecoderStalled,
    });
    expect(document.removed).toBe(1);
    await engine.dispose();
    expect(document.removed).toBe(2);
  });

  it("uses only visible time for an outer commit deadline and disposes its listener", async () => {
    vi.useFakeTimers();
    const document = new FakeVisibilityDocument();
    vi.stubGlobal("document", document);
    const port = new VisibilityStallingPort();
    const engine = new WebVideoEngine(
      { source: LOAD_CONFIG.source },
      () => port,
    );

    await engine.load();
    expect(port.commands[0]).toEqual({
      type: "setPresentationVisibility",
      visible: false,
    });
    expect(document.added).toBe(1);

    const pending = engine.commit(2000);
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(
      HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS + 1,
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(settled).toBe(false);

    document.becomeVisible();
    await vi.advanceTimersByTimeAsync(
      HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS - 1,
    );
    expect(settled).toBe(false);
    await expect(
      vi.advanceTimersByTimeAsync(1).then(() => pending),
    ).rejects.toMatchObject({ code: WebVideoEngineErrorCode.BackendCrashed });

    await engine.dispose();
    expect(document.removed).toBe(1);
    expect(port.terminated).toBe(true);
    const commandsAfterDispose = port.commands.length;
    document.becomeVisible();
    expect(port.commands).toHaveLength(commandsAfterDispose);
  });

  it("settles a terminal decoder rejection while hidden", async () => {
    const document = new FakeVisibilityDocument();
    vi.stubGlobal("document", document);
    const port = new VisibilityStallingPort();
    const engine = new WebVideoEngine(
      { source: LOAD_CONFIG.source },
      () => port,
    );
    await engine.load();

    const pending = engine.commit(2000);
    const command = port.commands.at(-1);
    expect(command?.type).toBe("commit");
    if (command?.type !== "commit") throw new Error("expected commit");
    port.fail(command.requestId);

    await expect(pending).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.DecoderStalled,
    });
    await engine.dispose();
  });
});
