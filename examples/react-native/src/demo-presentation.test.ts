import { describe, expect, it } from "vitest";

import { createReactNativePreparedFramePacket } from "supervision-js-react-native";

import {
  DEMO_MASK_BORDER_WIDTH,
  DEMO_MASK_FILL_OPACITY,
  createDemoBoxStyle,
  createDemoDetectionFrameFromLiveDetections,
  createDemoLabelStyle,
  createDemoMaskStyle,
  resolveDemoDetectionColor,
} from "./demo-presentation";

describe("React Native demo presentation", () => {
  it("resolves live detections through the same box and label styles", () => {
    const frame = createDemoDetectionFrameFromLiveDetections({
      detections: [
        {
          bbox: { x1: 10, x2: 110, y1: 20, y2: 220 },
          color: 0x60a5fa,
          label: "laptop",
          score: 0.96,
        },
      ],
    });

    const packet = createReactNativePreparedFramePacket({
      boxStyle: createDemoBoxStyle(),
      detectionFrame: frame,
      labelStyle: createDemoLabelStyle(),
      mediaFrame: {
        metadata: {
          duration: 1 / 30,
          frameIndex: 0,
          height: 480,
          mediaTime: 0,
          width: 640,
        },
        payload: null,
      },
    });

    expect(packet.presentation.boxes[0]?.rect).toEqual({
      height: 200,
      width: 100,
      x: 10,
      y: 20,
    });
    expect(packet.presentation.boxes[0]?.stroke?.color).toBe(0x60a5fa);
    expect(packet.presentation.labels[0]?.background?.color).toBe(0x60a5fa);
    expect(packet.presentation.labels[0]?.text).toBe("laptop 96%");
  });

  it("uses the shared class palette when detections do not carry a color", () => {
    const frame = createDemoDetectionFrameFromLiveDetections({
      detections: [
        {
          bbox: { x1: 0, x2: 20, y1: 0, y2: 40 },
          label: "tv",
          score: 0.9,
        },
      ],
    });

    const detection = frame.detections[0];

    expect(detection).toBeDefined();
    expect(resolveDemoDetectionColor(detection!, 0)).toBe(0xa78bfa);
  });

  it("keeps static and live mask styling tied to the same constants", () => {
    expect(createDemoMaskStyle().opacity).toBe(DEMO_MASK_FILL_OPACITY);
    expect(DEMO_MASK_BORDER_WIDTH).toBe(0);
  });
});
