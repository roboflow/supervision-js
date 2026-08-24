import {
  KeypointMarkerShape,
  resolveDetectionClassColorStyle,
  type DetectionFrame,
  type KeypointDrawInstruction,
  type KeypointVisibility,
} from "supervision-js-core";

/**
 * Resolves keypoint geometry into renderer-neutral draw instructions.
 *
 * Package-owned rather than adapter-owned: this reads only core types, so
 * nothing about it is specific to one model runtime. It lived in the ExecuTorch
 * adapter because that is where pose support was first written, and the vendor
 * name was the last thing tying the live hook to a particular producer.
 *
 * Worklet-safe, so live producers never need to recreate Skia-oriented pose
 * geometry in an application callback.
 *
 * `color` overrides the whole frame. Left unset, each skeleton takes its class
 * color the same way `serializeReactNativeLiveDetection()` colors boxes, so a
 * producer that publishes more than one class does not draw them all alike.
 */
export function createReactNativeKeypointDrawInstructions(
  frame: DetectionFrame,
  color?: number,
): KeypointDrawInstruction[] {
  "worklet";

  const instructions: KeypointDrawInstruction[] = [];
  const notLabeledVisibility = 0 as KeypointVisibility;

  for (
    let detectionIndex = 0;
    detectionIndex < frame.detections.length;
    detectionIndex += 1
  ) {
    const detection = frame.detections[detectionIndex]!;
    const geometry = detection.keypoints;

    if (!geometry) {
      continue;
    }

    const detectionColor =
      color ??
      resolveDetectionClassColorStyle(detection.className ?? "person").fill;
    const edges: Array<KeypointDrawInstruction["edges"][number]> = [];
    const markers: Array<KeypointDrawInstruction["markers"][number]> = [];

    for (let edgeIndex = 0; edgeIndex < geometry.edges.length; edgeIndex += 1) {
      const edge = geometry.edges[edgeIndex]!;
      const from = geometry.points[edge[0]];
      const to = geometry.points[edge[1]];

      // An edge index the producer got wrong would otherwise reach the vector
      // lane as an undefined point. The skeleton was a fixed constant while
      // this lived in the adapter; an open producer contract supplies its own.
      if (!from || !to) {
        continue;
      }

      edges[edges.length] = {
        from,
        stroke: { alpha: 0.98, color: detectionColor, width: 3 },
        to,
      };
    }

    for (
      let pointIndex = 0;
      pointIndex < geometry.points.length;
      pointIndex += 1
    ) {
      if (geometry.visibility?.[pointIndex] === notLabeledVisibility) {
        continue;
      }

      markers[markers.length] = {
        fill: { alpha: 1, color: detectionColor },
        index: pointIndex,
        point: geometry.points[pointIndex]!,
        radius: 5,
        // Avoid capturing an imported enum object in VisionCamera's isolated
        // runtime. The literal is the stable renderer-neutral contract value.
        shape: "circle" as KeypointMarkerShape,
        stroke: { alpha: 1, color: detectionColor, width: 2 },
      };
    }

    instructions[instructions.length] = { edges, markers };
  }

  return instructions;
}
