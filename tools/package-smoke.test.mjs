import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";

const expectedWebRuntimeExports = [
  "BaseBoxCornerStyle",
  "BaseBoxStyle",
  "BaseFocusStyle",
  "BaseInteractionStyle",
  "BaseKeypointStyle",
  "BaseLabelStyle",
  "BaseMarkerStyle",
  "BaseMaskStyle",
  "BasePolygonStyle",
  "BasePolylineStyle",
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
  "DetectionPostProcessingMode",
  "DetectionTimelineOrigin",
  "FocusTargetMode",
  "KeypointMarkerShape",
  "KeypointVisibility",
  "LabelPlacement",
  "LabelVisibilityMode",
  "MarkerShape",
  "MarkerSizeSpace",
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
  "RegionRendererComposeMode",
  "RegionRendererRegionKind",
  "RegionRendererSourceKind",
  "RenderPreparationArtifactFrameStatus",
  "RenderPreparationArtifactKind",
  "RenderPreparationExecutionMode",
  "RenderPreparationMode",
  "RenderPreparationWorkerStatus",
  "SUPERVISION_ROBOFLOW_COLOR",
  "TrackingGeometry",
  "annotationRendererKinds",
  "annotationRenderers",
  "createArrayDetectionFrameSource",
  "createBrowserColdDetectionFrameStore",
  "createBufferedDetectionTimeline",
  "createByteTrackTracker",
  "createCBIoUTracker",
  "createChunkedDetectionFrameSource",
  "createColdDetectionFrameSource",
  "createCompositeDetectionFrameSource",
  "createDefaultAnnotationPresentation",
  "createDefaultDetectionPostProcessingWorkerFactory",
  "createDetectionPostProcessingPipeline",
  "createImageUrlMediaSource",
  "createMediaRenderer",
  "createMediaSession",
  "createMediaStreamRendererSource",
  "createMemoryColdDetectionFrameStore",
  "createOCSortTracker",
  "createSortTracker",
  "createStaticImageMediaSource",
  "createWritableDetectionFrameSource",
  "detectionPostProcessors",
  "normalizeDetectionClassName",
  "normalizeMedia",
  "normalizeMediaProgressively",
  "pickDetectionAtPoint",
  "prepareMedia",
  "prepareMediaProgressively",
  "probeMedia",
  "projectDetectionFrameForTracking",
  "resolveDetectionClassColorStyle",
];

const expectedCoreRuntimeExports = [
  "BaseBoxStyle",
  "BaseBoxCornerStyle",
  "BaseFocusStyle",
  "BaseInteractionStyle",
  "BaseLabelStyle",
  "BaseMarkerStyle",
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
  "MarkerShape",
  "MarkerSizeSpace",
  "MediaInteractionMode",
  "MediaRendererFit",
  "MediaRendererPlaybackState",
  "MediaSessionActivityKind",
  "MediaSessionActivityStatus",
  "MediaSessionMode",
  "MediaSessionStatus",
  "MediaSourceStatus",
  "RegionRendererComposeMode",
  "RegionRendererRegionKind",
  "RegionRendererSourceKind",
  "SUPERVISION_ROBOFLOW_COLOR",
  "TrackingGeometry",
  "annotationRendererKinds",
  "annotationRenderers",
  "MAX_ID_MASK_PALETTE_ENTRIES",
  "MAX_ID_MASK_STROKE_WIDTH",
  "createArrayDetectionFrameSource",
  "createBufferedDetectionTimeline",
  "createByteTrackTracker",
  "createCBIoUTracker",
  "createColdDetectionFrameSource",
  "createCompositeDetectionFrameSource",
  "createDefaultAnnotationPresentation",
  "createIdMaskFrame",
  "createMemoryColdDetectionFrameStore",
  "createOCSortTracker",
  "createSortTracker",
  "createWritableDetectionFrameSource",
  "detectionPostProcessors",
  "normalizeDetectionClassName",
  "pickDetectionAtPoint",
  "projectDetectionFrameForTracking",
  "resolveDetectionClassColorStyle",
];

const expectedReactNativeRuntimeExports = [
  "BaseBoxStyle",
  "BaseKeypointStyle",
  "BaseLabelStyle",
  "BaseMaskStyle",
  "BasePolygonStyle",
  "BasePolylineStyle",
  "BoxShape",
  "BoxStrokeAlignment",
  "DEFAULT_DETECTION_CLASS_STYLES",
  "DEFAULT_DETECTION_COLOR_SEQUENCE",
  "DEFAULT_REACT_NATIVE_ID_MASK_EDGE_SMOOTHING",
  "DetectionMaskEncoding",
  "KeypointMarkerShape",
  "LabelPlacement",
  "MAX_ID_MASK_PALETTE_ENTRIES",
  "MAX_ID_MASK_STROKE_WIDTH",
  "MaskRenderMode",
  "MediaSessionActivityKind",
  "MediaSessionActivityStatus",
  "MediaSessionError",
  "MediaSessionMode",
  "MediaSessionStatus",
  "REACT_NATIVE_FILE_SESSION_DEFAULTS",
  "REACT_NATIVE_ID_MASK_SHADER_SOURCE",
  "REACT_NATIVE_LIVE_ID_MASK_DEFAULTS",
  "REACT_NATIVE_LIVE_ID_MASK_NATIVE_BUILDER_NAME",
  "REACT_NATIVE_LIVE_SESSION_DEFAULTS",
  "REACT_NATIVE_VIDEO_FRAME_SOURCE_NAME",
  "RegionRendererComposeMode",
  "RegionRendererRegionKind",
  "RegionRendererSourceKind",
  "SUPERVISION_ROBOFLOW_COLOR",
  "annotationRendererKinds",
  "annotationRenderers",
  "createEmptyReactNativeLiveIdMaskUniforms",
  "createReactNativeAnnotationGestureAdapter",
  "createReactNativeIdMaskFrame",
  "createReactNativeLiveIdMaskArtifact",
  "createReactNativeLiveIdMaskArtifactAuto",
  "createReactNativeLiveIdMaskArtifactWithNativeBuilder",
  "createReactNativePreparedFramePacket",
  "createReactNativeVideoFrameSource",
  "decodeCompressedRleMask",
  "getReactNativeVideoFilePlatformAvailability",
  "isReactNativeLiveIdMaskNativeBuilderAvailable",
  "loadReactNativeLiveIdMaskNativeBuilder",
  "normalizeDetectionClassName",
  "pickDetectionAtPoint",
  "pickReactNativeDetectionAtPoint",
  "resolveAnnotationRendererPresentation",
  "resolveDetectionClassColorStyle",
  "resolveReactNativeFrameLayout",
  "resolveReactNativeFramePresentation",
  "resolveReactNativeIdMaskUniforms",
  "resolveReactNativeLabelLayout",
  "resolveReactNativeLiveIdMaskArtifactSize",
  "resolveReactNativeLiveIdMaskUniforms",
];

test("browser package manifest is ready for public npm publishing", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../packages/web/package.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(manifest.name, "supervision");
  assert.match(manifest.version, /^(?!0\.0\.0$)\d+\.\d+\.\d+(?:-.+)?$/);
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.dependencies?.react, undefined);
  assert.equal(manifest.dependencies?.["react-dom"], undefined);
  assert.equal(manifest.peerDependencies?.react, undefined);
  assert.equal(manifest.peerDependencies?.["react-dom"], undefined);
});

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
  assert.equal(typeof entrypoint.annotationRenderers.box, "function");
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
  assert.equal(typeof entrypoint.createMediaStreamRendererSource, "function");
  assert.equal(typeof entrypoint.probeMedia, "function");
  assert.equal(typeof entrypoint.prepareMedia, "function");
  assert.equal(typeof entrypoint.prepareMediaProgressively, "function");
  assert.equal(typeof entrypoint.BaseBoxStyle, "function");
  assert.equal(typeof entrypoint.BaseFocusStyle, "function");
  assert.equal(typeof entrypoint.BaseInteractionStyle, "function");
  assert.equal(typeof entrypoint.BaseMaskStyle, "function");
  assert.equal(typeof entrypoint.BaseLabelStyle, "function");
  assert.equal(typeof entrypoint.annotationRenderers.mask, "function");
  assert.equal(entrypoint.MediaSessionStatus.Ready, "ready");
  assert.equal(entrypoint.MediaRendererFit.Contain, "contain");
  assert.equal(entrypoint.DetectionTimelineOrigin.MediaStart, "mediaStart");
});

test("built editing entrypoint exposes advanced host-owned editing APIs", async () => {
  const editing = await import("../packages/web/dist/editing.js");

  assert.equal(typeof editing.createAnnotationEditingEngine, "function");
  assert.equal(typeof editing.createEditableAnnotationFrameSession, "function");
  assert.equal(typeof editing.createMaskBrushEditor, "function");
});

test("public browser declarations do not leak Pixi implementation types", () => {
  for (const declaration of [
    "../packages/web/dist/index.d.ts",
    "../packages/web/dist/editing.d.ts",
  ]) {
    const contents = readFileSync(
      new URL(declaration, import.meta.url),
      "utf8",
    );

    assert.ok(!contents.includes("pixi.js"), `${declaration} imports Pixi`);
    assert.ok(!contents.includes("Pixi"), `${declaration} exposes Pixi types`);
  }
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
  assert.equal(
    typeof entrypoint.createReactNativePreparedFramePacket,
    "function",
  );
  assert.equal(
    typeof entrypoint.createReactNativeLiveIdMaskArtifact,
    "function",
  );
  assert.equal(typeof entrypoint.resolveReactNativeIdMaskUniforms, "function");
  assert.equal(typeof entrypoint.REACT_NATIVE_ID_MASK_SHADER_SOURCE, "string");

  // One central color logic: the RN barrel re-exports core's resolver itself.
  const core = await import("../packages/core/dist/index.js");

  assert.equal(
    entrypoint.resolveDetectionClassColorStyle,
    core.resolveDetectionClassColorStyle,
  );

  // Outside React Native the Nitro module is absent; loading must degrade to
  // a JS-fallback handle instead of throwing.
  const nativeBuilderHandle =
    entrypoint.loadReactNativeLiveIdMaskNativeBuilder();

  assert.equal(nativeBuilderHandle.boxed, null);
  assert.equal(typeof nativeBuilderHandle.fallbackReason, "string");
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

test("built React Native subpath entries ship and resolve", async () => {
  const adapters =
    await import("../packages/react-native/dist/adapters/executorch.js");
  const liveInference =
    await import("../packages/react-native/dist/adapters/live-inference.js");
  const videoFile =
    await import("../packages/react-native/dist/adapters/video-file.js");
  const mediaSession =
    await import("../packages/react-native/dist/media-session.js");
  const reactEntry = readFileSync(
    new URL("../packages/react-native/dist/react.js", import.meta.url),
    "utf8",
  );
  const liveInferenceReactEntry = new URL(
    "../packages/react-native/dist/react/live-inference.js",
    import.meta.url,
  );

  assert.equal(typeof adapters.unrotateExecutorchUpBbox, "function");
  assert.deepEqual(Object.keys(adapters).sort(), [
    "EXECUTORCH_COCO_KEYPOINT_NAMES",
    "EXECUTORCH_COCO_SKELETON_EDGES",
    "createDetectionFrameFromExecutorchCocoPoses",
    "createExecutorchLivePoseProcessor",
    "createExecutorchLiveSegmentationProcessor",
    "createExecutorchPoseKeypointInstructions",
    "createExecutorchVideoFrameSerializer",
    "unrotateExecutorchUpBbox",
  ]);
  assert.deepEqual(
    adapters.unrotateExecutorchUpBbox({ x1: 1, y1: 2, x2: 3, y2: 4 }, 10),
    { x1: 2, y1: 7, x2: 4, y2: 9 },
  );
  assert.equal(typeof liveInference.evaluateInstantCvRules, "function");
  assert.equal(typeof mediaSession.createMediaSession, "function");
  assert.ok(existsSync(liveInferenceReactEntry));
  assert.ok(
    !reactEntry.includes("react-native-worklets"),
    "the generic React entry must not require the optional live-worklet peer",
  );
  assert.equal(typeof videoFile.createReactNativeVideoFileSource, "function");
  assert.deepEqual(Object.keys(mediaSession).sort(), [
    "MediaSessionActivityKind",
    "MediaSessionActivityStatus",
    "MediaSessionError",
    "MediaSessionMode",
    "MediaSessionStatus",
    "createMediaSession",
  ]);

  // The legacy Skia and sessions entries require optional native peers, so
  // they cannot be imported under Node; assert the built artifacts ship.
  assert.ok(
    existsSync(
      new URL("../packages/react-native/dist/skia.js", import.meta.url),
    ),
  );
  assert.ok(
    existsSync(
      new URL("../packages/react-native/dist/sessions.js", import.meta.url),
    ),
  );
});
