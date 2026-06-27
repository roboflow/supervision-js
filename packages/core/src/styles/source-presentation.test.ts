import { describe, expect, it } from "vitest";

import { BaseBoxStyle } from "#styles/box-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import {
  createSourceAwarePresentation,
  type PresentationStyleSet,
} from "#styles/source-presentation";
import type { DetectionFrame } from "#types/detections";
import { DetectionMaskEncoding } from "#types/detections";
import type { FocusStyle } from "#types/focus-style";
import type { InteractionStyle } from "#types/interaction-style";

interface TestRendererPresentation extends PresentationStyleSet {
  readonly focusStyle?: FocusStyle | null;
  readonly interactionStyle?: InteractionStyle | null;
}

const frame: DetectionFrame = {
  detections: [],
  mediaTime: 0,
};

describe("createSourceAwarePresentation", () => {
  it("lets source styles override global box, mask, and label styles", () => {
    const presentation = createSourceAwarePresentation(
      {
        boxStyle: new BaseBoxStyle({
          stroke: { color: 0xff0000, width: 1 },
        }),
        labelStyle: new BaseLabelStyle({
          text: "global",
        }),
        maskStyle: new BaseMaskStyle({
          color: 0xff0000,
        }),
      },
      [
        {
          id: "ephemeral",
          presentation: {
            boxStyle: new BaseBoxStyle({
              stroke: { color: 0x00ff00, width: 3 },
            }),
            labelStyle: new BaseLabelStyle({
              text: "ephemeral",
            }),
            maskStyle: new BaseMaskStyle({
              color: 0x00ff00,
            }),
          },
        },
      ],
    );

    expect(
      presentation.boxStyle?.resolve(createDetection("base"), {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      })?.stroke,
    ).toMatchObject({ color: 0xff0000, width: 1 });
    expect(
      presentation.boxStyle?.resolve(createDetection("ephemeral"), {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      })?.stroke,
    ).toMatchObject({ color: 0x00ff00, width: 3 });
    expect(
      presentation.labelStyle?.resolve(createDetection("ephemeral"), {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      })?.text,
    ).toBe("ephemeral");
    expect(
      presentation.maskStyle?.resolve(createDetection("ephemeral"), {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      })?.color,
    ).toBe(0x00ff00);
  });

  it("treats null source presentation styles as layer disables", () => {
    const presentation = createSourceAwarePresentation(
      {
        boxStyle: new BaseBoxStyle(),
        labelStyle: new BaseLabelStyle({ text: "visible" }),
        maskStyle: new BaseMaskStyle(),
      },
      [
        {
          id: "hidden",
          presentation: {
            boxStyle: null,
            labelStyle: null,
            maskStyle: null,
          },
        },
      ],
    );

    const hiddenDetection = createDetection("hidden");
    const context = { detectionIndex: 0, frame, mediaTime: 0 };

    expect(presentation.boxStyle?.resolve(hiddenDetection, context)).toBe(
      undefined,
    );
    expect(presentation.labelStyle?.resolve(hiddenDetection, context)).toBe(
      undefined,
    );
    expect(presentation.maskStyle?.resolve(hiddenDetection, context)).toBe(
      undefined,
    );
  });

  it("keeps global interaction and focus styles source-aware without wrapping them", () => {
    const globalPresentation: TestRendererPresentation = {
      focusStyle: {
        resolve({ selectedPick }) {
          if (!selectedPick) {
            return undefined;
          }

          return {
            fill: {
              alpha: selectedPick.detection.sourceId === "draft" ? 0.5 : 0.25,
              color: 0,
            },
            targets: [selectedPick],
          };
        },
      },
      interactionStyle: {
        resolve(detection) {
          return detection.sourceId === "draft"
            ? { boxStyle: new BaseBoxStyle({ stroke: { color: 0xff00ff } }) }
            : undefined;
        },
      },
    };

    const presentation = createSourceAwarePresentation(globalPresentation, [
      { id: "draft", presentation: {} },
    ]);

    expect(presentation.focusStyle).toBe(globalPresentation.focusStyle);
    expect(presentation.interactionStyle).toBe(
      globalPresentation.interactionStyle,
    );
  });
});

function createDetection(sourceId: string) {
  return {
    className: "person",
    mask: {
      counts: "01",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 1,
      width: 1,
    },
    rect: { height: 10, width: 10, x: 1, y: 2 },
    sourceId,
  };
}
