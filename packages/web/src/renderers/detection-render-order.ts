import type { DetectionFrame } from "supervision-js-core";

const cachedOrders = new WeakMap<DetectionFrame, readonly number[]>();

/** Dense ranks preserve zIndex and frame-order ties across retained shape layers. */
export function detectionRenderOrder(frame: DetectionFrame): readonly number[] {
  const cached = cachedOrders.get(frame);
  if (cached) return cached;

  const indexes = frame.detections.map((_, index) => index);
  indexes.sort(
    (left, right) =>
      (frame.detections[left]!.zIndex ?? left) -
        (frame.detections[right]!.zIndex ?? right) || left - right,
  );
  const order: number[] = [];
  indexes.forEach((index, rank) => {
    order[index] = rank;
  });
  cachedOrders.set(frame, order);
  return order;
}
