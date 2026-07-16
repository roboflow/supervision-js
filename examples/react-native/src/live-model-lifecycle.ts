export type DemoMode = "static" | "live" | "video";
export type LiveInferenceMode = "segmentation" | "pose";

export interface RequestedInferenceModels {
  readonly pose: boolean;
  readonly segmentation: boolean;
}

export const INITIAL_REQUESTED_INFERENCE_MODELS: RequestedInferenceModels = {
  pose: false,
  segmentation: false,
};

/**
 * Lazily requests the model needed by the current demo state and never revokes
 * an earlier request. ExecuTorch frame worklets capture native model handles;
 * retaining a requested model for the app session prevents a mode transition
 * from unloading a handle while the camera thread can still invoke it.
 */
export function requestInferenceModelsForDemoState(
  current: RequestedInferenceModels,
  mode: DemoMode,
  liveInferenceMode: LiveInferenceMode,
): RequestedInferenceModels {
  const requestedModel =
    mode === "video"
      ? "segmentation"
      : mode === "live"
        ? liveInferenceMode
        : null;

  if (requestedModel === null || current[requestedModel]) {
    return current;
  }

  return { ...current, [requestedModel]: true };
}

export function shouldPreventInferenceModelLoad(
  requested: RequestedInferenceModels,
  model: LiveInferenceMode,
) {
  return !requested[model];
}
