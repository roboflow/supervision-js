import { describe, expect, it, vi } from "vitest";

import type { DiagnosticsSnapshot } from "./diagnostics";
import { MirrorStore } from "./mirror-store";
import {
  PlaybackStatus,
  WebVideoEngineError,
  WebVideoEngineErrorCode,
} from "./types";
import {
  applyMirrorEvent,
  deserializeEngineError,
  type EngineCommand,
  isMirrorEvent,
  serializeEngineError,
  type EngineEvent,
} from "./worker-protocol";

describe("workerProtocol error serialization", () => {
  it("round-trips code and message, drops cause", () => {
    const original = new WebVideoEngineError(
      WebVideoEngineErrorCode.DecodeUnsupported,
      "no codec",
      new Error("inner"),
    );
    const wire = serializeEngineError(original);
    expect(wire).toEqual({
      code: WebVideoEngineErrorCode.DecodeUnsupported,
      message: "no codec",
    });
    const restored = deserializeEngineError(wire);
    expect(restored).toBeInstanceOf(WebVideoEngineError);
    expect(restored?.code).toBe(WebVideoEngineErrorCode.DecodeUnsupported);
    expect(restored?.message).toBe("no codec");
    expect(restored?.cause).toBeUndefined();
  });

  it("deserializes null to null", () => {
    expect(deserializeEngineError(null)).toBeNull();
  });
});

/** Frames of a 30fps source whose grain is 30000 ticks a second. */
const FRAME_27 = { index: 27, ticks: 27000 };
const FRAME_45 = { index: 45, ticks: 45000 };
const FRAME_63 = { index: 63, ticks: 63000 };

describe("isMirrorEvent", () => {
  it("accepts broadcast state events, rejects responses", () => {
    const mirror: EngineEvent[] = [
      { type: "playhead", frameId: FRAME_45, mediaTimeS: 1.5 },
      {
        type: "frame",
        paintSeq: 2,
        frameId: FRAME_45,
        mediaTimeS: 1.5,
        quality: "exact",
      },
      { type: "status", status: PlaybackStatus.Ready, error: null },
      { type: "duration", durationMs: 3 },
      { type: "seeking", seeking: true },
      { type: "rate", rate: 2 },
    ];
    const responses: EngineEvent[] = [
      { type: "ack", requestId: 1 },
      { type: "ready", requestId: 2, metadata: {} as never },
      {
        type: "error",
        requestId: 3,
        error: { code: WebVideoEngineErrorCode.Aborted, message: "x" },
      },
    ];
    mirror.forEach((e) => expect(isMirrorEvent(e)).toBe(true));
    responses.forEach((e) => expect(isMirrorEvent(e)).toBe(false));
  });

  it("rejects the diagnostics broadcast so it never enters the mirror reducer", () => {
    const diag: EngineEvent = {
      type: "diag",
      snapshot: { warnings: [] } as unknown as DiagnosticsSnapshot,
    };
    expect(isMirrorEvent(diag)).toBe(false);
  });

  it("a frame event carries where it landed, and tolerates the playing-only needle", () => {
    // Position and quality ride every paint; the catch-up needle is folded on
    // only while diagnostics are enabled and playing.
    const paused: EngineEvent = {
      type: "frame",
      paintSeq: 1,
      frameId: FRAME_27,
      mediaTimeS: 0.9,
      quality: "preview",
    };
    const playing: EngineEvent = {
      type: "frame",
      paintSeq: 2,
      frameId: FRAME_45,
      mediaTimeS: 1.5,
      quality: "exact",
      catchUpMs: 33,
    };
    expect(isMirrorEvent(paused)).toBe(true);
    expect(isMirrorEvent(playing)).toBe(true);
  });
});

describe("diagnostics protocol shapes are clone-safe", () => {
  it("the new commands carry only plain data", () => {
    const commands: EngineCommand[] = [
      { type: "diagnosticsStart", hz: 10 },
      { type: "diagnosticsStop" },
      { type: "traceArm", windowMs: 60000 },
      { type: "traceDisarm" },
      { type: "traceExport", requestId: 1 },
    ];
    for (const command of commands) {
      expect(() => structuredClone(command)).not.toThrow();
      expect(structuredClone(command)).toEqual(command);
    }
  });

  it("the traceExport response round-trips through structuredClone", () => {
    const response: EngineEvent = {
      type: "traceExport",
      requestId: 2,
      trace: null,
    };
    expect(structuredClone(response)).toEqual(response);
  });
});

describe("applyMirrorEvent", () => {
  it("maps each event variant to its store writer", () => {
    const store = new MirrorStore();
    applyMirrorEvent(store, {
      type: "playhead",
      frameId: FRAME_45,
      mediaTimeS: 1.5,
    });
    applyMirrorEvent(store, {
      type: "frame",
      paintSeq: 7,
      frameId: FRAME_63,
      mediaTimeS: 2.1,
      quality: "exact",
    });
    applyMirrorEvent(store, { type: "duration", durationMs: 9000 });
    applyMirrorEvent(store, { type: "seeking", seeking: true });
    applyMirrorEvent(store, {
      type: "status",
      status: PlaybackStatus.Errored,
      error: { code: WebVideoEngineErrorCode.SourceUnreadable, message: "404" },
    });

    expect(store.getPlayhead()).toEqual({ frame: FRAME_45, mediaTimeS: 1.5 });
    expect(store.getPaintSeq()).toBe(7);
    expect(store.getDurationMs()).toBe(9000);
    expect(store.getSeeking()).toBe(true);
    expect(store.getStatus()).toBe(PlaybackStatus.Errored);
    expect(store.getError()?.code).toBe(
      WebVideoEngineErrorCode.SourceUnreadable,
    );
  });

  it("notifies only the matching channel", () => {
    const store = new MirrorStore();
    const timeListener = vi.fn();
    const stateListener = vi.fn();
    store.subscribe("time", timeListener);
    store.subscribe("state", stateListener);

    applyMirrorEvent(store, {
      type: "playhead",
      frameId: FRAME_45,
      mediaTimeS: 1.5,
    });
    expect(timeListener).toHaveBeenCalledTimes(1);
    expect(stateListener).not.toHaveBeenCalled();

    applyMirrorEvent(store, {
      type: "status",
      status: PlaybackStatus.Playing,
      error: null,
    });
    expect(stateListener).toHaveBeenCalledTimes(1);
  });
});

describe("workerProtocol rate mirror", () => {
  it("a rate event writes the store and wakes only the rate channel", () => {
    const store = new MirrorStore();
    const rateListener = vi.fn();
    const stateListener = vi.fn();
    store.subscribe("rate", rateListener);
    store.subscribe("state", stateListener);

    applyMirrorEvent(store, { type: "rate", rate: 0.5 });

    expect(store.getRate()).toBe(0.5);
    expect(rateListener).toHaveBeenCalledTimes(1);
    expect(stateListener).not.toHaveBeenCalled();
  });

  it("replaying the rate it already holds wakes nobody", () => {
    const store = new MirrorStore();
    applyMirrorEvent(store, { type: "rate", rate: 2 });
    const listener = vi.fn();
    store.subscribe("rate", listener);
    applyMirrorEvent(store, { type: "rate", rate: 2 });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getRate()).toBe(2);
  });
});
