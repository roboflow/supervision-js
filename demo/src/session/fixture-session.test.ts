import { MediaSessionMode, resolveMediaSessionDefaults } from "supervision";
import { describe, expect, it } from "vitest";

import { FIXTURE_PLAYBACK_GATE } from "./fixture-session";

describe("the gates a sample opens on", () => {
  const resolved = resolveMediaSessionDefaults({
    detections: { frames: [], sync: { frameRate: 30 } },
    mode: MediaSessionMode.File,
    playbackGate: FIXTURE_PLAYBACK_GATE,
  });

  /* A sample ships its annotations with it, so an annotation gate waits for
   * something that is already there and puts the workbench a second behind
   * what an integrating host would see. */
  it("waits for no annotations, the way the library leaves it", () => {
    expect(resolved.detectionBuffer.playbackGate).toBeUndefined();
  });

  it("still holds the picture until the frame's masks are drawn", () => {
    expect(resolved.renderPreparation.playbackGate?.enabled).toBe(true);
  });
});
