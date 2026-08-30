import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import * as factoryModule from "./create-scrub-cursor";
import { EngineCore } from "./engine-core";
import { asSec, WebVideoEngineError, WebVideoEngineErrorCode } from "./types";
import { handleEngineCommand, type PostEngineEvent } from "./worker-dispatch";
import type { EngineEvent, MirrorEvent } from "./worker-protocol";
import {
  type FakeCursor,
  FakeClock,
  FakeOffscreenCanvas,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
} from "../test/fake-engine-deps";

/**
 * Router contract for handleEngineCommand: every awaitable command settles to
 * exactly one terminal response carrying its requestId, fire-and-forget commands
 * post nothing, and broadcast state stays on the engine's emit channel. A real
 * EngineCore runs behind a fake cursor so each command -> effect path is exercised
 * end to end rather than mocked.
 */

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(): {
  engine: EngineCore;
  emits: MirrorEvent[];
  posts: EngineEvent[];
  cursor: FakeCursor;
  clock: FakeClock;
  post: PostEngineEvent;
  createCursor: MockInstance;
} {
  const cursor = makeFakeCursor();
  const createCursor = vi
    .spyOn(factoryModule, "createScrubCursor")
    .mockResolvedValue(cursor);
  const emits: MirrorEvent[] = [];
  const posts: EngineEvent[] = [];
  const clock = new FakeClock();
  const engine = new EngineCore({ emit: (event) => emits.push(event), clock });
  const post: PostEngineEvent = (event) => posts.push(event);
  return { engine, emits, posts, cursor, clock, post, createCursor };
}

describe("handleEngineCommand", () => {
  it("load posts a single ready response and leaves broadcast state on emit", async () => {
    const { engine, emits, posts, post } = setup();
    await handleEngineCommand(
      engine,
      { type: "load", requestId: 7, config: LOAD_CONFIG },
      post,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      type: "ready",
      requestId: 7,
      metadata: { durationMs: 10000, naturalWidth: 1280, naturalHeight: 720 },
    });
    expect(emits.map((event) => event.type)).toEqual([
      "status",
      "duration",
      "status",
    ]);
  });

  it("play posts an ack and starts the clock", async () => {
    const { engine, posts, clock, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(engine, { type: "play", requestId: 1 }, post);
    expect(posts).toEqual([{ type: "ack", requestId: 1 }]);
    expect(clock.playing).toBe(true);
  });

  it("commit forwards the frame, awaits idle, and posts an ack", async () => {
    const { engine, posts, cursor, clock, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(
      engine,
      { type: "commit", requestId: 2, frameIndex: 60 },
      post,
    );
    expect(posts).toEqual([{ type: "ack", requestId: 2 }]);
    expect(cursor.seekToCalls.at(-1)).toBeCloseTo(2);
    expect(clock.now()).toBeCloseTo(2);
  });

  it("commit posts an ack carrying where the crisp paint landed", async () => {
    const { engine, posts, cursor, post } = setup();
    await engine.load(LOAD_CONFIG);
    engine.setCanvas(
      new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
      {
        displayWidth: 1280,
        devicePixelRatio: 1,
      },
    );
    cursor.seekSettled = async () => {
      cursor.emit(asSec(2.002));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    };
    await handleEngineCommand(
      engine,
      { type: "commit", requestId: 8, frameIndex: 60 },
      post,
    );
    expect(posts).toEqual([
      {
        type: "ack",
        requestId: 8,
        landing: { frame: { index: 60, ticks: 60000 }, mediaTimeS: 2 },
      },
    ]);
  });

  it("a preview-quality paint never names a commit landing", async () => {
    const { engine, posts, cursor, post } = setup();
    await engine.load(LOAD_CONFIG);
    engine.setCanvas(
      new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
      {
        displayWidth: 1280,
        devicePixelRatio: 1,
      },
    );
    cursor.seekSettled = async () => {
      cursor.emit(asSec(1.9), "preview");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    };
    await handleEngineCommand(
      engine,
      { type: "commit", requestId: 9, frameIndex: 60 },
      post,
    );
    expect(posts).toHaveLength(1);
    const [ack] = posts;
    if (ack.type !== "ack") throw new Error(`expected ack, got ${ack.type}`);
    expect(ack.landing).toBeUndefined();
  });

  it("step posts an ack carrying the frame the caller cannot predict", async () => {
    const { engine, posts, clock, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(
      engine,
      { type: "step", requestId: 3, direction: 1 },
      post,
    );
    expect(posts).toEqual([
      {
        type: "ack",
        requestId: 3,
        landing: { frame: { index: 1, ticks: 1000 }, mediaTimeS: 1 / 30 },
      },
    ]);
    expect(clock.now()).toBe(1 / 30);
  });

  it("step at a boundary posts an ack with no landing", async () => {
    const { engine, posts, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(
      engine,
      { type: "step", requestId: 4, direction: -1 },
      post,
    );
    expect(posts).toHaveLength(1);
    const [ack] = posts;
    if (ack.type !== "ack") throw new Error(`expected ack, got ${ack.type}`);
    expect(ack.landing).toBeUndefined();
  });

  it("a WebVideoEngineError posts an error response preserving the code", async () => {
    const { engine, posts, post, createCursor } = setup();
    createCursor.mockRejectedValueOnce(
      new WebVideoEngineError(
        WebVideoEngineErrorCode.DecodeUnsupported,
        "no codec",
      ),
    );
    await handleEngineCommand(
      engine,
      { type: "load", requestId: 9, config: LOAD_CONFIG },
      post,
    );
    expect(posts).toEqual([
      {
        type: "error",
        requestId: 9,
        error: {
          code: WebVideoEngineErrorCode.DecodeUnsupported,
          message: "no codec",
        },
      },
    ]);
  });

  it("an unexpected throw maps to BackendCrashed with the message preserved", async () => {
    const { engine, posts, post, createCursor } = setup();
    createCursor.mockRejectedValueOnce(new Error("kaboom"));
    await handleEngineCommand(
      engine,
      { type: "load", requestId: 11, config: LOAD_CONFIG },
      post,
    );
    expect(posts).toEqual([
      {
        type: "error",
        requestId: 11,
        error: {
          code: WebVideoEngineErrorCode.BackendCrashed,
          message: "kaboom",
        },
      },
    ]);
  });

  it("a fire-and-forget command drives the engine without posting a response", async () => {
    const { engine, emits, posts, clock, cursor, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(engine, { type: "scrub", frameIndex: 45 }, post);
    expect(posts).toHaveLength(0);
    expect(cursor.seekToCalls.at(-1)).toBeCloseTo(1.5);
    expect(clock.now()).toBeCloseTo(1.5);
    expect(emits).toContainEqual({ type: "seeking", seeking: true });
  });

  it("the canvas plane routes bind and unbind to the engine", async () => {
    const { engine, posts, post } = setup();
    const setCanvas = vi.spyOn(engine, "setCanvas");
    const canvas = new FakeOffscreenCanvas(
      1280,
      720,
    ) as unknown as OffscreenCanvas;
    const viewport = { displayWidth: 1280, devicePixelRatio: 2 };
    await handleEngineCommand(
      engine,
      { type: "bindCanvas", canvas, viewport },
      post,
    );
    await handleEngineCommand(engine, { type: "unbindCanvas" }, post);
    expect(posts).toHaveLength(0);
    expect(setCanvas).toHaveBeenNthCalledWith(1, canvas, viewport);
    expect(setCanvas).toHaveBeenNthCalledWith(2, null);
  });

  it("getStats posts a diagnostics snapshot (scheduler null on the uncached fake cursor)", async () => {
    const { engine, posts, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(engine, { type: "getStats", requestId: 5 }, post);
    expect(posts).toEqual([
      {
        type: "stats",
        requestId: 5,
        stats: {
          renderer: null,
          track: {
            decodeWidth: 1280,
            decodeHeight: 720,
            nativeFps: 30,
            durationS: 10,
          },
          scheduler: null,
        },
      },
    ]);
  });

  it("dispose posts an ack and closes the cursor", async () => {
    const { engine, posts, cursor, post } = setup();
    await engine.load(LOAD_CONFIG);
    await handleEngineCommand(engine, { type: "dispose", requestId: 99 }, post);
    expect(posts).toEqual([{ type: "ack", requestId: 99 }]);
    expect(cursor.closed).toBe(true);
  });

  describe("diagnostics commands", () => {
    it("diagnosticsStart/Stop and traceArm/Disarm post nothing", async () => {
      const { engine, posts, post } = setup();
      await engine.load(LOAD_CONFIG);
      const before = posts.length;
      await handleEngineCommand(
        engine,
        { type: "diagnosticsStart", hz: 10 },
        post,
      );
      await handleEngineCommand(
        engine,
        { type: "traceArm", windowMs: 1000 },
        post,
      );
      await handleEngineCommand(engine, { type: "traceDisarm" }, post);
      await handleEngineCommand(engine, { type: "diagnosticsStop" }, post);
      expect(posts.length).toBe(before);
      await engine.dispose();
    });

    it("traceExport settles exactly one traceExport response", async () => {
      const { engine, posts, post } = setup();
      await engine.load(LOAD_CONFIG);
      await handleEngineCommand(
        engine,
        { type: "traceExport", requestId: 42 },
        post,
      );
      expect(posts).toEqual([
        { type: "traceExport", requestId: 42, trace: null },
      ]);
      await engine.dispose();
    });
  });
});

describe("setPlaybackRate routing", () => {
  it("routes to the engine and posts nothing", async () => {
    const { engine, posts, post } = setup();
    await engine.load(LOAD_CONFIG);
    const before = posts.length;
    await handleEngineCommand(
      engine,
      { type: "setPlaybackRate", rate: 2 },
      post,
    );
    expect(engine.getPlaybackRate()).toBe(2);
    expect(posts.length).toBe(before);
    await engine.dispose();
  });
});
