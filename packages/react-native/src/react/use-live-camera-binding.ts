import {
  useVisionCameraFrameOutput,
  type VisionCameraFrame,
  type VisionCameraFrameOutputBinding,
  type VisionCameraFrameOutputOptions,
} from "../adapters/vision-camera";

/**
 * React-facing strict-sync camera binding. Hosts inject semantic processing;
 * the package retains the VisionCamera output/renderer lifecycle.
 */
export function useReactNativeLiveCameraBinding<
  TFrame extends VisionCameraFrame,
>(
  options: VisionCameraFrameOutputOptions<TFrame>,
): VisionCameraFrameOutputBinding {
  return useVisionCameraFrameOutput(options);
}
