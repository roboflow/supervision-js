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

    presentVideoFrame(presentedFrame(1500), recording.targets);
    presentVideoFrame(presentedFrame(4250), recording.targets);

    for (const [step, timestamps] of recording.timestamps) {
      expect([step, timestamps]).toStrictEqual([step, [1.5, 4.25]]);
    }
  });

  it("uploads pixels, then draws, then renders once", () => {
    const recording = recordPresents();

    presentVideoFrame(presentedFrame(1000), recording.targets);

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

    presentVideoFrame(presentedFrame(1000), recording.targets);

    const adopted = recording.order.indexOf("adoptMediaTime");
    const stepsNotAfterAdoption = STEPS_AFTER_TIME_ADOPTION.filter(
      (step) => recording.order.indexOf(step) <= adopted,
    );

    expect([adopted, stepsNotAfterAdoption]).toStrictEqual([0, []]);
  });

  it("closes the frame it was handed, including when a layer throws", () => {
    const recording = recordPresents();
    const failing = presentedFrame(2000);
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

    const presented = presentedFrame(2000);
    presentVideoFrame(presented, recording.targets);
    expect(presented.frame.close).toHaveBeenCalledTimes(1);
  });

  it("reports a step that drew from a time of its own", () => {
    expect(() => assertPresentedTimestamp(3.5, 3500)).not.toThrow();
    expect(() => assertPresentedTimestamp(3.4, 3500)).toThrow(
      "Presented frame at 3500ms drew a layer at 3.4s",
    );
  });
});

function presentedFrame(mediaTimeMs: number) {
  return {
    frame: { close: vi.fn() },
    mediaTimeMs,
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
