import { describe, expect, it } from "vitest";

import {
  INITIAL_REQUESTED_INFERENCE_MODELS,
  requestInferenceModelsForDemoState,
  shouldPreventInferenceModelLoad,
} from "./live-model-lifecycle";

describe("React Native live model lifecycle", () => {
  it("retains loaded models while switching from segmentation to pose", () => {
    const withSegmentation = requestInferenceModelsForDemoState(
      INITIAL_REQUESTED_INFERENCE_MODELS,
      "live",
      "segmentation",
    );
    const withPose = requestInferenceModelsForDemoState(
      withSegmentation,
      "live",
      "pose",
    );

    expect(withPose).toEqual({ pose: true, segmentation: true });
    expect(shouldPreventInferenceModelLoad(withPose, "segmentation")).toBe(
      false,
    );
    expect(shouldPreventInferenceModelLoad(withPose, "pose")).toBe(false);
  });

  it("keeps requested models alive outside live mode for the app session", () => {
    const activeModels = { pose: true, segmentation: true } as const;
    const requested = requestInferenceModelsForDemoState(
      activeModels,
      "static",
      "segmentation",
    );

    expect(requested).toBe(activeModels);
    expect(requested).toEqual({ pose: true, segmentation: true });
  });

  it("requests segmentation for the video demo without loading pose", () => {
    const requested = requestInferenceModelsForDemoState(
      INITIAL_REQUESTED_INFERENCE_MODELS,
      "video",
      "pose",
    );

    expect(requested).toEqual({ pose: false, segmentation: true });
  });
});
