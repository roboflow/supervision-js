import assert from "node:assert/strict";
import test from "node:test";

const expectedWebRuntimeExports = [
  "BaseBoxStyle",
  "BaseFocusStyle",
  "BaseInteractionStyle",
  "BaseLabelStyle",
  "BaseMaskStyle",
  "BoxShape",
  "BoxStrokeAlignment",
  "DEFAULT_DETECTION_CLASS_STYLES",
  "DEFAULT_DETECTION_COLOR_SEQUENCE",
  "DetectionBufferStatus",
  "DetectionFrameRetentionMode",
  "DetectionFrameSelectionMode",
  "DetectionInteractionState",
  "DetectionMaskEncoding",
  "DetectionPickTarget",
  "FocusTargetMode",
  "LabelPlacement",
  "MaskRenderMode",
  "MediaInteractionMode",
  "MediaNormalizationAudioCodec",
  "MediaNormalizationContainer",
  "MediaNormalizationFit",
  "MediaNormalizationVideoCodec",
  "MediaPreparationError",
  "MediaProbeIssueCode",
  "MediaProbeStatus",
  "MediaRendererFit",
  "MediaRendererPlaybackState",
  "MediaSessionActivityKind",
  "MediaSessionActivityStatus",
  "MediaSessionMode",
  "MediaSessionStatus",
  "MediaSourceStatus",
  "RenderPreparationArtifactFrameStatus",
  "RenderPreparationArtifactKind",
  "RenderPreparationExecutionMode",
  "RenderPreparationMode",
  "RenderPreparationWorkerStatus",
  "SUPERVISION_ROBOFLOW_COLOR",
  "createArrayDetectionFrameSource",
  "createBrowserColdDetectionFrameStore",
  "createBufferedDetectionTimeline",
  "createChunkedDetectionFrameSource",
  "createColdDetectionFrameSource",
  "createCompositeDetectionFrameSource",
  "createMediaRenderer",
  "createMediaSession",
  "createMemoryColdDetectionFrameStore",
  "createWritableDetectionFrameSource",
  "normalizeDetectionClassName",
  "normalizeMedia",
  "normalizeMediaProgressively",
  "pickDetectionAtPoint",
  "prepareMedia",
  "prepareMediaProgressively",
  "probeMedia",
  "resolveDetectionClassColorStyle",
];

const expectedCoreRuntimeExports = [
  "BaseBoxStyle",
  "BaseFocusStyle",
  "BaseInteractionStyle",
  "BaseLabelStyle",
  "BaseMaskStyle",
  "BoxShape",
  "BoxStrokeAlignment",
  "DEFAULT_DETECTION_CLASS_STYLES",
  "DEFAULT_DETECTION_COLOR_SEQUENCE",
  "DetectionBufferStatus",
  "DetectionFrameRetentionMode",
  "DetectionFrameSelectionMode",
  "DetectionInteractionState",
  "DetectionMaskEncoding",
  "DetectionPickTarget",
  "FocusTargetMode",
  "LabelPlacement",
  "MaskRenderMode",
  "MediaInteractionMode",
  "MediaRendererFit",
  "MediaRendererPlaybackState",
  "MediaSessionActivityKind",
  "MediaSessionActivityStatus",
  "MediaSessionMode",
  "MediaSessionStatus",
  "MediaSourceStatus",
  "SUPERVISION_ROBOFLOW_COLOR",
  "MAX_ID_MASK_PALETTE_ENTRIES",
  "MAX_ID_MASK_STROKE_WIDTH",
  "createArrayDetectionFrameSource",
  "createBufferedDetectionTimeline",
  "createColdDetectionFrameSource",
  "createCompositeDetectionFrameSource",
  "createIdMaskFrame",
  "createMemoryColdDetectionFrameStore",
  "createWritableDetectionFrameSource",
  "normalizeDetectionClassName",
  "pickDetectionAtPoint",
  "resolveDetectionClassColorStyle",
];

const expectedReactNativeRuntimeExports = [
  "MAX_ID_MASK_PALETTE_ENTRIES",
  "MAX_ID_MASK_STROKE_WIDTH",
  "REACT_NATIVE_ID_MASK_SHADER_SOURCE",
  "createReactNativeIdMaskFrame",
  "pickReactNativeDetectionAtPoint",
  "resolveReactNativeFrameLayout",
  "resolveReactNativeFramePresentation",
  "resolveReactNativeIdMaskUniforms",
  "resolveReactNativeLabelLayout",
];

test("built core package imports without browser APIs", async () => {
  const entrypoint = await import("../packages/core/dist/index.js");

  for (const exportName of expectedCoreRuntimeExports) {
    assert.ok(exportName in entrypoint, `Expected core export ${exportName}`);
  }

  assert.equal(
    typeof entrypoint.createMemoryColdDetectionFrameStore,
    "function",
  );
  assert.equal(typeof entrypoint.BaseBoxStyle, "function");
  assert.equal(typeof entrypoint.createIdMaskFrame, "function");
  assert.equal(entrypoint.MAX_ID_MASK_PALETTE_ENTRIES, 64);
  assert.equal(entrypoint.DetectionMaskEncoding.CompressedRle, "compressedRle");
  assert.equal(entrypoint.MediaInteractionMode.PausedOnly, "pausedOnly");
});

test("built package entrypoint exposes the public runtime API", async () => {
  const entrypoint = await import("../packages/web/dist/index.js");

  assert.deepEqual(Object.keys(entrypoint).sort(), expectedWebRuntimeExports);
  assert.equal(typeof entrypoint.createMediaSession, "function");
  assert.equal(typeof entrypoint.createMediaRenderer, "function");
  assert.equal(typeof entrypoint.probeMedia, "function");
  assert.equal(typeof entrypoint.prepareMedia, "function");
  assert.equal(typeof entrypoint.prepareMediaProgressively, "function");
  assert.equal(typeof entrypoint.BaseBoxStyle, "function");
  assert.equal(typeof entrypoint.BaseFocusStyle, "function");
  assert.equal(typeof entrypoint.BaseInteractionStyle, "function");
  assert.equal(typeof entrypoint.BaseMaskStyle, "function");
  assert.equal(typeof entrypoint.BaseLabelStyle, "function");
  assert.equal(entrypoint.MediaSessionStatus.Ready, "ready");
  assert.equal(entrypoint.MediaRendererFit.Contain, "contain");
});

test("built React Native package imports core without importing web", async () => {
  const entrypoint = await import("../packages/react-native/dist/index.js");

  assert.deepEqual(
    Object.keys(entrypoint).sort(),
    expectedReactNativeRuntimeExports,
  );
  assert.equal(
    typeof entrypoint.resolveReactNativeFramePresentation,
    "function",
  );
  assert.equal(typeof entrypoint.resolveReactNativeFrameLayout, "function");
  assert.equal(typeof entrypoint.resolveReactNativeLabelLayout, "function");
  assert.equal(typeof entrypoint.pickReactNativeDetectionAtPoint, "function");
  assert.equal(typeof entrypoint.createReactNativeIdMaskFrame, "function");
  assert.equal(typeof entrypoint.resolveReactNativeIdMaskUniforms, "function");
  assert.equal(typeof entrypoint.REACT_NATIVE_ID_MASK_SHADER_SOURCE, "string");
});

test("built style classes can be constructed by package consumers", async () => {
  const entrypoint = await import("../packages/web/dist/index.js");

  const boxStyle = new entrypoint.BaseBoxStyle({
    cornerRadius: 8,
    shape: entrypoint.BoxShape.RoundedRect,
    stroke: { alpha: 1, color: 0x38bdf8, width: 3 },
  });
  const focusStyle = new entrypoint.BaseFocusStyle({
    fill: { alpha: 0.4, color: 0x020617 },
    targetMode: entrypoint.FocusTargetMode.Selected,
  });
  const interactionStyle = new entrypoint.BaseInteractionStyle({
    hover: { alpha: 1, color: 0x38bdf8, width: 2 },
    selected: { alpha: 1, color: 0xfacc15, width: 3 },
  });
  const maskStyle = new entrypoint.BaseMaskStyle({
    alpha: 0.7,
    color: 0x22c55e,
  });
  const labelStyle = new entrypoint.BaseLabelStyle({
    includeConfidence: true,
  });

  assert.equal(typeof boxStyle.resolve, "function");
  assert.equal(typeof focusStyle.resolve, "function");
  assert.equal(typeof interactionStyle.resolve, "function");
  assert.equal(typeof maskStyle.resolve, "function");
  assert.equal(typeof labelStyle.resolve, "function");
});
