import { describe, expect, it } from "vitest";

import type { LiveMediaSession, MediaSession } from "#types/media-session";
import type { MediaStreamRendererSourceOptions } from "#media/media-stream-media-source";
import {
  createAnnotationEditingEngine,
  type DraftUndoAnnotationEditingEngine,
  type BuiltInAnnotationEditingEngine,
  type ConfiguredAnnotationEditingEngine,
  type AnnotationEditingEngine,
} from "../editing";

/**
 * These fixtures are written against the public browser shapes as they existed
 * before live detection ingestion and presented-frame metadata were added.
 * They exist to fail `typecheck` if any of those additions ever becomes a
 * required member again, because that would break structurally typed consumer
 * controllers, wrappers, and test doubles that never opted into them.
 */

/** The `MediaSession` shape before live ingestion was added. */
type LegacyMediaSession = Omit<
  MediaSession,
  "appendLiveDetectionFrame" | "finalizeDetectionCoverage"
>;

/** Fails to compile if either live member becomes required on `MediaSession`. */
const legacyMediaSessionStaysAssignable: (
  session: LegacyMediaSession,
) => MediaSession = (session) => session;

/** Fails to compile if `LiveMediaSession` stops guaranteeing both members. */
const liveMediaSessionGuaranteesIngestion: (
  session: LiveMediaSession,
) => Required<
  Pick<MediaSession, "appendLiveDetectionFrame" | "finalizeDetectionCoverage">
> = (session) => session;

/** A MediaStream source configured before presented-frame metadata existed. */
const legacyMediaStreamOptions: MediaStreamRendererSourceOptions = {
  maxBufferedFrames: 4,
  timestampOrigin: "media",
};

type LegacyEditingEngine = Omit<
  AnnotationEditingEngine,
  "getHandles" | "setModifiers"
>;
const legacyEditingEngineStaysAssignable: (
  engine: LegacyEditingEngine,
) => AnnotationEditingEngine = (engine) => engine;

/** The published built-in shape before configured handle and modifier capabilities. */
type LegacyBuiltInEditingEngine = Omit<
  BuiltInAnnotationEditingEngine,
  "getHandles" | "setModifiers"
>;
const legacyBuiltInEditingEngineStaysAssignable: (
  engine: LegacyBuiltInEditingEngine,
) => BuiltInAnnotationEditingEngine = (engine) => engine;

/** Factory results guarantee both capabilities without narrowing at the call site. */
const factoryGuaranteesEditingConfiguration: (
  engine: ReturnType<typeof createAnnotationEditingEngine>,
) => Required<Pick<AnnotationEditingEngine, "getHandles" | "setModifiers">> = (
  engine,
) => engine;

describe("browser public contract compatibility", () => {
  it("keeps engines without handle and modifier capabilities assignable", () => {
    expect(typeof legacyEditingEngineStaysAssignable).toBe("function");
    expect(typeof legacyBuiltInEditingEngineStaysAssignable).toBe("function");
    expect(typeof factoryGuaranteesEditingConfiguration).toBe("function");
    const configured: ConfiguredAnnotationEditingEngine =
      createAnnotationEditingEngine();
    expect(configured.getHandles({})).toEqual([]);
    configured.setModifiers({ shiftKey: true });
  });
  it("exposes the built-in draft Undo capability through the editing entrypoint", () => {
    const engine: DraftUndoAnnotationEditingEngine =
      createAnnotationEditingEngine();

    expect(engine.undoCreation()).toBe(false);
    const builtIn: BuiltInAnnotationEditingEngine =
      createAnnotationEditingEngine();
    builtIn.pointerCancel();
  });

  it("keeps controllers written before live ingestion assignable", () => {
    expect(typeof legacyMediaSessionStaysAssignable).toBe("function");
    expect(typeof liveMediaSessionGuaranteesIngestion).toBe("function");
  });

  it("keeps MediaStream options written before presented frames assignable", () => {
    expect(legacyMediaStreamOptions.onPresentedFrame).toBeUndefined();
  });
});
