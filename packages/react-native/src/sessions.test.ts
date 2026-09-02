import { describe, expect, it, vi } from "vitest";

import {
  createReactNativeClassMaskEffectsResolver,
  createReactNativeVideoFileSession,
  createReactNativeVideoSession,
  MediaSessionError,
  REACT_NATIVE_VIDEO_SESSION_DEFAULTS,
  REACT_NATIVE_VIDEO_SESSION_CAPABILITIES,
  REACT_NATIVE_VIDEO_SESSION_PLAYBACK_MODE,
} from "./sessions";
import {
  REACT_NATIVE_FILE_SESSION_DEFAULTS,
  REACT_NATIVE_LIVE_SESSION_DEFAULTS,
} from "./sessions/media-session-defaults";
import * as sessionsEntrypoint from "./sessions";

vi.mock("@shopify/react-native-skia", () => ({
  AlphaType: { Opaque: 2 },
  ColorType: { Alpha_8: 1 },
  Skia: {},
}));

describe("createReactNativeVideoFileSession", () => {
  it("throws a diagnosable error outside a device runtime", () => {
    // Off-device (Node/Vitest) the vendor worklet runtimes or the native
    // frame source are absent; the factory must fail loudly, not hang.
    expect(() =>
      createReactNativeVideoFileSession({
        fileUri: "file:///missing.mp4",
        mediaRect: { height: 1, width: 1, x: 0, y: 0 },
        serializeFrame: () => [],
      }),
    ).toThrow(/unavailable|Cannot find module/);
  });
});

describe("React Native media session defaults", () => {
  it("keeps the legacy video name aligned with file-session defaults", () => {
    expect(REACT_NATIVE_VIDEO_SESSION_DEFAULTS).toBe(
      REACT_NATIVE_FILE_SESSION_DEFAULTS,
    );
    expect(REACT_NATIVE_LIVE_SESSION_DEFAULTS).toEqual({
      maxInstances: 6,
      targetResolution: { height: 1280, width: 720 },
    });
  });
});

describe("saved-video session capabilities", () => {
  it("declares analysis pacing and the absence of seek support", () => {
    // The constant is deprecated: pacing became a session option, so a session
    // created with `clock: "media"` reports "media-paced" instead. The constant
    // stays only as the historical default for consumers still reading it.
    expect(REACT_NATIVE_VIDEO_SESSION_PLAYBACK_MODE).toBe("analysis-paced");
    expect(REACT_NATIVE_VIDEO_SESSION_CAPABILITIES).toEqual({
      live: false,
      pausable: true,
      seekable: false,
      stoppable: true,
    });
  });

  it("keeps the exported capability contract immutable at runtime", () => {
    expect(Object.isFrozen(REACT_NATIVE_VIDEO_SESSION_CAPABILITIES)).toBe(true);
    expect(
      Reflect.set(REACT_NATIVE_VIDEO_SESSION_CAPABILITIES, "seekable", true),
    ).toBe(false);
    expect(REACT_NATIVE_VIDEO_SESSION_CAPABILITIES.seekable).toBe(false);
  });
});

describe("saved-video compatibility factory", () => {
  it("keeps the old name as a forwarding alias while consumers migrate", () => {
    expect(createReactNativeVideoSession).toBe(
      createReactNativeVideoFileSession,
    );
  });
});

describe("createReactNativeClassMaskEffectsResolver", () => {
  it("maps class effects to the matching one-based mask IDs", () => {
    const resolveEffects = createReactNativeClassMaskEffectsResolver({
      value: { person: "redact", ball: "spotlight" },
    });

    expect(
      resolveEffects([
        {
          bbox: { x1: 0, x2: 1, y1: 0, y2: 1 },
          color: 0,
          label: "person",
          mask: new Uint8Array([1]),
          maskHeight: 1,
          maskWidth: 1,
        },
        {
          bbox: { x1: 0, x2: 1, y1: 0, y2: 1 },
          color: 0,
          label: "ball",
          mask: new Uint8Array([1]),
          maskHeight: 1,
          maskWidth: 1,
        },
      ]),
    ).toEqual({ mosaicMaskIds: [1], spotlightMaskIds: [2] });
  });
});

describe("sessions entrypoint", () => {
  it("exposes the session-first contract without leaking runtime setup", () => {
    expect(
      Object.keys(
        // The Skia module is mocked above, so this verifies the actual
        // entrypoint rather than a hand-maintained declaration list.
        sessionsEntrypoint,
      ).sort(),
    ).toEqual([
      "MediaSessionError",
      "REACT_NATIVE_VIDEO_SESSION_CAPABILITIES",
      "REACT_NATIVE_VIDEO_SESSION_DEFAULTS",
      "REACT_NATIVE_VIDEO_SESSION_PLAYBACK_MODE",
      "createMediaSession",
      "createReactNativeClassMaskEffectsResolver",
      "createReactNativeVideoFileSession",
      "createReactNativeVideoSession",
    ]);
    expect(MediaSessionError.name).toBe("MediaSessionError");
  });
});
