import { MediaSessionMode, resolveMediaSessionDefaults } from "supervision";
import { describe, expect, it } from "vitest";

import { demoFixtures } from "../fixtures/demo-fixtures";
import { FIXTURE_PLAYBACK_GATE, resolveFixtureDepth } from "./fixture-session";

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

describe("the depth a sample opens with", () => {
  const spring = demoFixtures.find(
    ({ sampleName }) => sampleName === "spring_stereo_depth",
  )!;
  const manifestOf = (id: string) =>
    spring.depth!.layers.find((layer) => layer.id === id)!.manifestSrc;

  /* A reopen, such as a media path or option change, keeps the layer the
   * Style panel picked rather than snapping back to the sample's default. */
  it("opens with the layer picked, and the sample's default otherwise", () => {
    expect(resolveFixtureDepth(spring, false, "ground-truth")).toEqual({
      manifest: manifestOf("ground-truth"),
    });
    expect(resolveFixtureDepth(spring, false, null)).toEqual({
      manifest: manifestOf(spring.depth!.defaultLayer),
    });
    expect(resolveFixtureDepth(spring, false, "no-such-layer")).toEqual({
      manifest: manifestOf(spring.depth!.defaultLayer),
    });
  });

  it("opens a sample converted first without depth video", () => {
    expect(resolveFixtureDepth(spring, true, "ground-truth")).toBeUndefined();
  });
});
