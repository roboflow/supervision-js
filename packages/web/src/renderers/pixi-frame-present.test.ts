import { describe, expect, it, vi } from "vitest";

import type { PixiBoxLayerState } from "./pixi-box-layer";
import type { PixiRegionLayerState } from "./pixi-region-layer";
import {
  assertPresentedTimestamp,
  presentVideoFrame,
  type FramePresentTargets,
} from "./pixi-frame-present";
import type { PresentedVideoFrame } from "./presented-frame-channel";

const boxState: PixiBoxLayerState = {
  activeDetectionCount: 0,
  activeDetectionFrameIndex: null,
  activeDetectionFrameTime: null,
  activeDetectionIndexes: [],
};
const regionState: PixiRegionLayerState = { activeDetectionIndexes: [] };
const NTSC_TICK_RATE = 30000;
const NTSC_FRAME_27_SECONDS = (27 * 1001) / NTSC_TICK_RATE;

/**
 * Every step a present runs after the presented time has been adopted. Two of
 * them, `fitMediaScene` and `uploadFrame`, take no time argument and read the
 * scene's adopted one, so their pixels come from whatever moment ran last.
 */
const STEPS_AFTER_TIME_ADOPTION = [
  "fitMediaScene",
  "uploadFrame",
  "drawMask",
  "drawBox",
  "drawPolygon",
  "drawVector",
  "drawRegion",
  "drawInteraction",
  "drawFocus",
  "advanceFocus",
  "drawInteractionPresentation",
  "drawLabel",
  "drawAnnotationOverlay",
  "render",
  "completePresentation",
];

interface PresentRecording {
  readonly order: string[];
  readonly timestamps: Map<string, number[]>;
  readonly targets: FramePresentTargets;
}

describe("atomic present", () => {
  it("draws every layer from the presented timestamp alone", () => {
    const recording = recordPresents();

    presentVideoFrame(presentedFrame(1.5), recording.targets);
    presentVideoFrame(presentedFrame(4.25), recording.targets);

    for (const [step, timestamps] of recording.timestamps) {
      expect([step, timestamps]).toStrictEqual([step, [1.5, 4.25]]);
    }
  });

  it("uploads pixels, then draws, then renders once", () => {
    const recording = recordPresents();

    presentVideoFrame(presentedFrame(1), recording.targets);

    expect(recording.order).toStrictEqual([
      "adoptMediaTime",
      "fitMediaScene",
      "uploadFrame",
      "drawMask",
      "drawBox",
      "drawPolygon",
      "drawVector",
      "drawRegion",
      "drawInteraction",
      "drawFocus",
      "advanceFocus",
      "drawInteractionPresentation",
      "drawLabel",
      "drawAnnotationOverlay",
      "render",
      "completePresentation",
    ]);
  });

  it("adopts the presented time before any step that draws or uploads", () => {
    const recording = recordPresents();

    presentVideoFrame(presentedFrame(1), recording.targets);

    const adopted = recording.order.indexOf("adoptMediaTime");
    const stepsNotAfterAdoption = STEPS_AFTER_TIME_ADOPTION.filter(
      (step) => recording.order.indexOf(step) <= adopted,
    );

    expect([adopted, stepsNotAfterAdoption]).toStrictEqual([0, []]);
  });

  it("closes the frame it was handed, including when a layer throws", () => {
    const recording = recordPresents();
    const failing = presentedFrame(2);
    const targets: FramePresentTargets = {
      ...recording.targets,
      layers: {
        ...recording.targets.layers,
        drawVector: () => {
          throw new Error("layer failed");
        },
      },
    };

    expect(() => presentVideoFrame(failing, targets)).toThrow("layer failed");
    expect(failing.frame.close).toHaveBeenCalledTimes(1);

    const presented = presentedFrame(2);
    presentVideoFrame(presented, recording.targets);
    expect(presented.frame.close).toHaveBeenCalledTimes(1);
  });

  it("reports a step that drew from a time of its own", () => {
    const presented = presentedFrame(3.5, 105);

    expect(() => assertPresentedTimestamp(3.5, presented)).not.toThrow();
    expect(() => assertPresentedTimestamp(3.4, presented)).toThrow(
      "Presented frame 105 at 3.5s drew a layer at 3.4s",
    );
  });

  it("draws an NTSC frame at the second its producer published", () => {
    const recording = recordPresents();
    // Frame 27 of a 30000/1001 track. Its millisecond plane reads
    // 900.9000000000001, which divides back to a second no frame stands on.
    const presented = presentedFrame(NTSC_FRAME_27_SECONDS, 27);

    presentVideoFrame(presented, recording.targets);

    for (const [step, timestamps] of recording.timestamps) {
      expect([step, timestamps]).toStrictEqual([step, [NTSC_FRAME_27_SECONDS]]);
    }
  });
});

function presentedFrame(mediaTimeS: number, frameIndex = 0) {
  return {
    frame: { close: vi.fn() },
    frameId: { index: frameIndex, ticks: mediaTimeS * NTSC_TICK_RATE },
    mediaTimeMs: mediaTimeS * 1000,
    mediaTimeS,
  } as unknown as PresentedVideoFrame & {
    readonly frame: { readonly close: ReturnType<typeof vi.fn> };
  };
}

function recordPresents(): PresentRecording {
  const order: string[] = [];
  const timestamps = new Map<string, number[]>();
  const step = (name: string) => (mediaTime: number) => {
    order.push(name);
    timestamps.set(name, [...(timestamps.get(name) ?? []), mediaTime]);
  };

  return {
    order,
    targets: {
      adoptMediaTime: step("adoptMediaTime"),
      completePresentation: () => order.push("completePresentation"),
      fitMediaScene: () => order.push("fitMediaScene"),
      layers: {
        advanceFocus: step("advanceFocus"),
        drawAnnotationOverlay: step("drawAnnotationOverlay"),
        drawBox: (mediaTime) => {
          step("drawBox")(mediaTime);
          return boxState;
        },
        drawFocus: step("drawFocus"),
        drawInteraction: step("drawInteraction"),
        drawInteractionPresentation: step("drawInteractionPresentation"),
        drawLabel: step("drawLabel"),
        drawMask: step("drawMask"),
        drawPolygon: step("drawPolygon"),
        drawRegion: (mediaTime) => {
          step("drawRegion")(mediaTime);
          return regionState;
        },
        drawVector: step("drawVector"),
      },
      render: () => order.push("render"),
      uploadFrame: () => order.push("uploadFrame"),
    },
    timestamps,
  };
}
