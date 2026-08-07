import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
  Vibration,
  View,
} from "react-native";
import { Asset } from "expo-asset";
import * as ImagePicker from "expo-image-picker";
import {
  models,
  useInstanceSegmentation,
  usePoseEstimation,
} from "react-native-executorch";
import {
  type DetectionPickResult,
  REACT_NATIVE_LIVE_SESSION_DEFAULTS,
  type ReactNativeFrameLayout,
  resolveReactNativeFrameLayout,
} from "supervision-js-react-native";
import {
  useVisionCameraDevice,
  useVisionCameraPermission,
  type VisionCameraDeviceFilter,
  VisionCameraLiveView,
  resolveVisionCameraPreferredZoom,
  resolveVisionCameraFrameRendererStyle,
} from "supervision-js-react-native/adapters/vision-camera";
import {
  createReactNativeStaticMediaSessionBinding,
  createReactNativeLiveDetectionStageOverlays,
  getReactNativeMediaSessionViewReadout,
  MediaSessionView,
  ReactNativeLiveFrameStage,
  ReactNativeLiveInteractionOverlay,
  ReactNativeVideoFrameStage,
  useReactNativeClassMaskEffects,
} from "supervision-js-react-native/react";
import {
  useReactNativeLiveInference,
  type ReactNativeLiveInferenceDetection,
  type ReactNativeLiveInferenceError,
  type ReactNativeLiveInferenceReadout,
} from "supervision-js-react-native/react/live-inference";
import {
  createReactNativeVideoFileSession,
  type ReactNativeVideoSession,
  type ReactNativeVideoSessionEndEvent,
  type ReactNativeVideoSessionStats,
} from "supervision-js-react-native/sessions";

import basketballFrame from "./assets/basketball-frame.jpg";
import basketballVideo from "../../demo/fixtures/basketball_sample/basketball_sample.mp4";
import {
  basketballDetectionFrame,
  basketballFrameMetadata,
} from "./src/basketball-frame";
import {
  DEMO_MASK_BORDER_WIDTH,
  DEMO_MASK_FILL_OPACITY,
  createDemoBoxStyle,
  createDemoDetectionFrameFromLiveDetections,
  createDemoLabelStyle,
  createDemoKeypointStyle,
  createDemoMaskStyle,
  createDemoPolygonStyle,
} from "./src/demo-presentation";
import {
  createExecutorchLivePoseProcessor,
  createExecutorchLiveSegmentationProcessor,
  createExecutorchVideoFrameSerializer,
} from "supervision-js-react-native/adapters/executorch";
import {
  createInstantCvFreeShapeZone,
  createInstantCvRectangleZone,
  getInstantCvZonePoints,
  resolveInstantCvInferenceMode,
  type InstantCvNormalizedPoint,
  type InstantCvRecipe,
  type InstantCvRule,
  type InstantCvRuleRuntime,
  type InstantCvZone,
  type InstantCvZoneShape,
} from "supervision-js-react-native/adapters/live-inference";

type DemoMode = "home" | "static" | "live" | "video" | "instant";
type LiveInferenceMode = "segmentation" | "pose";
type LiveDetectionDisplayMode = "masks" | "boxes";
type LiveClassEffect = "redact" | "spotlight";
type LiveClassEffects = Readonly<Record<string, LiveClassEffect>>;
type LiveCameraPosition = "back" | "front";

// Ask VisionCamera for a logical camera that contains the ultra-wide lens.
// Without this filter its default camera selection can choose only the 1x
// wide-angle device, making a valid 0.5x zoom request impossible to honor.
const LIVE_CAMERA_DEVICE_FILTER: VisionCameraDeviceFilter = {
  physicalDevices: ["ultra-wide-angle", "wide-angle"],
};

const LIVE_CLASS_EFFECT_OPTIONS: readonly {
  readonly effect: LiveClassEffect;
  readonly label: string;
}[] = [
  { effect: "redact", label: "Redact (privacy)" },
  { effect: "spotlight", label: "Spotlight" },
];

const LIVE_MAX_INSTANCES = REACT_NATIVE_LIVE_SESSION_DEFAULTS.maxInstances;
// No stroke in live mode: a crisp border retraces the low-res mask staircase
// and defeats the feathered fill edges (it also skips the shader's expensive
// border sampling loop).
const LIVE_PRIVACY_MOSAIC_CELL_PX = 14;
// Privacy outlines reuse the ID-mask border shader, so their contour follows
// the segmentation silhouette without extracting vector polygons per frame.
const LIVE_PRIVACY_CONTOUR_WIDTH = 2;
// Standard live mode's boxes-only privacy fallback uses a 1x1 all-ones mask
// to cover the whole detection bbox. Instant CV Privacy deliberately keeps the
// model's instance mask so its mosaic remains inside the detected silhouette.
// Masks are drawn exactly as the model returns them, so edge quality comes
// from the model output itself: request masks at original resolution now that
// native prep created the performance headroom for it.
const LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION = true;
const LIVE_FRAME_TARGET_RESOLUTION =
  REACT_NATIVE_LIVE_SESSION_DEFAULTS.targetResolution;
const LIVE_PERFORMANCE_SAMPLE_LIMIT = 40;
const LIVE_SEGMENTATION_PROFILE_LABEL =
  Platform.OS === "ios" ? "RF-DETR Nano CoreML INT8" : "RF-DETR Nano";
const liveSegmentationModel =
  Platform.OS === "ios"
    ? models.instance_segmentation.rf_detr_nano({
        backend: "coreml",
        quant: true,
      })
    : models.instance_segmentation.rf_detr_nano({ quant: true });
const livePoseModel = models.pose_estimation.yolo26n();

function useLiveSegmentation() {
  return useInstanceSegmentation({
    model: liveSegmentationModel,
    preventLoad: false,
  });
}

function useLivePose() {
  return usePoseEstimation({ model: livePoseModel, preventLoad: false });
}

type LiveSegmentation = ReturnType<typeof useLiveSegmentation>;
type LivePose = ReturnType<typeof useLivePose>;

/**
 * Keeps a vendor frame worklet in React state without React interpreting the
 * worklet itself as a state updater. ExecuTorch documents this handoff because
 * a worklet captured directly from a render can arrive on VisionCamera's
 * runtime before its JSI closure is fully available.
 */
function useStableFrameRunner<TRunner extends (...args: never[]) => unknown>(
  runner: TRunner | null,
): TRunner | null {
  const [stableRunner, setStableRunner] = useState<TRunner | null>(null);

  useEffect(() => {
    setStableRunner(() => runner);
  }, [runner]);

  return stableRunner;
}

export default function App() {
  const [mode, setMode] = useState<DemoMode>("home");
  const [liveInferenceMode, setLiveInferenceMode] =
    useState<LiveInferenceMode>("segmentation");
  const [instantRecipe, setInstantRecipe] =
    useState<InstantCvRecipe>("golden-pose");
  // Preload both models when the app mounts and retain them for the app
  // session. Besides removing mode-switch waits, this keeps captured camera
  // worklets backed by a live native model.
  const segmentation = useLiveSegmentation();
  const pose = useLivePose();
  const selectMode = useCallback(
    (nextMode: DemoMode) => {
      if (nextMode === "instant") {
        setLiveInferenceMode(resolveInstantCvInferenceMode(instantRecipe));
      }

      setMode(nextMode);
    },
    [instantRecipe],
  );
  const openInstantRecipe = useCallback((recipe: InstantCvRecipe) => {
    setInstantRecipe(recipe);
    setLiveInferenceMode(resolveInstantCvInferenceMode(recipe));
    setMode("instant");
  }, []);

  if (mode === "home") {
    return (
      <InstantCvHome
        onModeChange={selectMode}
        onOpenRecipe={openInstantRecipe}
      />
    );
  }

  if (mode === "live" || mode === "instant") {
    return (
      <LiveCameraProof
        inferenceMode={liveInferenceMode}
        instantRecipe={instantRecipe}
        mode={mode}
        onInferenceModeChange={setLiveInferenceMode}
        onInstantRecipeChange={setInstantRecipe}
        onModeChange={selectMode}
        pose={pose}
        segmentation={segmentation}
      />
    );
  }

  if (mode === "video") {
    return (
      <VideoFileProof
        mode={mode}
        onModeChange={selectMode}
        segmentation={segmentation}
      />
    );
  }

  return <StaticFrameProof mode={mode} onModeChange={selectMode} />;
}

function InstantCvHome(props: {
  readonly onModeChange: (mode: DemoMode) => void;
  readonly onOpenRecipe: (recipe: InstantCvRecipe) => void;
}) {
  const window = useWindowDimensions();
  const compact = window.width < 560;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.homeScreen}>
        <View style={styles.homeHeader}>
          <View style={styles.brand}>
            <BrandMark />
            <View style={styles.headerCopy}>
              <Text style={styles.title}>supervision-js</Text>
              <Text style={styles.subtitle}>React Native demo</Text>
            </View>
          </View>
          <ModeSwitch mode="home" onModeChange={props.onModeChange} />
        </View>

        <View style={styles.homeHero}>
          <Text style={styles.homeEyebrow}>INSTANT CV</Text>
          <Text style={styles.homeTitle}>Teach a live camera by touch.</Text>
          <Text style={styles.homeDescription}>
            Start with a small recipe, then make it yours on a real camera
            frame. No configuration screen required.
          </Text>
        </View>

        <View
          style={[
            styles.homeRecipeGrid,
            compact ? styles.homeRecipeGridCompact : null,
          ]}
        >
          {INSTANT_CV_RECIPE_OPTIONS.map((option, index) => (
            <TouchableOpacity
              key={option.recipe}
              onPress={() => props.onOpenRecipe(option.recipe)}
              style={styles.homeRecipeCard}
            >
              <View style={styles.homeRecipeNumber}>
                <Text style={styles.homeRecipeNumberText}>
                  {String(index + 1).padStart(2, "0")}
                </Text>
              </View>
              <Text style={styles.homeRecipeTitle}>{option.label}</Text>
              <Text style={styles.homeRecipeDescription}>
                {option.description}
              </Text>
              <Text style={styles.homeRecipeAction}>Try it →</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.homeFootnote}>
          Camera inference stays inside the React Native package; this screen is
          only a consumer of its recipes.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function StaticFrameProof(props: {
  readonly mode: DemoMode;
  readonly onModeChange: (mode: DemoMode) => void;
}) {
  const window = useWindowDimensions();
  const [rounded, setRounded] = useState(true);
  const [showPolygons, setShowPolygons] = useState(true);
  const [showKeypoints, setShowKeypoints] = useState(true);
  const [selectedPick, setSelectedPick] = useState<DetectionPickResult | null>(
    null,
  );

  const canvasWidth = Math.max(320, window.width - 24);
  const canvasHeight = Math.round(canvasWidth * 0.58);
  const binding = useMemo(
    () =>
      createReactNativeStaticMediaSessionBinding({
        boxStyle: createDemoBoxStyle({ rounded }),
        detectionFrame: basketballDetectionFrame,
        imageSource: basketballFrame,
        labelStyle: createDemoLabelStyle(),
        keypointStyle: createDemoKeypointStyle(),
        maskStyle: createDemoMaskStyle(),
        mediaMetadata: {
          duration: 1 / 30,
          ...basketballFrameMetadata,
        },
        polygonStyle: createDemoPolygonStyle(),
      }),
    [rounded],
  );
  const rendererReadout = getReactNativeMediaSessionViewReadout(binding);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <BrandMark />
            <View style={styles.headerCopy}>
              <Text style={styles.title}>supervision-js</Text>
              <Text style={styles.subtitle}>React Native rendering proof</Text>
            </View>
          </View>
          <ModeSwitch mode={props.mode} onModeChange={props.onModeChange} />
        </View>

        <MediaSessionView
          backgroundColor="#030712"
          binding={binding}
          height={canvasHeight}
          onPick={setSelectedPick}
          pickOptions={{ padding: 8 }}
          showKeypoints={showKeypoints}
          showPolygons={showPolygons}
          style={styles.canvasFrame}
          width={canvasWidth}
        >
          <View style={styles.stageReadout}>
            <StatusPill tone="ready" value="media + detections" />
            <StatusPill value={`${rendererReadout.maskCount} masks`} />
            <StatusPill
              value={`${rendererReadout.polygonCount} polygons · ${rendererReadout.keypointCount} poses`}
            />
            <StatusPill value="package renderer" />
          </View>
        </MediaSessionView>

        <View style={styles.metricsGrid}>
          <Metric label="Frame" value="#0" />
          <Metric
            label="Detections"
            value={String(rendererReadout.detectionCount)}
          />
          <Metric label="Renderer" value="Skia" />
          <Metric label="Selected" value={formatSelected(selectedPick)} />
        </View>

        <View style={[styles.card, styles.shaderReady]}>
          <View style={styles.cardHeader}>
            <View>
              <Text style={styles.cardTitle}>Prepared ID mask</Text>
              <Text style={styles.cardValue}>
                One frame artifact, one shader pass
              </Text>
            </View>
            <StatusPill tone="ready" value="gpu path" />
          </View>
          <View style={styles.metricRow}>
            <Metric label="Masks" value={String(rendererReadout.maskCount)} />
            <Metric label="Binding" value="opaque" />
            <Metric label="Scene" value="owned" />
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View>
              <Text style={styles.cardTitle}>Inspect</Text>
              <Text style={styles.cardValue}>
                {selectedPick?.detection.className ?? "Tap a detection"}
              </Text>
            </View>
            <StatusPill value={selectedPick?.target ?? "none"} />
          </View>
          <View style={styles.metricRow}>
            <Metric
              label="Confidence"
              value={formatConfidence(selectedPick?.detection.confidence)}
            />
            <Metric
              label="Point"
              value={
                selectedPick
                  ? `${Math.round(selectedPick.point.x)}, ${Math.round(
                      selectedPick.point.y,
                    )}`
                  : "-"
              }
            />
            <Metric
              label="Class"
              value={selectedPick?.detection.className ?? "-"}
            />
          </View>
        </View>

        <View style={styles.control}>
          <View style={styles.controlCopy}>
            <Text style={styles.cardTitle}>Box style</Text>
            <Text style={styles.body}>Core styles, Skia drawing.</Text>
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.body}>Rounded</Text>
            <Switch
              ios_backgroundColor="#1b2029"
              onValueChange={setRounded}
              thumbColor={rounded ? "#f8fafc" : "#8b95a7"}
              trackColor={{ false: "#242a35", true: "#77e4f2" }}
              value={rounded}
            />
          </View>
        </View>

        <View style={styles.control}>
          <View style={styles.controlCopy}>
            <Text style={styles.cardTitle}>Geometry</Text>
            <Text style={styles.body}>Prepared once as a Skia picture.</Text>
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.body}>Polygons</Text>
            <Switch
              ios_backgroundColor="#1b2029"
              onValueChange={setShowPolygons}
              thumbColor={showPolygons ? "#f8fafc" : "#8b95a7"}
              trackColor={{ false: "#242a35", true: "#77e4f2" }}
              value={showPolygons}
            />
            <Text style={styles.body}>Keypoints</Text>
            <Switch
              ios_backgroundColor="#1b2029"
              onValueChange={setShowKeypoints}
              thumbColor={showKeypoints ? "#f8fafc" : "#8b95a7"}
              trackColor={{ false: "#242a35", true: "#77e4f2" }}
              value={showKeypoints}
            />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

type LiveFrameState = ReactNativeLiveInferenceReadout;

interface LivePerformanceMetric {
  readonly p50: number;
  readonly p90: number;
}

interface LivePerformanceSummary {
  readonly artifactBytes: number;
  readonly artifactHeight: number;
  readonly artifactWidth: number;
  readonly droppedFrames: number;
  readonly fill: LivePerformanceMetric;
  readonly maskCount: number;
  readonly prep: LivePerformanceMetric;
  readonly ruleEval: LivePerformanceMetric;
  readonly sampleCount: number;
  readonly segmentation: LivePerformanceMetric;
  readonly serialization: LivePerformanceMetric;
  readonly tick: LivePerformanceMetric;
  readonly upload: LivePerformanceMetric;
}

type LiveOverlayDetection = ReactNativeLiveInferenceDetection;

interface InstantCvTouchRequest {
  readonly id: number;
  readonly kind:
    "capture-pose" | "pick-privacy-object" | "pick-safety-zone-object";
  readonly point: InstantCvNormalizedPoint;
}

type InstantCvWorkletPickResult =
  | {
      readonly baselineAngles: readonly number[];
      readonly baselinePoints: readonly {
        readonly visible: boolean;
        readonly x: number;
        readonly y: number;
      }[];
      readonly kind: "pose";
      readonly requestId: number;
    }
  | {
      readonly kind: "object";
      readonly label: string;
      readonly requestId: number;
      readonly target: "privacy" | "safety-zone";
      readonly usedMask: boolean;
    }
  | {
      readonly kind: "miss";
      readonly requestId: number;
    };

type LiveFrameError = ReactNativeLiveInferenceError;

interface SyncedStageGesturePoint {
  readonly timestamp: number;
  readonly x: number;
  readonly y: number;
}

function createLiveSyncedOverlays(options: {
  readonly detections: readonly LiveOverlayDetection[];
  readonly layout: ReactNativeFrameLayout;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}) {
  const detectionFrame = createDemoDetectionFrameFromLiveDetections({
    detections: options.detections,
  });
  return createReactNativeLiveDetectionStageOverlays({
    boxStyle: createDemoBoxStyle(),
    detectionFrame,
    labelStyle: createDemoLabelStyle(),
    layout: options.layout,
    mediaHeight: options.mediaHeight,
    mediaWidth: options.mediaWidth,
  });
}

function resolveInstantCvStatusColor(status: InstantCvRuleRuntime["status"]) {
  switch (status) {
    case "pass":
      return "#57f287";
    case "fail":
      return "#ff5d73";
    case "evaluating":
      return "#ffd166";
    default:
      return "#70e1f5";
  }
}

function InstantCvCanvasOverlay(props: {
  readonly draftZone: InstantCvZone | null;
  readonly layout: ReactNativeFrameLayout;
  readonly touchPoint: InstantCvNormalizedPoint | null;
}) {
  return (
    <ReactNativeLiveInteractionOverlay
      marker={props.touchPoint}
      mediaRect={props.layout.mediaRect}
      paths={
        props.draftZone
          ? [
              {
                key: "draft",
                points: getInstantCvZonePoints(props.draftZone),
              },
            ]
          : []
      }
    />
  );
}

const INSTANT_CV_RECIPE_OPTIONS: readonly {
  readonly description: string;
  readonly label: string;
  readonly recipe: InstantCvRecipe;
}[] = [
  {
    description: "Hold a person still to teach a reference pose.",
    label: "Golden Pose",
    recipe: "golden-pose",
  },
  {
    description: "Draw a keep-out zone, then choose which classes belong out.",
    label: "Safety Zone",
    recipe: "safety-zone",
  },
  {
    description: "Tap an object to pixelate every detection of that class.",
    label: "Privacy",
    recipe: "privacy",
  },
];

function InstantCvHud(props: {
  readonly canRunCamera: boolean;
  readonly message: string;
  readonly mode: DemoMode;
  readonly modelStatus: string;
  readonly onClear: () => void;
  readonly onModeChange: (mode: DemoMode) => void;
  readonly onRemovePrivacyClass: (label: string) => void;
  readonly onRecipeChange: (recipe: InstantCvRecipe) => void;
  readonly onRemoveSafetyClass: (label: string) => void;
  readonly onZoneShapeChange: (shape: InstantCvZoneShape) => void;
  readonly privacyClassNames: readonly string[];
  readonly recipe: InstantCvRecipe;
  readonly rules: readonly InstantCvRule[];
  readonly runtime: readonly InstantCvRuleRuntime[];
  readonly zoneShape: InstantCvZoneShape;
}) {
  const activeRule = props.rules[0];
  const activeRuntime = activeRule
    ? props.runtime.find((entry) => entry.id === activeRule.id)
    : undefined;
  const status = activeRuntime?.status ?? "unknown";
  const safetyClassNames =
    activeRule?.recipe === "safety-zone" ? activeRule.prohibitedClassNames : [];
  const isPrivacy = props.recipe === "privacy";
  const classListNames = isPrivacy ? props.privacyClassNames : safetyClassNames;
  const showsClassList = props.recipe === "safety-zone" || isPrivacy;
  const classListTitle = isPrivacy
    ? classListNames.length > 0
      ? "Pixelated classes"
      : "Choose classes"
    : classListNames.length > 0
      ? "Classes outside zone"
      : "Choose classes";
  const isChoosingSafetyClasses =
    activeRule?.recipe === "safety-zone" && safetyClassNames.length === 0;
  const statusColor = resolveInstantCvStatusColor(
    isPrivacy && props.privacyClassNames.length > 0 ? "pass" : status,
  );
  const statusLabel = isPrivacy
    ? props.privacyClassNames.length > 0
      ? "Privacy active"
      : "Choose classes"
    : activeRule
      ? isChoosingSafetyClasses
        ? "Choose classes"
        : status === "pass"
          ? "Ready"
          : status === "fail"
            ? "Action needed"
            : status === "evaluating"
              ? "Checking…"
              : "Looking…"
      : "Teach a rule";

  return (
    <>
      <View style={styles.instantModeMenu}>
        <ModeSwitch
          instantRecipe={props.recipe}
          mode={props.mode}
          onInstantRecipeChange={props.onRecipeChange}
          onModeChange={props.onModeChange}
        />
      </View>
      <View style={styles.instantStatusCard}>
        <View style={styles.instantStatusHeader}>
          <View style={styles.instantStatusTitleRow}>
            <View
              style={[
                styles.instantStatusDot,
                { backgroundColor: statusColor },
              ]}
            />
            <Text style={styles.instantStatusTitle}>
              {showsClassList ? classListTitle : statusLabel}
            </Text>
            {showsClassList ? (
              <Text style={styles.instantStatusCount}>
                {classListNames.length}
              </Text>
            ) : null}
          </View>
          <StatusPill
            tone={props.canRunCamera ? "ready" : "warning"}
            value={props.canRunCamera ? "on device" : props.modelStatus}
          />
        </View>
        {showsClassList ? (
          classListNames.length > 0 ? (
            <View style={styles.instantClassList}>
              {classListNames.map((label) => (
                <TouchableOpacity
                  accessibilityLabel={`Remove ${label} from ${isPrivacy ? "pixelated" : "prohibited"} classes`}
                  key={label}
                  onPress={() =>
                    isPrivacy
                      ? props.onRemovePrivacyClass(label)
                      : props.onRemoveSafetyClass(label)
                  }
                  style={styles.instantSafetyClassChip}
                >
                  <Text style={styles.instantSafetyClassChipText}>
                    {label} ×
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <Text style={styles.instantClassHint}>
              {isPrivacy
                ? "Tap an object to pixelate its class."
                : "Draw a zone, then tap an object."}
            </Text>
          )
        ) : null}
        {props.recipe === "safety-zone" ? (
          <View style={styles.instantShapeSwitch}>
            {(
              [
                ["rectangle", "Rectangle"],
                ["free-shape", "Free shape"],
              ] as const
            ).map(([shape, label]) => {
              const active = props.zoneShape === shape;

              return (
                <TouchableOpacity
                  key={shape}
                  onPress={() => props.onZoneShapeChange(shape)}
                  style={[
                    styles.instantShapeButton,
                    active ? styles.instantShapeButtonActive : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.instantShapeLabel,
                      active ? styles.instantShapeLabelActive : null,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}
        <Text style={styles.instantStatusMessage}>{props.message}</Text>
        {activeRuntime?.score !== undefined ? (
          <Text style={styles.instantScore}>
            Pose delta {Math.round(activeRuntime.score)}°
          </Text>
        ) : null}
        {props.rules.length > 0 || props.privacyClassNames.length > 0 ? (
          <TouchableOpacity onPress={props.onClear} style={styles.instantReset}>
            <Text style={styles.instantResetText}>Teach again</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );
}

function LiveCameraProof(props: {
  readonly inferenceMode: LiveInferenceMode;
  readonly instantRecipe: InstantCvRecipe;
  readonly mode: DemoMode;
  readonly onInferenceModeChange: (mode: LiveInferenceMode) => void;
  readonly onInstantRecipeChange: (recipe: InstantCvRecipe) => void;
  readonly onModeChange: (mode: DemoMode) => void;
  readonly pose: LivePose;
  readonly segmentation: LiveSegmentation;
}) {
  const isInstantCv = props.mode === "instant";
  const window = useWindowDimensions();
  const [cameraPosition, setCameraPosition] =
    useState<LiveCameraPosition>("back");
  const device = useVisionCameraDevice(
    cameraPosition,
    LIVE_CAMERA_DEVICE_FILTER,
  );
  const { hasPermission, requestPermission } = useVisionCameraPermission();
  const [liveFrame, setLiveFrame] = useState<LiveFrameState | null>(null);
  const [liveError, setLiveError] = useState<LiveFrameError | null>(null);
  const [liveDetections, setLiveDetections] = useState<
    readonly LiveOverlayDetection[]
  >([]);
  const [livePerformanceSamples, setLivePerformanceSamples] = useState<
    readonly LiveFrameState[]
  >([]);
  const [showLiveHud, setShowLiveHud] = useState(true);
  const [showLiveDebug, setShowLiveDebug] = useState(false);
  const [awaitingSyncedFrame, setAwaitingSyncedFrame] = useState(true);
  const [detectionDisplayMode, setDetectionDisplayMode] =
    useState<LiveDetectionDisplayMode>("masks");
  const [classEffects, setClassEffects] = useState<LiveClassEffects>({});
  const [tapMenuLabel, setTapMenuLabel] = useState<string | null>(null);
  const stableSegmentationRunner = useStableFrameRunner(
    props.segmentation.runOnFrame,
  );
  const stablePoseRunner = useStableFrameRunner(props.pose.runOnFrame);
  const instantRecipe = props.instantRecipe;
  const [instantZoneShape, setInstantZoneShape] =
    useState<InstantCvZoneShape>("rectangle");
  const [instantRules, setInstantRules] = useState<readonly InstantCvRule[]>(
    [],
  );
  const [instantRuntime, setInstantRuntime] = useState<
    readonly InstantCvRuleRuntime[]
  >([]);
  const instantRuntimeRef = useRef<readonly InstantCvRuleRuntime[]>([]);
  const [instantDraftZone, setInstantDraftZone] =
    useState<InstantCvZone | null>(null);
  const [instantTouchPoint, setInstantTouchPoint] =
    useState<InstantCvNormalizedPoint | null>(null);
  const [instantMessage, setInstantMessage] = useState(
    "Hold a person to teach the golden pose.",
  );
  const instantGestureRef = useRef<{
    readonly canvasStart: { readonly x: number; readonly y: number };
    readonly freeShapePoints: InstantCvNormalizedPoint[];
    readonly normalizedStart: InstantCvNormalizedPoint;
    readonly timestamp: number;
  } | null>(null);
  const instantRequestIdRef = useRef(0);
  const requestInstantInteractionRef = useRef<
    (request: InstantCvTouchRequest | null) => void
  >(() => {});
  const canvasWidth = window.width;
  const canvasHeight = window.height;
  const isInstantPrivacy = isInstantCv && instantRecipe === "privacy";
  const showMaskLayer =
    props.inferenceMode === "segmentation" && detectionDisplayMode === "masks";
  const showRawMaskLayer = showMaskLayer && !isInstantPrivacy;
  const showBoxLayer =
    !isInstantPrivacy &&
    props.inferenceMode === "segmentation" &&
    detectionDisplayMode === "boxes";
  // The mask lane doubles as the effect lane: even in boxes display mode the
  // mask artifact runs whenever a class has an effect (redact, spotlight).
  const effectsActive =
    props.inferenceMode === "segmentation" &&
    (!isInstantCv || isInstantPrivacy) &&
    Object.keys(classEffects).length > 0;
  const privacyPreviewActive =
    isInstantPrivacy && Object.keys(classEffects).length === 0;
  const liveLayout = useMemo(
    () =>
      resolveReactNativeFrameLayout({
        canvasHeight,
        canvasWidth,
        fit: "cover",
        mediaHeight: liveFrame?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height,
        mediaWidth: liveFrame?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width,
      }),
    [canvasHeight, canvasWidth, liveFrame?.height, liveFrame?.width],
  );
  const liveFrameRendererStyle = useMemo(
    () =>
      resolveVisionCameraFrameRendererStyle({
        canvasHeight,
        canvasWidth,
        mediaHeight: liveFrame?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height,
        mediaWidth: liveFrame?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width,
        orientation: liveFrame?.frameOrientation ?? "left",
      }),
    [
      canvasHeight,
      canvasWidth,
      liveFrame?.frameOrientation,
      liveFrame?.height,
      liveFrame?.width,
    ],
  );
  const livePerformance = useMemo(
    () => summarizeLivePerformance(livePerformanceSamples),
    [livePerformanceSamples],
  );
  const liveSyncedOverlays = useMemo(
    () =>
      createLiveSyncedOverlays({
        detections: liveDetections,
        layout: liveLayout,
        mediaHeight: liveFrame?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height,
        mediaWidth: liveFrame?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width,
      }),
    [liveDetections, liveFrame?.height, liveFrame?.width, liveLayout],
  );

  useEffect(() => {
    if (!hasPermission) {
      void requestPermission();
    }
  }, [hasPermission, requestPermission]);
  useEffect(() => {
    setLivePerformanceSamples([]);
  }, [detectionDisplayMode, props.inferenceMode]);
  useEffect(() => {
    setAwaitingSyncedFrame(true);
    setClassEffects({});
    setLiveDetections([]);
    setTapMenuLabel(null);
  }, [props.inferenceMode]);
  useEffect(() => {
    setAwaitingSyncedFrame(true);
  }, [isInstantCv]);
  useEffect(() => {
    if (isInstantCv) {
      return;
    }

    setInstantRules([]);
    setInstantRuntime([]);
    instantRuntimeRef.current = [];
    setInstantDraftZone(null);
  }, [isInstantCv]);
  useEffect(() => {
    if (!isInstantCv) {
      return;
    }

    const inferenceMode = resolveInstantCvInferenceMode(instantRecipe);
    props.onInferenceModeChange(inferenceMode);
  }, [instantRecipe, isInstantCv, props.onInferenceModeChange]);
  const reportLiveFrame = useCallback((frame: LiveFrameState) => {
    setLiveFrame(frame);
    setLiveError(null);
    setAwaitingSyncedFrame(false);
    setLivePerformanceSamples((samples) =>
      appendLivePerformanceSample(samples, frame),
    );
  }, []);
  const reportLiveError = useCallback((error: LiveFrameError) => {
    // The camera worklet already throttles this diagnostic. Keep it in the
    // on-screen HUD rather than forwarding a recoverable frame error to Metro
    // as a red console error during a demo.
    setLiveError(error);
  }, []);
  const reportLiveDetections = useCallback(
    (detections: readonly LiveOverlayDetection[]) => {
      setLiveDetections(detections);
    },
    [],
  );
  const reportInstantCvRuntime = useCallback(
    (next: readonly InstantCvRuleRuntime[]) => {
      const previous = instantRuntimeRef.current;

      for (const entry of next) {
        const prior = previous.find((candidate) => candidate.id === entry.id);

        if (
          prior?.status !== entry.status &&
          (entry.status === "pass" || entry.status === "fail")
        ) {
          Vibration.vibrate(entry.status === "pass" ? 24 : [0, 35, 45, 35]);
        }
      }

      instantRuntimeRef.current = next;
      setInstantRuntime(next);
    },
    [],
  );
  const reportInstantCvPick = useCallback(
    (result: InstantCvWorkletPickResult) => {
      if (result.kind === "pose") {
        const nextRules: readonly InstantCvRule[] = [
          {
            baselineAngles: result.baselineAngles,
            baselinePoints: result.baselinePoints,
            dwellMs: 450,
            id: `golden-pose-${result.requestId}`,
            recipe: "golden-pose",
            toleranceDegrees: 16,
          },
        ];
        setInstantRules(nextRules);
        setInstantRuntime([]);
        instantRuntimeRef.current = [];
        setInstantMessage("Golden pose captured. Match the ghost skeleton.");
        Vibration.vibrate(28);
        return;
      }

      if (result.kind === "object") {
        if (result.target === "safety-zone") {
          const currentRules = instantRules;
          const safetyRule = currentRules.find(
            (rule) => rule.recipe === "safety-zone",
          );

          if (!safetyRule) {
            return;
          }

          if (safetyRule.prohibitedClassNames.includes(result.label)) {
            setInstantMessage(
              `${result.label} is already in the must-not-be-in-zone list.`,
            );
            Vibration.vibrate(12);
            return;
          }

          const nextRules: readonly InstantCvRule[] = currentRules.map(
            (rule) =>
              rule.recipe === "safety-zone"
                ? {
                    ...rule,
                    prohibitedClassNames: [
                      ...rule.prohibitedClassNames,
                      result.label,
                    ],
                  }
                : rule,
          );
          setInstantRules(nextRules);
          setInstantRuntime([]);
          instantRuntimeRef.current = [];
          setInstantMessage(
            `${result.label} added. Tap another object to prohibit its class too.`,
          );
          Vibration.vibrate(28);
          return;
        }

        const currentEffects = classEffects;

        if (currentEffects[result.label] === "redact") {
          const nextEffects: Record<string, LiveClassEffect> = {
            ...currentEffects,
          };
          delete nextEffects[result.label];
          setClassEffects(nextEffects);
          setInstantMessage(
            `${result.label} is visible again. Tap it again to pixelate its class.`,
          );
          Vibration.vibrate(12);
          return;
        }

        const nextEffects: LiveClassEffects = {
          ...currentEffects,
          [result.label]: "redact",
        };
        setClassEffects(nextEffects);
        setInstantMessage(
          `${result.label} is now pixelated. Tap another object to redact its class too.`,
        );
        Vibration.vibrate(28);
        return;
      }

      setInstantMessage(
        "Nothing detected there. Try touching the visible shape.",
      );
    },
    [classEffects, instantRules],
  );
  const clearInstantRules = useCallback(() => {
    setInstantRules([]);
    setInstantRuntime([]);
    instantRuntimeRef.current = [];
    setInstantDraftZone(null);
    setClassEffects({});
    setInstantMessage(
      instantRecipe === "golden-pose"
        ? "Hold a person to teach the golden pose."
        : instantRecipe === "safety-zone"
          ? "Draw a keep-out zone, then tap objects that must stay outside it."
          : "Tap any object to pixelate every detection of that class.",
    );
  }, [instantRecipe]);
  const selectInstantRecipe = useCallback(
    (recipe: InstantCvRecipe) => {
      props.onInferenceModeChange(resolveInstantCvInferenceMode(recipe));
      setAwaitingSyncedFrame(true);
      props.onInstantRecipeChange(recipe);
      setInstantRules([]);
      setInstantRuntime([]);
      instantRuntimeRef.current = [];
      setInstantDraftZone(null);
      setClassEffects({});
      setInstantMessage(
        recipe === "golden-pose"
          ? "Hold a person to teach the golden pose."
          : recipe === "safety-zone"
            ? "Draw a keep-out zone, then tap objects that must stay outside it."
            : "Tap any object to pixelate every detection of that class.",
      );
      Vibration.vibrate(16);
    },
    [props.onInferenceModeChange, props.onInstantRecipeChange],
  );
  const selectInstantZoneShape = useCallback((shape: InstantCvZoneShape) => {
    setInstantZoneShape(shape);
    setInstantRules([]);
    setInstantRuntime([]);
    instantRuntimeRef.current = [];
    setInstantDraftZone(null);
    setInstantMessage(
      `Draw a ${shape === "rectangle" ? "rectangular" : "free-shape"} keep-out zone, then tap prohibited objects.`,
    );
    Vibration.vibrate(12);
  }, []);
  const removeInstantSafetyClass = useCallback(
    (label: string) => {
      const currentRules = instantRules;
      const nextRules: readonly InstantCvRule[] = currentRules.map((rule) =>
        rule.recipe === "safety-zone"
          ? {
              ...rule,
              prohibitedClassNames: rule.prohibitedClassNames.filter(
                (className) => className !== label,
              ),
            }
          : rule,
      );
      const safetyRule = nextRules.find(
        (rule) => rule.recipe === "safety-zone",
      );

      setInstantRules(nextRules);
      setInstantRuntime([]);
      instantRuntimeRef.current = [];
      setInstantMessage(
        safetyRule?.recipe === "safety-zone" &&
          safetyRule.prohibitedClassNames.length > 0
          ? `${label} removed. Tap another object to add its class.`
          : "Tap a visible object to add the first prohibited class.",
      );
      Vibration.vibrate(12);
    },
    [instantRules],
  );
  const removeInstantPrivacyClass = useCallback(
    (label: string) => {
      const nextEffects: Record<string, LiveClassEffect> = {
        ...classEffects,
      };
      delete nextEffects[label];
      setClassEffects(nextEffects);
      setInstantMessage(
        Object.keys(nextEffects).length > 0
          ? `${label} is visible again. Tap another object to pixelate its class.`
          : "Tap any object to pixelate every detection of that class.",
      );
      Vibration.vibrate(12);
    },
    [classEffects],
  );
  const mapInstantCvPoint = useCallback(
    (point: { readonly x: number; readonly y: number }) => {
      const mediaPoint = liveLayout.mapCanvasPoint(point);
      const frameWidth = liveFrame?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width;
      const frameHeight =
        liveFrame?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height;

      if (!mediaPoint || frameWidth <= 0 || frameHeight <= 0) {
        return null;
      }

      return {
        x: Math.max(0, Math.min(1, mediaPoint.x / frameWidth)),
        y: Math.max(0, Math.min(1, mediaPoint.y / frameHeight)),
      };
    },
    [liveFrame?.height, liveFrame?.width, liveLayout],
  );
  const handleInstantGestureStart = useCallback(
    (point: SyncedStageGesturePoint) => {
      const normalized = mapInstantCvPoint(point);

      if (!normalized) {
        instantGestureRef.current = null;
        return;
      }

      instantGestureRef.current = {
        canvasStart: point,
        freeShapePoints: [normalized],
        normalizedStart: normalized,
        timestamp: point.timestamp,
      };
      setInstantTouchPoint(normalized);

      const hasSafetyZone =
        instantRecipe === "safety-zone" &&
        instantRules.some((rule) => rule.recipe === "safety-zone");

      if (instantRecipe === "safety-zone" && !hasSafetyZone) {
        setInstantDraftZone(
          instantZoneShape === "rectangle"
            ? createInstantCvRectangleZone(normalized, normalized)
            : { kind: "polygon", points: [normalized] },
        );
      }
    },
    [instantRecipe, instantRules, instantZoneShape, mapInstantCvPoint],
  );
  const handleInstantGestureMove = useCallback(
    (point: SyncedStageGesturePoint) => {
      const gesture = instantGestureRef.current;
      const normalized = mapInstantCvPoint(point);

      if (!gesture || !normalized || instantRecipe !== "safety-zone") {
        return;
      }

      if (instantZoneShape === "rectangle") {
        setInstantDraftZone(
          createInstantCvRectangleZone(gesture.normalizedStart, normalized),
        );
        return;
      }

      const previous =
        gesture.freeShapePoints[gesture.freeShapePoints.length - 1];

      if (
        previous &&
        Math.hypot(normalized.x - previous.x, normalized.y - previous.y) < 0.006
      ) {
        return;
      }

      if (gesture.freeShapePoints.length >= 64) {
        const decimated = gesture.freeShapePoints.filter(
          (_, index) => index % 2 === 0,
        );
        gesture.freeShapePoints.splice(
          0,
          gesture.freeShapePoints.length,
          ...decimated,
        );
      }
      gesture.freeShapePoints.push(normalized);
      setInstantDraftZone({
        kind: "polygon",
        points: [...gesture.freeShapePoints],
      });
    },
    [instantRecipe, instantZoneShape, mapInstantCvPoint],
  );
  const handleInstantGestureEnd = useCallback(
    (point: SyncedStageGesturePoint) => {
      const gesture = instantGestureRef.current;
      const normalized = mapInstantCvPoint(point);

      instantGestureRef.current = null;
      setInstantTouchPoint(null);

      if (!gesture || !normalized) {
        setInstantDraftZone(null);
        return;
      }

      const distance = Math.hypot(
        point.x - gesture.canvasStart.x,
        point.y - gesture.canvasStart.y,
      );
      const duration = point.timestamp - gesture.timestamp;

      if (instantRecipe === "golden-pose") {
        if (duration < 420 || distance > 24) {
          setInstantMessage(
            "Hold still on a person until the teach ring completes.",
          );
          return;
        }

        const request = {
          id: ++instantRequestIdRef.current,
          kind: "capture-pose" as const,
          point: normalized,
        };
        requestInstantInteractionRef.current(request);
        setInstantMessage("Capturing the next synchronized pose…");
        return;
      }

      setInstantDraftZone(null);

      if (instantRecipe === "privacy") {
        if (distance >= 12) {
          setInstantMessage("Tap a visible object to pixelate its class.");
          return;
        }

        requestInstantInteractionRef.current({
          id: ++instantRequestIdRef.current,
          kind: "pick-privacy-object",
          point: normalized,
        });
        setInstantMessage("Reading the touched mask on the next frame…");
        return;
      }

      const safetyRule = instantRules.find(
        (rule) => rule.recipe === "safety-zone",
      );

      if (instantRecipe === "safety-zone" && safetyRule && distance < 12) {
        requestInstantInteractionRef.current({
          id: ++instantRequestIdRef.current,
          kind: "pick-safety-zone-object",
          point: normalized,
        });
        setInstantMessage("Reading the touched mask on the next frame…");
        return;
      }

      const rectangleZone = createInstantCvRectangleZone(
        gesture.normalizedStart,
        normalized,
      );
      const zone =
        instantZoneShape === "rectangle"
          ? rectangleZone
          : createInstantCvFreeShapeZone([
              ...gesture.freeShapePoints,
              normalized,
            ]);

      if (
        !zone ||
        (zone.kind === "rectangle" &&
          (zone.rect.width < 0.035 || zone.rect.height < 0.035))
      ) {
        setInstantMessage("Draw a larger zone directly on the camera view.");
        return;
      }

      if (instantRecipe === "safety-zone") {
        const nextRules: readonly InstantCvRule[] = [
          {
            dwellMs: 180,
            id: `safety-zone-${Date.now()}`,
            prohibitedClassNames: safetyRule?.prohibitedClassNames ?? [],
            recipe: "safety-zone",
            zone,
          },
        ];
        setInstantRules(nextRules);
        setInstantRuntime([]);
        instantRuntimeRef.current = [];
        setInstantMessage(
          safetyRule && safetyRule.prohibitedClassNames.length > 0
            ? "Zone updated. Tap another object to add its class."
            : "Zone set. Tap an object that must not enter it.",
        );
        Vibration.vibrate(24);
        return;
      }
    },
    [
      instantRecipe,
      instantRules,
      instantZoneShape,
      mapInstantCvPoint,
      requestInstantInteractionRef,
    ],
  );
  const handleInstantGestureCancel = useCallback(() => {
    instantGestureRef.current = null;
    setInstantDraftZone(null);
    setInstantTouchPoint(null);
  }, []);
  // Tapping a detection opens a small action menu for its class. Class-based
  // actions need no tracker: the class name is the identity, and any new
  // instance of a redacted class is covered the moment it is detected.
  const handleLiveStageTap = useCallback(
    (point: { readonly x: number; readonly y: number }) => {
      setTapMenuLabel(
        pickDetectionLabelAtPoint(point, liveDetections, liveLayout),
      );
    },
    [liveDetections, liveLayout],
  );
  const toggleClassEffect = useCallback(
    (label: string, effect: LiveClassEffect) => {
      setClassEffects((effects) => {
        const next: Record<string, LiveClassEffect> = { ...effects };

        if (effects[label] === effect) {
          delete next[label];
        } else {
          next[label] = effect;
        }

        return next;
      });
    },
    [],
  );
  const clearClassEffect = useCallback((label: string) => {
    setClassEffects((effects) => {
      const next: Record<string, LiveClassEffect> = { ...effects };

      delete next[label];

      return next;
    });
  }, []);

  const segmentationProcessor = useMemo(
    () =>
      createExecutorchLiveSegmentationProcessor({
        maxInstances: LIVE_MAX_INSTANCES,
        returnMasksAtOriginalResolution:
          LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION,
        runOnFrame: stableSegmentationRunner,
      }),
    [stableSegmentationRunner],
  );
  const poseProcessor = useMemo(
    () =>
      createExecutorchLivePoseProcessor({
        mirrorFrame: cameraPosition === "front",
        runOnFrame: stablePoseRunner,
      }),
    [cameraPosition, stablePoseRunner],
  );
  const liveExtension = useMemo(
    () => ({
      active: isInstantCv,
      privacyActive: isInstantPrivacy,
      privacyHasClasses: Object.keys(classEffects).length > 0,
      rules: instantRules,
    }),
    [classEffects, instantRules, isInstantCv, isInstantPrivacy],
  );
  const liveInference = useReactNativeLiveInference({
    classEffects:
      !isInstantCv || instantRecipe === "privacy" ? classEffects : {},
    extension: liveExtension,
    inferenceMode: props.inferenceMode,
    mediaRect: liveLayout.mediaRect,
    onDetections: reportLiveDetections,
    onError: reportLiveError,
    onInteraction: reportInstantCvPick,
    onReadout: reportLiveFrame,
    onRuleRuntime: reportInstantCvRuntime,
    poseProcessor,
    presentation: {
      fillOpacity: DEMO_MASK_FILL_OPACITY,
      maskBorderWidth: DEMO_MASK_BORDER_WIDTH,
      mosaicCellPx: LIVE_PRIVACY_MOSAIC_CELL_PX,
      privacyContourWidth: LIVE_PRIVACY_CONTOUR_WIDTH,
    },
    segmentationProcessor,
    showMasks: showRawMaskLayer,
    targetResolution: LIVE_FRAME_TARGET_RESOLUTION,
  });
  useEffect(() => {
    requestInstantInteractionRef.current = liveInference.requestInteraction;
  }, [liveInference.requestInteraction]);

  const cameraOutputs = useMemo(
    () => [liveInference.camera.frameOutput],
    [liveInference.camera.frameOutput],
  );
  const cameraZoom = useMemo(
    () => resolveVisionCameraPreferredZoom(device, 0.5),
    [device],
  );

  const activeModel =
    props.inferenceMode === "pose" ? props.pose : props.segmentation;
  const modelStatus = formatInferenceStatus(
    activeModel,
    props.inferenceMode === "pose" ? "YOLO26N Pose" : "RF-DETR Seg",
  );
  // ExecuTorch reports `isReady` immediately before React receives the
  // serializable `runOnFrame` worklet. Do not let VisionCamera process that
  // short intermediate state: the UI runtime would invoke an unavailable
  // native runner and report a misleading inference failure.
  const activeFrameRunner =
    props.inferenceMode === "pose"
      ? stablePoseRunner
      : stableSegmentationRunner;
  const hasActiveFrameRunner = typeof activeFrameRunner === "function";
  const canRunCamera =
    hasPermission &&
    device &&
    activeModel.isReady &&
    hasActiveFrameRunner &&
    liveInference.presentation.isReady;

  return (
    <View style={styles.liveScreen}>
      <StatusBar hidden />
      <ReactNativeLiveFrameStage
        boxes={liveSyncedOverlays.boxes}
        canvasHeight={canvasHeight}
        canvasStyle={StyleSheet.absoluteFill}
        canvasWidth={canvasWidth}
        labels={liveSyncedOverlays.labels}
        layout={liveLayout}
        interactionLayer={
          isInstantCv ? (
            <InstantCvCanvasOverlay
              draftZone={instantDraftZone}
              layout={liveLayout}
              touchPoint={instantTouchPoint}
            />
          ) : undefined
        }
        onPress={
          !isInstantCv && props.inferenceMode === "segmentation"
            ? handleLiveStageTap
            : undefined
        }
        onGestureCancel={isInstantCv ? handleInstantGestureCancel : undefined}
        onGestureEnd={isInstantCv ? handleInstantGestureEnd : undefined}
        onGestureMove={isInstantCv ? handleInstantGestureMove : undefined}
        onGestureStart={isInstantCv ? handleInstantGestureStart : undefined}
        mediaLayer={
          <>
            {device ? (
              <VisionCameraLiveView
                cameraStyle={[
                  styles.captureCamera,
                  awaitingSyncedFrame ? styles.captureCameraVisible : null,
                ]}
                device={device}
                frameRenderer={liveInference.camera.frameRenderer}
                frameRendererStyle={[
                  styles.frameRendererSurface,
                  liveFrameRendererStyle,
                  awaitingSyncedFrame
                    ? styles.frameRendererSurfaceHidden
                    : null,
                ]}
                isActive={Boolean(canRunCamera)}
                orientationSource="device"
                outputs={cameraOutputs}
                zoom={cameraZoom}
              />
            ) : null}
          </>
        }
        showBoxes={showBoxLayer}
        showMasks={showRawMaskLayer || effectsActive || privacyPreviewActive}
        stageStyle={styles.liveStage}
        presentation={liveInference.presentation}
      >
        {!canRunCamera ? (
          <View style={styles.stageOverlay}>
            <Text style={styles.overlayTitle}>Live camera</Text>
            <Text style={styles.overlayBody}>
              {!hasPermission
                ? "Waiting for camera permission"
                : !device
                  ? `No ${cameraPosition} camera available`
                  : modelStatus}
            </Text>
          </View>
        ) : null}

        {isInstantCv ? (
          <InstantCvHud
            canRunCamera={Boolean(canRunCamera)}
            message={instantMessage}
            mode={props.mode}
            modelStatus={modelStatus}
            onClear={clearInstantRules}
            onModeChange={props.onModeChange}
            onRemovePrivacyClass={removeInstantPrivacyClass}
            onRecipeChange={selectInstantRecipe}
            onRemoveSafetyClass={removeInstantSafetyClass}
            onZoneShapeChange={selectInstantZoneShape}
            privacyClassNames={Object.keys(classEffects)}
            recipe={instantRecipe}
            rules={instantRules}
            runtime={instantRuntime}
            zoneShape={instantZoneShape}
          />
        ) : showLiveHud ? (
          <>
            <View style={styles.liveTopBar}>
              <View style={styles.liveBrand}>
                <BrandMark />
                <View style={styles.headerCopy}>
                  <Text style={styles.title}>supervision-js</Text>
                  <Text style={styles.subtitle}>
                    {props.inferenceMode === "pose"
                      ? "Live YOLO pose camera"
                      : "Live RF-DETR camera"}
                  </Text>
                </View>
              </View>
              <ModeSwitch mode={props.mode} onModeChange={props.onModeChange} />
            </View>

            <View style={styles.liveStatusCluster}>
              <StatusPill
                tone={canRunCamera ? "ready" : "warning"}
                value={canRunCamera ? "live" : "waiting"}
              />
              <StatusPill value={modelStatus} />
              <StatusPill tone="ready" value="strict sync" />
              <StatusPill
                tone={liveFrame?.maskBuilder === "native" ? "ready" : undefined}
                value={`prep ${liveFrame?.maskBuilder ?? "-"}`}
              />
              <StatusPill
                value={`${liveFrame?.maskCount ?? 0} ${
                  props.inferenceMode === "pose"
                    ? "poses"
                    : detectionDisplayMode
                }`}
              />
            </View>

            {props.inferenceMode === "segmentation" ? (
              <ClassEffectChips
                classEffects={classEffects}
                onClear={clearClassEffect}
              />
            ) : null}

            <View style={styles.liveActions}>
              <TouchableOpacity
                onPress={() => props.onInferenceModeChange("segmentation")}
                style={[
                  styles.floatingButton,
                  props.inferenceMode === "segmentation"
                    ? styles.floatingButtonActive
                    : null,
                ]}
              >
                <Text
                  style={[
                    styles.floatingButtonText,
                    props.inferenceMode === "segmentation"
                      ? styles.floatingButtonTextActive
                      : null,
                  ]}
                >
                  Segment
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => props.onInferenceModeChange("pose")}
                style={[
                  styles.floatingButton,
                  props.inferenceMode === "pose"
                    ? styles.floatingButtonActive
                    : null,
                ]}
              >
                <Text
                  style={[
                    styles.floatingButtonText,
                    props.inferenceMode === "pose"
                      ? styles.floatingButtonTextActive
                      : null,
                  ]}
                >
                  Pose
                </Text>
              </TouchableOpacity>
              {props.inferenceMode === "segmentation" ? (
                <>
                  <TouchableOpacity
                    onPress={() => setDetectionDisplayMode("masks")}
                    style={[
                      styles.floatingButton,
                      showMaskLayer ? styles.floatingButtonActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.floatingButtonText,
                        showMaskLayer ? styles.floatingButtonTextActive : null,
                      ]}
                    >
                      Masks
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setDetectionDisplayMode("boxes")}
                    style={[
                      styles.floatingButton,
                      showBoxLayer ? styles.floatingButtonActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.floatingButtonText,
                        showBoxLayer ? styles.floatingButtonTextActive : null,
                      ]}
                    >
                      Boxes
                    </Text>
                  </TouchableOpacity>
                </>
              ) : null}
              <TouchableOpacity
                onPress={() => setShowLiveDebug((value) => !value)}
                style={[
                  styles.floatingButton,
                  showLiveDebug ? styles.floatingButtonActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.floatingButtonText,
                    showLiveDebug ? styles.floatingButtonTextActive : null,
                  ]}
                >
                  Debug
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setShowLiveHud(false)}
                style={styles.floatingIconButton}
              >
                <Text style={styles.floatingButtonText}>Hide</Text>
              </TouchableOpacity>
            </View>

            {showLiveDebug ? (
              <View style={styles.liveDebugPanel}>
                <LiveMetric
                  label="Frame"
                  value={
                    liveFrame
                      ? `${liveFrame.width}x${liveFrame.height}`
                      : "waiting"
                  }
                />
                <LiveMetric
                  label="Transform"
                  value={
                    liveFrame
                      ? `${liveFrame.frameOrientation}${liveFrame.frameIsMirrored ? " mirrored" : ""}`
                      : "-"
                  }
                />
                <LiveMetric
                  label="Sync"
                  value={liveFrame ? liveFrame.syncMode : "synced"}
                />
                <LiveMetric
                  label="Artifact"
                  value={
                    livePerformance?.artifactWidth
                      ? `${livePerformance.artifactWidth}x${livePerformance.artifactHeight}`
                      : "-"
                  }
                />
                <LiveMetric
                  label="Bytes"
                  value={
                    livePerformance?.artifactBytes
                      ? formatBytes(livePerformance.artifactBytes)
                      : "-"
                  }
                />
                <LiveMetric
                  label="Model"
                  value={
                    props.inferenceMode === "pose"
                      ? "YOLO26N Pose 384"
                      : LIVE_SEGMENTATION_PROFILE_LABEL
                  }
                />
                <LiveMetric
                  label={
                    props.inferenceMode === "pose"
                      ? "Pose p50/p90"
                      : "Seg p50/p90"
                  }
                  value={formatLivePerformanceMetric(
                    livePerformance?.segmentation,
                  )}
                />
                <LiveMetric
                  label="People / points"
                  value={`${liveFrame?.maskCount ?? 0} / ${
                    liveFrame?.visibleKeypointCount ?? 0
                  }`}
                />
                <LiveMetric
                  label="Ser p50/p90"
                  value={formatLivePerformanceMetric(
                    livePerformance?.serialization,
                  )}
                />
                <LiveMetric
                  label="Prep p50/p90"
                  value={formatLivePerformanceMetric(livePerformance?.prep)}
                />
                <LiveMetric
                  label="Rules p50/p90"
                  value={formatLivePerformanceMetric(livePerformance?.ruleEval)}
                />
                <LiveMetric
                  label="Fill p50/p90"
                  value={formatLivePerformanceMetric(livePerformance?.fill)}
                />
                <LiveMetric
                  label="Builder"
                  value={liveFrame?.maskBuilder ?? "-"}
                />
                <LiveMetric
                  label="JS falls"
                  value={String(liveFrame?.maskJsFallbackCount ?? 0)}
                />
                <LiveMetric
                  label="Fallback"
                  value={formatLiveFallbackReason(
                    liveFrame?.maskFallbackReason,
                  )}
                />
                <LiveMetric
                  label="Upload p50/p90"
                  value={formatLivePerformanceMetric(livePerformance?.upload)}
                />
                <LiveMetric
                  label="Tick p50/p90"
                  value={formatLivePerformanceMetric(livePerformance?.tick)}
                />
                <LiveMetric
                  label="Samples"
                  value={String(livePerformance?.sampleCount ?? 0)}
                />
                <LiveMetric
                  label="Dropped"
                  value={String(livePerformance?.droppedFrames ?? 0)}
                />
                <LiveMetric label="Error" value={liveError?.stage ?? "none"} />
              </View>
            ) : null}
          </>
        ) : (
          <TouchableOpacity
            onPress={() => setShowLiveHud(true)}
            style={styles.liveShowHudButton}
          >
            <Text style={styles.floatingButtonText}>HUD</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          accessibilityLabel={`Switch to ${cameraPosition === "back" ? "front" : "back"} camera`}
          onPress={() =>
            setCameraPosition((current) =>
              current === "back" ? "front" : "back",
            )
          }
          style={[
            styles.liveCameraSwitch,
            isInstantCv ? styles.liveCameraSwitchAtInstantTop : null,
          ]}
        >
          <Text style={styles.liveCameraSwitchIcon}>↻</Text>
        </TouchableOpacity>

        {tapMenuLabel !== null ? (
          <ClassEffectMenu
            classEffects={classEffects}
            label={tapMenuLabel}
            onCancel={() => setTapMenuLabel(null)}
            onSelect={(label, effect) => {
              toggleClassEffect(label, effect);
              setTapMenuLabel(null);
            }}
          />
        ) : null}
      </ReactNativeLiveFrameStage>
    </View>
  );
}

type VideoStats = ReactNativeVideoSessionStats;

type VideoStatus =
  "idle" | "opening" | "processing" | "paused" | "done" | "error";

function VideoFileProof(props: {
  readonly mode: DemoMode;
  readonly onModeChange: (mode: DemoMode) => void;
  readonly segmentation: LiveSegmentation;
}) {
  const window = useWindowDimensions();
  const canvasWidth = window.width;
  const canvasHeight = window.height;
  const [videoStatus, setVideoStatus] = useState<VideoStatus>("idle");
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null);
  const [videoDims, setVideoDims] = useState<{
    readonly height: number;
    readonly width: number;
  } | null>(null);
  const [videoDetections, setVideoDetections] = useState<
    readonly LiveOverlayDetection[]
  >([]);
  const [classEffects, setClassEffects] = useState<LiveClassEffects>({});
  const [tapMenuLabel, setTapMenuLabel] = useState<string | null>(null);
  // The session owns the decode pump and packet lifecycle; pause keeps its
  // decoder open at position. The ref drives controls, the state rebinds the
  // stage to the session's presentation lanes.
  const videoSessionRef = useRef<ReactNativeVideoSession | null>(null);
  const videoRequestId = useRef(0);
  const [videoSession, setVideoSession] =
    useState<ReactNativeVideoSession | null>(null);

  const videoLayout = useMemo(
    () =>
      resolveReactNativeFrameLayout({
        canvasHeight,
        canvasWidth,
        mediaHeight: videoDims?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height,
        mediaWidth: videoDims?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width,
      }),
    [canvasHeight, canvasWidth, videoDims?.height, videoDims?.width],
  );
  const videoSyncedOverlays = useMemo(
    () =>
      createLiveSyncedOverlays({
        detections: videoDetections,
        layout: videoLayout,
        mediaHeight: videoDims?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height,
        mediaWidth: videoDims?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width,
      }),
    [videoDetections, videoDims?.height, videoDims?.width, videoLayout],
  );
  const runSegmentationOnFrame = props.segmentation.runOnFrame;
  useEffect(() => {
    videoSessionRef.current?.setMediaRect(videoLayout.mediaRect);
  }, [videoLayout.mediaRect, videoSession]);
  const serializeVideoFrame = useMemo(
    () =>
      createExecutorchVideoFrameSerializer({
        maxInstances: LIVE_MAX_INSTANCES,
        returnMasksAtOriginalResolution:
          LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION,
        runOnFrame: runSegmentationOnFrame,
      }),
    [runSegmentationOnFrame],
  );
  const resolveVideoMaskEffects = useReactNativeClassMaskEffects(classEffects);
  const handleVideoEnded = useCallback(
    (event: ReactNativeVideoSessionEndEvent) => {
      if (event.paused) {
        setVideoStatus("paused");
      } else if (event.error !== undefined) {
        setVideoError(event.error);
        setVideoStatus("error");
      } else {
        setVideoStatus("done");
      }
    },
    [],
  );
  const handleVideoStageTap = useCallback(
    (point: { readonly x: number; readonly y: number }) => {
      setTapMenuLabel(
        pickDetectionLabelAtPoint(point, videoDetections, videoLayout),
      );
    },
    [videoDetections, videoLayout],
  );
  const toggleClassEffect = useCallback(
    (label: string, effect: LiveClassEffect) => {
      setClassEffects((effects) => {
        const next: Record<string, LiveClassEffect> = { ...effects };

        if (effects[label] === effect) {
          delete next[label];
        } else {
          next[label] = effect;
        }

        return next;
      });
    },
    [],
  );
  const clearClassEffect = useCallback((label: string) => {
    setClassEffects((effects) => {
      const next: Record<string, LiveClassEffect> = { ...effects };

      delete next[label];

      return next;
    });
  }, []);

  const startVideo = useCallback(
    async (fileUri: string) => {
      const requestId = videoRequestId.current + 1;

      videoRequestId.current = requestId;
      setVideoError(null);
      setVideoStats(null);
      setVideoDetections([]);
      setVideoStatus("opening");
      await videoSessionRef.current?.destroy();

      if (requestId !== videoRequestId.current) {
        return;
      }

      videoSessionRef.current = null;

      try {
        const session = createReactNativeVideoFileSession({
          fileUri,
          mediaRect: videoLayout.mediaRect,
          onDetections: setVideoDetections,
          onEnded: handleVideoEnded,
          onStats: setVideoStats,
          presentation: {
            borderWidth: DEMO_MASK_BORDER_WIDTH,
            fillOpacity: DEMO_MASK_FILL_OPACITY,
            mosaicCellPx: LIVE_PRIVACY_MOSAIC_CELL_PX,
          },
          resolveMaskEffects: resolveVideoMaskEffects,
          serializeFrame: serializeVideoFrame,
        });

        if (requestId !== videoRequestId.current) {
          await session.destroy();
          return;
        }

        videoSessionRef.current = session;
        setVideoSession(session);
        setVideoDims({
          height: session.frameHeight,
          width: session.frameWidth,
        });
        setVideoStatus("processing");
      } catch (error) {
        if (requestId !== videoRequestId.current) {
          return;
        }

        setVideoError(
          error instanceof Error ? error.message : "failed to open video",
        );
        setVideoStatus("error");
      }
    },
    [
      handleVideoEnded,
      resolveVideoMaskEffects,
      serializeVideoFrame,
      videoLayout.mediaRect,
    ],
  );

  const startSampleVideo = useCallback(async () => {
    try {
      const asset = Asset.fromModule(basketballVideo);

      await asset.downloadAsync();

      if (!asset.localUri) {
        throw new Error("sample video has no local uri");
      }

      await startVideo(asset.localUri);
    } catch (error) {
      setVideoError(
        error instanceof Error ? error.message : "failed to load sample",
      );
      setVideoStatus("error");
    }
  }, [startVideo]);

  const pickVideoFromLibrary = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        quality: 1,
      });
      const uri = result.assets?.[0]?.uri;

      if (result.canceled || !uri) {
        return;
      }

      await startVideo(uri);
    } catch (error) {
      setVideoError(
        error instanceof Error ? error.message : "failed to pick video",
      );
      setVideoStatus("error");
    }
  }, [startVideo]);

  const pauseVideo = useCallback(() => {
    videoSessionRef.current?.pause();
  }, []);

  const resumeVideo = useCallback(() => {
    if (!videoSessionRef.current) {
      return;
    }

    setVideoStatus("processing");
    void videoSessionRef.current.play();
  }, []);

  const stopVideo = useCallback(() => {
    videoSessionRef.current?.stop();
  }, []);

  useEffect(() => {
    return () => {
      videoRequestId.current += 1;
      void videoSessionRef.current?.destroy();
      videoSessionRef.current = null;
    };
  }, []);

  const modelStatus = formatSegmentationStatus(props.segmentation);
  const modelReady = props.segmentation.isReady;
  const isProcessing =
    videoStatus === "processing" || videoStatus === "opening";
  const isPaused = videoStatus === "paused";
  const progress =
    videoStats && videoStats.durationMs > 0
      ? Math.min(1, videoStats.videoTimeMs / videoStats.durationMs)
      : 0;
  const processedFps = videoStats
    ? videoStats.processedFrames / Math.max(videoStats.wallMs / 1000, 0.001)
    : 0;

  return (
    <View style={styles.liveScreen}>
      <StatusBar hidden />
      <ReactNativeVideoFrameStage
        boxes={videoSyncedOverlays.boxes}
        canvasHeight={canvasHeight}
        canvasStyle={StyleSheet.absoluteFill}
        canvasWidth={canvasWidth}
        labels={videoSyncedOverlays.labels}
        layout={videoLayout}
        onPress={handleVideoStageTap}
        showBoxes
        showMasks
        stageStyle={styles.liveStage}
        session={videoSession}
      >
        <View style={styles.liveTopBar}>
          <View style={styles.liveBrand}>
            <BrandMark />
            <View style={styles.headerCopy}>
              <Text style={styles.title}>supervision-js</Text>
              <Text style={styles.subtitle}>Video RF-DETR analysis</Text>
            </View>
          </View>
          <ModeSwitch mode={props.mode} onModeChange={props.onModeChange} />
        </View>

        <View style={styles.liveStatusCluster}>
          <StatusPill
            tone={modelReady ? "ready" : "warning"}
            value={modelStatus}
          />
          <StatusPill tone="ready" value="strict sync" />
          <StatusPill value={`${videoStats?.detectionCount ?? 0} masks`} />
          <StatusPill
            tone={videoStats?.builder === "native" ? "ready" : undefined}
            value={`prep ${videoStats?.builder ?? "-"}`}
          />
        </View>

        <ClassEffectChips
          classEffects={classEffects}
          onClear={clearClassEffect}
        />

        {videoStatus === "idle" ||
        videoStatus === "done" ||
        videoStatus === "error" ? (
          <View style={[styles.stageOverlay, styles.videoOverlayCard]}>
            <Text style={styles.overlayTitle}>
              {videoStatus === "done"
                ? "Video processed"
                : videoStatus === "error"
                  ? "Video error"
                  : "Saved video"}
            </Text>
            <Text style={styles.overlayBody}>
              {videoStatus === "error"
                ? (videoError ?? "unknown error")
                : modelReady
                  ? "Run RF-DETR on every decoded frame, rendered in strict sync."
                  : modelStatus}
            </Text>
            <View style={styles.videoActionsRow}>
              <TouchableOpacity
                disabled={!modelReady}
                onPress={() => {
                  void startSampleVideo();
                }}
                style={[
                  styles.detectionMenuAction,
                  !modelReady ? styles.videoActionDisabled : null,
                ]}
              >
                <Text style={styles.detectionMenuActionText}>
                  Basketball sample
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={!modelReady}
                onPress={() => {
                  void pickVideoFromLibrary();
                }}
                style={[
                  styles.detectionMenuAction,
                  !modelReady ? styles.videoActionDisabled : null,
                ]}
              >
                <Text style={styles.detectionMenuActionText}>
                  Choose from library
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {isProcessing || isPaused ? (
          <View style={styles.videoHud}>
            <View style={styles.videoProgressTrack}>
              <View
                style={[
                  styles.videoProgressFill,
                  { width: `${Math.round(progress * 100)}%` },
                ]}
              />
            </View>
            <View style={styles.videoMetricsRow}>
              <LiveMetric
                label="Video"
                value={`${formatVideoTime(videoStats?.videoTimeMs ?? 0)} / ${formatVideoTime(videoStats?.durationMs ?? 0)}`}
              />
              <LiveMetric
                label="Seg"
                value={`${Math.round(videoStats?.segmentationMs ?? 0)}ms`}
              />
              <LiveMetric
                label="Fill"
                value={`${Math.round(videoStats?.fillMs ?? 0)}ms`}
              />
              <LiveMetric
                label="Tick"
                value={`${Math.round(videoStats?.tickMs ?? 0)}ms`}
              />
              <LiveMetric label="FPS" value={processedFps.toFixed(1)} />
              <LiveMetric
                label="Frames"
                value={String(videoStats?.processedFrames ?? 0)}
              />
            </View>
            <View style={styles.videoButtonRow}>
              <TouchableOpacity
                onPress={isPaused ? resumeVideo : pauseVideo}
                style={[styles.detectionMenuAction, styles.videoButton]}
              >
                <Text style={styles.detectionMenuActionText}>
                  {isPaused ? "Play" : "Pause"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={stopVideo}
                style={[styles.detectionMenuAction, styles.videoButton]}
              >
                <Text style={styles.detectionMenuActionText}>Stop</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {tapMenuLabel !== null ? (
          <ClassEffectMenu
            classEffects={classEffects}
            label={tapMenuLabel}
            onCancel={() => setTapMenuLabel(null)}
            onSelect={(label, effect) => {
              toggleClassEffect(label, effect);
              setTapMenuLabel(null);
            }}
          />
        ) : null}
      </ReactNativeVideoFrameStage>
    </View>
  );
}

function formatVideoTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function pickDetectionLabelAtPoint(
  point: { readonly x: number; readonly y: number },
  detections: readonly LiveOverlayDetection[],
  layout: ReactNativeFrameLayout,
): string | null {
  let pickedLabel: string | null = null;
  let pickedArea = Number.POSITIVE_INFINITY;

  for (const detection of detections) {
    const rect = layout.mapRect({
      height: detection.bbox.y2 - detection.bbox.y1,
      width: detection.bbox.x2 - detection.bbox.x1,
      x: (detection.bbox.x1 + detection.bbox.x2) / 2,
      y: (detection.bbox.y1 + detection.bbox.y2) / 2,
    });
    const inside =
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height;
    const area = rect.width * rect.height;

    if (inside && area < pickedArea) {
      pickedArea = area;
      pickedLabel = detection.label;
    }
  }

  return pickedLabel;
}

function ClassEffectChips(props: {
  readonly classEffects: LiveClassEffects;
  readonly onClear: (label: string) => void;
}) {
  const entries = Object.entries(props.classEffects);

  if (entries.length === 0) {
    return null;
  }

  return (
    <View style={styles.privacyChipRow}>
      {entries.map(([className, effect]) => (
        <TouchableOpacity
          key={className}
          onPress={() => props.onClear(className)}
        >
          <StatusPill
            tone="ready"
            value={`${effect}: ${className || "object"} ✕`}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

function ClassEffectMenu(props: {
  readonly classEffects: LiveClassEffects;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSelect: (label: string, effect: LiveClassEffect) => void;
}) {
  return (
    <View style={styles.detectionMenu}>
      <Text style={styles.detectionMenuTitle}>{props.label || "object"}</Text>
      {LIVE_CLASS_EFFECT_OPTIONS.map((option) => {
        const active = props.classEffects[props.label] === option.effect;

        return (
          <TouchableOpacity
            key={option.effect}
            onPress={() => props.onSelect(props.label, option.effect)}
            style={[
              styles.detectionMenuAction,
              active ? styles.detectionMenuActionActive : null,
            ]}
          >
            <Text
              style={[
                styles.detectionMenuActionText,
                active ? styles.detectionMenuActionTextActive : null,
              ]}
            >
              {active ? `${option.label} ✓` : option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        onPress={props.onCancel}
        style={styles.detectionMenuCancel}
      >
        <Text style={styles.floatingButtonText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

const DEMO_MODE_OPTIONS: readonly {
  readonly label: string;
  readonly mode: DemoMode;
}[] = [
  { label: "Explore", mode: "home" },
  { label: "Static", mode: "static" },
  { label: "Live", mode: "live" },
  { label: "Video", mode: "video" },
  { label: "Instant CV", mode: "instant" },
];

function ModeSwitch(props: {
  readonly instantRecipe?: InstantCvRecipe;
  readonly mode: DemoMode;
  readonly onInstantRecipeChange?: (recipe: InstantCvRecipe) => void;
  readonly onModeChange: (mode: DemoMode) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active =
    DEMO_MODE_OPTIONS.find((option) => option.mode === props.mode) ??
    DEMO_MODE_OPTIONS[0]!;
  const activeRecipe = INSTANT_CV_RECIPE_OPTIONS.find(
    (option) => option.recipe === props.instantRecipe,
  );
  const triggerLabel =
    props.mode === "instant" && activeRecipe
      ? activeRecipe.label
      : active.label;
  return (
    <View style={styles.modeMenu}>
      <TouchableOpacity
        accessibilityLabel="Choose demo mode"
        onPress={() => setExpanded((current) => !current)}
        style={styles.modeSwitch}
      >
        <Text style={styles.modeSwitchValue}>{triggerLabel}</Text>
        <Text style={styles.modeSwitchChevron}>{expanded ? "⌃" : "⌄"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.modeMenuOptions}>
          {DEMO_MODE_OPTIONS.map((option) => {
            const selected =
              option.mode === props.mode && props.mode !== "instant";

            return (
              <TouchableOpacity
                key={option.mode}
                onPress={() => {
                  setExpanded(false);
                  props.onModeChange(option.mode);
                }}
                style={[
                  styles.modeButton,
                  selected ? styles.modeButtonActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.modeButtonText,
                    selected ? styles.modeButtonTextActive : null,
                  ]}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
          {props.mode === "instant" && props.onInstantRecipeChange ? (
            <>
              <Text style={styles.modeMenuSectionLabel}>Recipes</Text>
              {INSTANT_CV_RECIPE_OPTIONS.map((option) => {
                const selected = option.recipe === props.instantRecipe;

                return (
                  <TouchableOpacity
                    key={option.recipe}
                    onPress={() => {
                      setExpanded(false);
                      props.onInstantRecipeChange?.(option.recipe);
                    }}
                    style={[
                      styles.modeButton,
                      selected ? styles.modeButtonActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.modeButtonText,
                        selected ? styles.modeButtonTextActive : null,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function BrandMark() {
  return (
    <View style={styles.mark}>
      <View style={[styles.markBar, styles.markCyan]} />
      <View style={[styles.markBar, styles.markMint]} />
      <View style={[styles.markBar, styles.markViolet]} />
    </View>
  );
}

function StatusPill(props: {
  readonly tone?: "ready" | "warning";
  readonly value: string;
}) {
  return (
    <View
      style={[
        styles.statusPill,
        props.tone === "ready" ? styles.statusPillReady : null,
        props.tone === "warning" ? styles.statusPillWarning : null,
      ]}
    >
      <View
        style={[
          styles.statusDot,
          props.tone === "ready" ? styles.statusDotReady : null,
          props.tone === "warning" ? styles.statusDotWarning : null,
        ]}
      />
      <Text style={styles.statusPillText}>{props.value}</Text>
    </View>
  );
}

function formatSegmentationStatus(segmentation: LiveSegmentation) {
  return formatInferenceStatus(segmentation, "RF-DETR Seg");
}

function formatInferenceStatus(
  inference: {
    readonly downloadProgress: number;
    readonly error: unknown;
    readonly isReady: boolean;
  },
  readyLabel: string,
) {
  if (inference.error) {
    return "model error";
  }

  if (inference.isReady) {
    return `${readyLabel} ready`;
  }

  return `preloading ${Math.round(inference.downloadProgress * 100)}%`;
}

function Metric(props: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{props.label}</Text>
      <Text style={styles.metricValue}>{props.value}</Text>
    </View>
  );
}

function LiveMetric(props: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.liveMetric}>
      <Text style={styles.liveMetricLabel}>{props.label}</Text>
      <Text style={styles.liveMetricValue}>{props.value}</Text>
    </View>
  );
}

function formatConfidence(confidence: number | undefined) {
  return confidence == null ? "-" : `${Math.round(confidence * 100)}%`;
}

function formatSelected(pick: DetectionPickResult | null) {
  return pick?.detection.className ?? "none";
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function appendLivePerformanceSample(
  samples: readonly LiveFrameState[],
  frame: LiveFrameState,
): readonly LiveFrameState[] {
  const next = [...samples, frame];

  return next.slice(-LIVE_PERFORMANCE_SAMPLE_LIMIT);
}

function summarizeLivePerformance(
  samples: readonly LiveFrameState[],
): LivePerformanceSummary | null {
  if (samples.length === 0) {
    return null;
  }

  const latest = samples[samples.length - 1]!;

  return {
    artifactBytes: latest.artifactBytes,
    artifactHeight: latest.artifactHeight,
    artifactWidth: latest.artifactWidth,
    droppedFrames: latest.droppedFrames,
    fill: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.maskFillMs,
    ),
    maskCount: latest.maskCount,
    prep: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.maskPrepMs,
    ),
    ruleEval: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.ruleEvalMs,
    ),
    sampleCount: samples.length,
    segmentation: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.segmentationMs,
    ),
    serialization: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.serializationMs,
    ),
    tick: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.inferenceTickMs,
    ),
    upload: summarizeLivePerformanceMetric(
      samples,
      (sample) => sample.maskUploadMs,
    ),
  };
}

function summarizeLivePerformanceMetric(
  samples: readonly LiveFrameState[],
  selectValue: (sample: LiveFrameState) => number,
): LivePerformanceMetric {
  const values = samples
    .map(selectValue)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return { p50: 0, p90: 0 };
  }

  return {
    p50: resolveLivePercentile(values, 0.5),
    p90: resolveLivePercentile(values, 0.9),
  };
}

function resolveLivePercentile(values: readonly number[], percentile: number) {
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * percentile) - 1),
  );

  return values[index] ?? 0;
}

function formatLivePerformanceMetric(
  metric: LivePerformanceMetric | null | undefined,
) {
  if (!metric) {
    return "-";
  }

  return `${Math.round(metric.p50)}/${Math.round(metric.p90)}ms`;
}

function formatLiveFallbackReason(reason: string | undefined) {
  if (!reason) {
    return "none";
  }

  return reason.length > 28 ? `${reason.slice(0, 28)}…` : reason;
}

// Mirrors the public documentation palette. Keep camera pixels neutral and
// make the host UI read as a light, calm control surface around them.
const DEMO_COLORS = {
  border: "#e3d9f8",
  borderStrong: "#c4b5fd",
  canvas: "#f5f3ff",
  muted: "#6b7280",
  mutedStrong: "#4b5563",
  primary: "#7c3aed",
  primaryPressed: "#6d28d9",
  primarySoft: "#ede9fe",
  surface: "#ffffff",
  text: "#111827",
} as const;

const styles = StyleSheet.create({
  body: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 12,
    fontWeight: "600",
  },
  brand: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  canvasFrame: {
    backgroundColor: DEMO_COLORS.surface,
    borderColor: DEMO_COLORS.border,
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  card: {
    backgroundColor: DEMO_COLORS.surface,
    borderColor: DEMO_COLORS.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 10,
  },
  cardHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  cardTitle: {
    color: DEMO_COLORS.primary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardValue: {
    color: DEMO_COLORS.text,
    fontSize: 14,
    fontWeight: "800",
    marginTop: 3,
  },
  control: {
    alignItems: "center",
    backgroundColor: DEMO_COLORS.surface,
    borderColor: DEMO_COLORS.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    padding: 10,
  },
  controlCopy: {
    flex: 1,
  },
  captureCamera: {
    bottom: 0,
    left: 0,
    opacity: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  captureCameraVisible: {
    opacity: 1,
  },
  floatingButton: {
    backgroundColor: "rgba(255, 255, 255, 0.74)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  floatingButtonActive: {
    backgroundColor: "rgba(124, 58, 237, 0.82)",
    borderColor: "rgba(196, 181, 253, 0.9)",
  },
  floatingButtonText: {
    color: DEMO_COLORS.primaryPressed,
    fontSize: 11,
    fontWeight: "900",
  },
  floatingButtonTextActive: {
    color: "#ffffff",
  },
  floatingIconButton: {
    backgroundColor: "rgba(255, 255, 255, 0.74)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  frameRendererSurface: {
    overflow: "hidden",
    zIndex: 1,
  },
  frameRendererSurfaceHidden: {
    opacity: 0,
  },
  header: {
    alignItems: "center",
    backgroundColor: DEMO_COLORS.surface,
    borderColor: DEMO_COLORS.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerCopy: {
    gap: 1,
  },
  homeDescription: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 21,
    maxWidth: 560,
  },
  homeEyebrow: {
    color: DEMO_COLORS.primary,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.8,
  },
  homeFootnote: {
    color: DEMO_COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 17,
    maxWidth: 640,
  },
  homeHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  homeHero: {
    gap: 10,
    marginTop: 24,
  },
  homeRecipeAction: {
    color: DEMO_COLORS.primary,
    fontSize: 12,
    fontWeight: "900",
    marginTop: "auto",
  },
  homeRecipeCard: {
    backgroundColor: DEMO_COLORS.surface,
    borderColor: DEMO_COLORS.border,
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    gap: 8,
    minHeight: 178,
    padding: 16,
  },
  homeRecipeDescription: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  homeRecipeGrid: {
    flexDirection: "row",
    gap: 10,
    marginTop: 28,
  },
  homeRecipeGridCompact: {
    flexDirection: "column",
  },
  homeRecipeNumber: {
    alignItems: "center",
    backgroundColor: DEMO_COLORS.primarySoft,
    borderRadius: 999,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  homeRecipeNumberText: {
    color: DEMO_COLORS.primary,
    fontSize: 10,
    fontWeight: "900",
  },
  homeRecipeTitle: {
    color: DEMO_COLORS.text,
    fontSize: 18,
    fontWeight: "900",
  },
  homeScreen: {
    backgroundColor: DEMO_COLORS.canvas,
    flex: 1,
    padding: 18,
  },
  homeTitle: {
    color: DEMO_COLORS.text,
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: -0.8,
    maxWidth: 620,
  },
  mark: {
    backgroundColor: DEMO_COLORS.primarySoft,
    borderColor: DEMO_COLORS.borderStrong,
    borderRadius: 8,
    borderWidth: 1,
    height: 34,
    overflow: "hidden",
    position: "relative",
    width: 34,
  },
  markBar: {
    borderRadius: 4,
    height: 18,
    position: "absolute",
    transform: [{ skewY: "-14deg" }],
    width: 8,
  },
  markCyan: {
    backgroundColor: "#a78bfa",
    left: 9,
    top: 8,
  },
  markMint: {
    backgroundColor: "#c4b5fd",
    left: 18,
    top: 6,
  },
  markViolet: {
    backgroundColor: DEMO_COLORS.primary,
    left: 12,
    top: 18,
  },
  liveActions: {
    bottom: 34,
    flexDirection: "row",
    gap: 8,
    position: "absolute",
    right: 14,
    zIndex: 6,
  },
  liveCameraSwitch: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.58)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 999,
    borderWidth: 1,
    bottom: 34,
    height: 42,
    justifyContent: "center",
    left: 14,
    position: "absolute",
    width: 42,
    zIndex: 8,
  },
  liveCameraSwitchAtInstantTop: {
    bottom: undefined,
    top: 58,
  },
  liveCameraSwitchIcon: {
    color: DEMO_COLORS.primary,
    fontSize: 16,
    fontWeight: "900",
  },
  liveBrand: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.76)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  liveDebugPanel: {
    backgroundColor: "rgba(255, 255, 255, 0.72)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 16,
    borderWidth: 1,
    bottom: 84,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    left: 14,
    padding: 8,
    position: "absolute",
    right: 14,
    zIndex: 6,
  },
  liveMetric: {
    backgroundColor: "rgba(237, 233, 254, 0.72)",
    borderColor: "rgba(255, 255, 255, 0.68)",
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 70,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  liveMetricLabel: {
    color: DEMO_COLORS.muted,
    fontSize: 8,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  liveMetricValue: {
    color: DEMO_COLORS.text,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "900",
    marginTop: 2,
  },
  liveScreen: {
    backgroundColor: "#000000",
    flex: 1,
  },
  liveShowHudButton: {
    backgroundColor: "rgba(255, 255, 255, 0.74)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 999,
    borderWidth: 1,
    bottom: 34,
    paddingHorizontal: 14,
    paddingVertical: 10,
    position: "absolute",
    right: 14,
    zIndex: 6,
  },
  liveStage: {
    backgroundColor: "#000000",
    overflow: "hidden",
  },
  liveStatusCluster: {
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    left: 24,
    position: "absolute",
    right: 24,
    top: 142,
    zIndex: 6,
  },
  instantStatusCard: {
    backgroundColor: "rgba(255, 255, 255, 0.76)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 18,
    borderWidth: 1,
    bottom: 28,
    gap: 8,
    left: 14,
    padding: 14,
    position: "absolute",
    right: 14,
    zIndex: 7,
  },
  instantModeMenu: {
    position: "absolute",
    right: 14,
    top: 58,
    zIndex: 8,
  },
  instantStatusHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  instantStatusTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  instantStatusDot: {
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  instantStatusTitle: {
    color: DEMO_COLORS.text,
    fontSize: 14,
    fontWeight: "900",
  },
  instantStatusCount: {
    color: DEMO_COLORS.primary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    fontWeight: "900",
  },
  instantStatusMessage: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  instantShapeSwitch: {
    backgroundColor: "rgba(237, 233, 254, 0.72)",
    borderRadius: 12,
    flexDirection: "row",
    gap: 4,
    padding: 4,
  },
  instantShapeButton: {
    alignItems: "center",
    borderRadius: 9,
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  instantShapeButtonActive: {
    backgroundColor: "rgba(124, 58, 237, 0.82)",
  },
  instantShapeLabel: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 10,
    fontWeight: "900",
  },
  instantShapeLabelActive: {
    color: "#ffffff",
  },
  instantScore: {
    color: "#ffd166",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    fontWeight: "900",
  },
  instantClassHint: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 12,
    fontWeight: "700",
  },
  instantClassList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  instantSafetyClassChip: {
    backgroundColor: "rgba(255, 241, 242, 0.74)",
    borderColor: "rgba(253, 164, 175, 0.8)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  instantSafetyClassChipText: {
    color: "#9f1239",
    fontSize: 11,
    fontWeight: "900",
  },
  instantReset: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(124, 58, 237, 0.82)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  instantResetText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "900",
  },
  privacyChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "center",
    left: 24,
    position: "absolute",
    right: 24,
    top: 178,
    zIndex: 6,
  },
  detectionMenu: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.78)",
    borderColor: "rgba(255, 255, 255, 0.82)",
    borderRadius: 16,
    borderWidth: 1,
    bottom: 96,
    gap: 8,
    left: 42,
    padding: 12,
    position: "absolute",
    right: 42,
    zIndex: 7,
  },
  detectionMenuTitle: {
    color: DEMO_COLORS.primary,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  detectionMenuAction: {
    alignItems: "center",
    backgroundColor: "rgba(237, 233, 254, 0.74)",
    borderColor: "rgba(255, 255, 255, 0.7)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
    width: "100%",
  },
  detectionMenuActionActive: {
    backgroundColor: "rgba(124, 58, 237, 0.82)",
    borderColor: "rgba(196, 181, 253, 0.9)",
  },
  detectionMenuActionText: {
    color: DEMO_COLORS.primaryPressed,
    fontSize: 12,
    fontWeight: "900",
  },
  detectionMenuActionTextActive: {
    color: "#ffffff",
  },
  detectionMenuCancel: {
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 6,
  },
  videoActionsRow: {
    gap: 8,
    marginTop: 10,
    width: "100%",
  },
  // Sits above the Skia canvas (zIndex 2): keeps the card visible and its
  // buttons tappable, since the canvas otherwise intercepts touches.
  videoOverlayCard: {
    top: 200,
    zIndex: 6,
  },
  videoActionDisabled: {
    opacity: 0.4,
  },
  videoHud: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.76)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 16,
    borderWidth: 1,
    bottom: 34,
    gap: 8,
    left: 14,
    padding: 10,
    position: "absolute",
    right: 14,
    zIndex: 6,
  },
  videoMetricsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    justifyContent: "center",
  },
  videoProgressTrack: {
    backgroundColor: DEMO_COLORS.primarySoft,
    borderRadius: 999,
    height: 6,
    overflow: "hidden",
    width: "100%",
  },
  videoProgressFill: {
    backgroundColor: DEMO_COLORS.primary,
    borderRadius: 999,
    height: 6,
  },
  videoButtonRow: {
    flexDirection: "row",
    gap: 8,
    width: "100%",
  },
  videoButton: {
    flex: 1,
    width: "auto",
  },
  liveTopBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    left: 14,
    position: "absolute",
    right: 14,
    top: 58,
    zIndex: 6,
  },
  metric: {
    backgroundColor: DEMO_COLORS.surface,
    borderColor: DEMO_COLORS.border,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 3,
    minWidth: 0,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  metricLabel: {
    color: DEMO_COLORS.muted,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  metricRow: {
    flexDirection: "row",
    gap: 8,
  },
  metricValue: {
    color: DEMO_COLORS.text,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  metricsGrid: {
    flexDirection: "row",
    gap: 8,
  },
  modeButton: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  modeButtonActive: {
    backgroundColor: DEMO_COLORS.primary,
  },
  modeButtonText: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 11,
    fontWeight: "900",
  },
  modeButtonTextActive: {
    color: "#ffffff",
  },
  modeMenu: {
    alignSelf: "flex-start",
    position: "relative",
    zIndex: 20,
  },
  modeMenuOptions: {
    backgroundColor: "rgba(255, 255, 255, 0.84)",
    borderColor: "rgba(255, 255, 255, 0.86)",
    borderRadius: 12,
    borderWidth: 1,
    gap: 2,
    padding: 4,
    position: "absolute",
    right: 0,
    shadowColor: "#312e81",
    shadowOpacity: 0.14,
    shadowRadius: 16,
    top: 42,
    width: 148,
    zIndex: 20,
  },
  modeMenuSectionLabel: {
    color: DEMO_COLORS.muted,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.8,
    paddingHorizontal: 8,
    paddingTop: 8,
    textTransform: "uppercase",
  },
  modeSwitch: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.76)",
    borderColor: "rgba(255, 255, 255, 0.78)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  modeSwitchChevron: {
    color: DEMO_COLORS.primary,
    fontSize: 14,
    fontWeight: "900",
  },
  modeSwitchValue: {
    color: DEMO_COLORS.primaryPressed,
    fontSize: 11,
    fontWeight: "900",
  },
  safeArea: {
    backgroundColor: DEMO_COLORS.canvas,
    flex: 1,
  },
  screen: {
    backgroundColor: DEMO_COLORS.canvas,
    flex: 1,
    gap: 10,
    padding: 12,
  },
  subtitle: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 11,
    fontWeight: "700",
  },
  shaderReady: {
    borderColor: "#284a34",
  },
  shaderUnavailable: {
    borderColor: "#5b2424",
  },
  stageOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.78)",
    borderColor: "rgba(255, 255, 255, 0.82)",
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    left: 28,
    paddingHorizontal: 14,
    paddingVertical: 12,
    position: "absolute",
    right: 28,
    top: 28,
  },
  overlayBody: {
    color: DEMO_COLORS.mutedStrong,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  overlayTitle: {
    color: DEMO_COLORS.primary,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  stageReadout: {
    bottom: 8,
    flexDirection: "row",
    gap: 6,
    left: 8,
    position: "absolute",
    right: 8,
  },
  statusDot: {
    backgroundColor: "#a1a9b8",
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  statusDotReady: {
    backgroundColor: "#8af59d",
  },
  statusDotWarning: {
    backgroundColor: "#ffd976",
  },
  statusPill: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.72)",
    borderColor: "rgba(255, 255, 255, 0.76)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusPillReady: {
    borderColor: "#284a34",
  },
  statusPillText: {
    color: DEMO_COLORS.text,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  statusPillWarning: {
    borderColor: "#5f5126",
  },
  title: {
    color: DEMO_COLORS.text,
    fontSize: 16,
    fontWeight: "900",
  },
  toggleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
});
