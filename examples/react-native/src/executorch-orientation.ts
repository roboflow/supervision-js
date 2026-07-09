/**
 * ExecuTorch's frame orientation API is camera-centric: there is no value
 * meaning "the buffer is already screen-upright, leave inputs and outputs
 * alone". For `orientation: "up"` the model receives the buffer unrotated
 * (correct for our upright frames), but every output is then mapped into
 * "portrait screen space":
 *
 * - points/bboxes: (x, y) -> (frameHeight - y, x)
 *   (`inverseRotateBbox`/`inverseRotatePoints` in FrameTransform.cpp)
 * - masks: rotated 90° clockwise (`cv::ROTATE_90_CLOCKWISE` in
 *   `inverseRotateMat`)
 *
 * The video pipeline always feeds upright frames — the native decoder bakes
 * each file's `preferredTransform` into the decode, so portrait, landscape,
 * and upside-down recordings all come out display-upright with any
 * dimensions. That leaves exactly one deterministic output transform to
 * invert, which this module owns:
 *
 * - bboxes are un-rotated here;
 * - masks are NOT copied upright — the serialized detection carries
 *   `maskRotatedCw: true` and the ID-mask fill loops (JS and Swift) sample
 *   the rotated buffer with transposed indices.
 *
 * The live camera path is unaffected: portrait camera frames report
 * `orientation: "left"`, whose output mapping is the identity.
 */

export interface ExecutorchBbox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Inverts ExecuTorch's `orientation: "up"` output mapping, converting a bbox
 * from its "portrait screen space" back into the upright frame's coordinate
 * space. `frameHeight` is the upright frame's height (the `h` in the forward
 * mapping `(x, y) -> (h - y, x)`), for frames of any dimensions.
 */
export function unrotateExecutorchUpBbox(
  bbox: ExecutorchBbox,
  frameHeight: number,
): ExecutorchBbox {
  "worklet";

  return {
    x1: bbox.y1,
    y1: frameHeight - bbox.x2,
    x2: bbox.y2,
    y2: frameHeight - bbox.x1,
  };
}
