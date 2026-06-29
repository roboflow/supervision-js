import type { DetectionFrame } from "supervision-js-core";

export const basketballFrameMetadata = {
  frameIndex: 0,
  height: 1080,
  mediaTime: 0,
  width: 1920,
} as const;

export const basketballDetectionFrame: DetectionFrame = {
  detections: [
    {
      className: "white team player",
      confidence: 0.95,
      id: "white-0",
      rect: { height: 319, width: 127, x: 505, y: 158 },
    },
    {
      className: "yellow team player",
      confidence: 0.95,
      id: "yellow-0",
      rect: { height: 291, width: 219, x: 230, y: 204 },
    },
    {
      className: "basketball",
      confidence: 0.82,
      id: "ball-0",
      rect: { height: 42, width: 50, x: 273, y: 384 },
    },
  ],
  frameIndex: basketballFrameMetadata.frameIndex,
  mediaTime: basketballFrameMetadata.mediaTime,
};

export function colorForClass(className: string) {
  if (className.includes("yellow")) {
    return 0xfacc15;
  }

  if (className.includes("basketball")) {
    return 0xf97316;
  }

  return 0xe0f2fe;
}
