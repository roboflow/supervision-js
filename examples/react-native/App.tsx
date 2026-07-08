import {
  AlphaType,
  Canvas,
  ColorType,
  FilterMode,
  ImageShader,
  Image as SkiaImage,
  MipmapMode,
  Rect,
  RoundedRect,
  Shader,
  Skia,
  Text as SkiaText,
  matchFont,
  type SkImage as SkiaImageType,
  useImage,
} from "@shopify/react-native-skia";
import { StatusBar } from "expo-status-bar";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  Platform,
  type StyleProp,
  type ViewStyle,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Camera,
  NativeFrameRendererView,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  useFrameRenderer,
  type Frame,
} from "react-native-vision-camera";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  BoxShape,
  type BoxDrawInstruction,
  type DetectionPickResult,
  type LabelDrawInstruction,
} from "supervision-js-core";
import { models, useInstanceSegmentation } from "react-native-executorch";
import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
  createReactNativePreparedFramePacket,
  type ReactNativeLiveIdMaskNativeBuilderHandle,
  type ReactNativeLiveSerializedDetection,
  type ReactNativeFrameLayout,
  type ReactNativeIdMaskUniforms,
  createReactNativeLiveIdMaskArtifactAuto,
  loadReactNativeLiveIdMaskNativeBuilder,
  pickReactNativeDetectionAtPoint,
  resolveReactNativeIdMaskUniforms,
  resolveReactNativeLiveIdMaskUniforms,
  resolveReactNativeFrameLayout,
  resolveReactNativeLabelLayout,
} from "supervision-js-react-native";

import basketballFrame from "./assets/basketball-frame.jpg";
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
  createDemoMaskStyle,
  resolveDemoClassColor,
  resolveDemoDetectionColor,
} from "./src/demo-presentation";
import {
  runWithWorkletDebugLogging,
  serializeDebugError,
} from "./src/debug-logging";

type DemoMode = "static" | "live";
type LiveDetectionDisplayMode = "masks" | "boxes";

const LIVE_MAX_INSTANCES = 6;
// No stroke in live mode: a crisp border retraces the low-res mask staircase
// and defeats the feathered fill edges (it also skips the shader's expensive
// border sampling loop).
const LIVE_MASK_ARTIFACT_MAX_PIXELS = 720 * 1280;
const LIVE_MASK_ARTIFACT_MAX_SIDE = 1280;
const LIVE_PRIVACY_MOSAIC_CELL_PX = 14;
// A 1x1 all-ones mask scales across the whole detection bbox in the fill
// loop, so redacted objects are covered by their full bounding box instead of
// their exact mask silhouette — conservative coverage for privacy.
const PRIVACY_FULL_BBOX_MASK = new Uint8Array([1]);
// Masks are drawn exactly as the model returns them, so edge quality comes
// from the model output itself: request masks at original resolution now that
// native prep created the performance headroom for it.
const LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION = true;
const LIVE_FRAME_TARGET_RESOLUTION = { height: 1280, width: 720 };
const LIVE_SEGMENTATION_MIRROR_FRAME = false;
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

function useLiveSegmentation() {
  return useInstanceSegmentation({
    model: liveSegmentationModel,
  });
}

type LiveSegmentation = ReturnType<typeof useLiveSegmentation>;

export default function App() {
  const [mode, setMode] = useState<DemoMode>("static");
  const segmentation = useLiveSegmentation();

  if (mode === "live") {
    return (
      <LiveCameraProof
        mode={mode}
        onModeChange={setMode}
        segmentation={segmentation}
      />
    );
  }

  return (
    <StaticFrameProof
      mode={mode}
      onModeChange={setMode}
      segmentation={segmentation}
    />
  );
}

function StaticFrameProof(props: {
  readonly mode: DemoMode;
  readonly onModeChange: (mode: DemoMode) => void;
  readonly segmentation: LiveSegmentation;
}) {
  const image = useImage(basketballFrame);
  const window = useWindowDimensions();
  const [rounded, setRounded] = useState(true);
  const [selectedPick, setSelectedPick] = useState<DetectionPickResult | null>(
    null,
  );

  const canvasWidth = Math.max(320, window.width - 24);
  const canvasHeight = Math.round(canvasWidth * 0.58);
  const maskStyle = useMemo(() => createDemoMaskStyle(), []);

  const packetPreparation = useMemo(() => {
    const startedAt = Date.now();
    const packet = createReactNativePreparedFramePacket({
      boxStyle: createDemoBoxStyle({ rounded }),
      detectionFrame: basketballDetectionFrame,
      labelStyle: createDemoLabelStyle(),
      maskStyle,
      mediaFrame: {
        metadata: {
          duration: 1 / 30,
          ...basketballFrameMetadata,
        },
        payload: basketballFrame,
      },
    });

    return {
      packet,
      prepMs: Date.now() - startedAt,
    };
  }, [maskStyle, rounded]);
  const presentation = packetPreparation.packet.presentation;

  const layout = useMemo(
    () =>
      resolveReactNativeFrameLayout({
        canvasHeight,
        canvasWidth,
        mediaHeight: presentation.mediaMetadata.height,
        mediaWidth: presentation.mediaMetadata.width,
      }),
    [canvasHeight, canvasWidth, presentation.mediaMetadata],
  );

  const maskPreparation = useMemo(
    () => ({
      artifact: packetPreparation.packet.maskArtifact,
      prepMs: packetPreparation.prepMs,
    }),
    [packetPreparation],
  );
  const maskImage = useMemo(() => {
    if (!maskPreparation.artifact) {
      return null;
    }

    return Skia.Image.MakeImage(
      {
        alphaType: AlphaType.Opaque,
        colorType: ColorType.Alpha_8,
        height: maskPreparation.artifact.height,
        width: maskPreparation.artifact.width,
      },
      Skia.Data.fromBytes(maskPreparation.artifact.data),
      maskPreparation.artifact.width,
    );
  }, [maskPreparation.artifact]);
  const maskEffect = useMemo(
    () => Skia.RuntimeEffect.Make(REACT_NATIVE_ID_MASK_SHADER_SOURCE),
    [],
  );
  const maskUniforms = useMemo(
    () =>
      maskPreparation.artifact
        ? resolveReactNativeIdMaskUniforms({
            artifact: maskPreparation.artifact,
            layout,
          })
        : null,
    [layout, maskPreparation.artifact],
  );
  const maskShaderStatus =
    maskPreparation.artifact && maskImage && maskEffect && maskUniforms
      ? "active"
      : "unavailable";
  const modelStatus = formatSegmentationStatus(props.segmentation);

  const syncedBoxOverlays = useMemo(() => {
    const overlays = createSyncedBoxOverlays(presentation.boxes, layout);

    if (selectedPick?.detection.rect) {
      overlays.push(
        createSyncedBoxOverlay({
          key: "selected",
          rect: layout.mapRect(selectedPick.detection.rect),
          radius: 14 * layout.scale,
          strokeColor: toRgba(
            resolveDemoDetectionColor(selectedPick.detection, 0),
            1,
          ),
          strokeWidth: 4,
        }),
      );
    }

    return overlays;
  }, [layout, presentation.boxes, selectedPick]);
  const syncedLabelOverlays = useMemo(
    () => createSyncedLabelOverlays(presentation.labels, layout),
    [layout, presentation.labels],
  );

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

        <SyncedFrameStage
          backgroundColor="#030712"
          boxes={syncedBoxOverlays}
          canvasHeight={canvasHeight}
          canvasWidth={canvasWidth}
          labels={syncedLabelOverlays}
          layout={layout}
          maskEffect={maskEffect}
          maskImage={maskImage}
          maskUniforms={maskUniforms}
          mediaImage={image}
          onPress={(point) => {
            setSelectedPick(
              pickReactNativeDetectionAtPoint(
                basketballDetectionFrame,
                layout,
                point,
                { padding: 8 },
              ),
            );
          }}
          stageStyle={styles.canvasFrame}
        >
          <View style={styles.stageReadout}>
            <StatusPill tone="ready" value="media + detections" />
            <StatusPill
              tone={props.segmentation.isReady ? "ready" : "warning"}
              value={modelStatus}
            />
            <StatusPill
              value={`${maskPreparation.artifact?.maskCount ?? 0} masks`}
            />
            <StatusPill
              value={`${formatBytes(
                maskPreparation.artifact?.data.byteLength ?? 0,
              )} artifact`}
            />
          </View>
        </SyncedFrameStage>

        <View style={styles.metricsGrid}>
          <Metric label="Frame" value="#0" />
          <Metric
            label="Detections"
            value={String(presentation.boxes.length)}
          />
          <Metric label="Scale" value={`${layout.scale.toFixed(3)}x`} />
          <Metric label="Selected" value={formatSelected(selectedPick)} />
        </View>

        <View
          style={[
            styles.card,
            maskShaderStatus === "active"
              ? styles.shaderReady
              : styles.shaderUnavailable,
          ]}
        >
          <View style={styles.cardHeader}>
            <View>
              <Text style={styles.cardTitle}>Prepared ID mask</Text>
              <Text style={styles.cardValue}>
                {maskShaderStatus === "active"
                  ? "One frame artifact, one shader pass"
                  : "Shader unavailable"}
              </Text>
            </View>
            <StatusPill
              tone={maskShaderStatus === "active" ? "ready" : "warning"}
              value={maskShaderStatus === "active" ? "gpu path" : "fallback"}
            />
          </View>
          <View style={styles.metricRow}>
            <Metric
              label="Masks"
              value={String(maskPreparation.artifact?.maskCount ?? 0)}
            />
            <Metric
              label="Artifact"
              value={formatBytes(
                maskPreparation.artifact?.data.byteLength ?? 0,
              )}
            />
            <Metric label="Prep" value={`${maskPreparation.prepMs}ms`} />
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
      </View>
    </SafeAreaView>
  );
}

type LiveSerializedDetection = ReactNativeLiveSerializedDetection;

interface LiveFrameState {
  readonly artifactBytes: number;
  readonly artifactHeight: number;
  readonly artifactWidth: number;
  readonly droppedFrames: number;
  readonly frameIsMirrored: boolean;
  readonly framePixelFormat: string;
  readonly frameOrientation: string;
  readonly hasPresentedFrame: boolean;
  readonly height: number;
  readonly inferenceTickMs: number;
  readonly maskBuilder: string;
  readonly maskFallbackReason: string;
  readonly maskJsFallbackCount: number;
  readonly maskResolution: string;
  readonly maskCount: number;
  readonly maskFillMs: number;
  readonly maskPrepMs: number;
  readonly maskUploadMs: number;
  readonly segmentationMs: number;
  readonly serializationMs: number;
  readonly shaderActive: boolean;
  readonly syncMode: "synced";
  readonly timestamp: number;
  readonly width: number;
}

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
  readonly sampleCount: number;
  readonly segmentation: LivePerformanceMetric;
  readonly serialization: LivePerformanceMetric;
  readonly tick: LivePerformanceMetric;
  readonly upload: LivePerformanceMetric;
}

interface LiveOverlayDetection {
  readonly bbox: LiveSerializedDetection["bbox"];
  readonly color: number;
  readonly label: string;
  readonly score: number;
}

interface LiveFrameError {
  readonly code: string;
  readonly frameHeight: number;
  readonly framePixelFormat: string;
  readonly frameTimestamp: number;
  readonly frameWidth: number;
  readonly hasNativeBuffer: boolean;
  readonly hasPixelBuffer: boolean;
  readonly isPlanar: boolean;
  readonly message: string;
  readonly name: string;
  readonly stage: string;
}

interface LiveMediaRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface SyncedRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface SyncedBoxOverlay {
  readonly fillColor?: string;
  readonly key: string;
  readonly radius: number;
  readonly rect: SyncedRect;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
}

interface SyncedLabelOverlay {
  readonly backgroundColor?: string;
  readonly backgroundRect: SyncedRect;
  readonly baselineY: number;
  readonly cornerRadius: number;
  readonly font: ReturnType<typeof matchFont>;
  readonly key: string;
  readonly text: string;
  readonly textColor: string;
  readonly textX: number;
}

interface SyncedFrameStageProps {
  readonly backgroundColor?: string;
  readonly boxes: readonly SyncedBoxOverlay[];
  readonly canvasHeight: number;
  readonly canvasStyle?: StyleProp<ViewStyle>;
  readonly canvasWidth: number;
  readonly children?: ReactNode;
  readonly labels: readonly SyncedLabelOverlay[];
  readonly layout: ReactNativeFrameLayout;
  readonly maskEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | null;
  readonly maskImage?: unknown;
  readonly maskUniforms?: unknown;
  readonly mediaImage?: SkiaImageType | null;
  readonly mediaLayer?: ReactNode;
  readonly onPress?: (point: {
    readonly x: number;
    readonly y: number;
  }) => void;
  readonly showBoxes?: boolean;
  readonly showMasks?: boolean;
  readonly stageStyle?: StyleProp<ViewStyle>;
}

function SyncedFrameStage(props: SyncedFrameStageProps) {
  const showMasks = props.showMasks ?? true;
  const showBoxes = props.showBoxes ?? true;

  return (
    <View
      onResponderRelease={
        props.onPress
          ? (event) => {
              props.onPress?.({
                x: event.nativeEvent.locationX,
                y: event.nativeEvent.locationY,
              });
            }
          : undefined
      }
      onStartShouldSetResponder={props.onPress ? () => true : undefined}
      style={[
        styles.syncedFrameStage,
        props.stageStyle,
        { height: props.canvasHeight, width: props.canvasWidth },
      ]}
    >
      {props.mediaLayer}
      <Canvas
        style={[
          styles.canvasSurface,
          props.canvasStyle,
          { height: props.canvasHeight, width: props.canvasWidth },
        ]}
      >
        {props.backgroundColor ? (
          <Rect
            color={props.backgroundColor}
            height={props.canvasHeight}
            width={props.canvasWidth}
            x={0}
            y={0}
          />
        ) : null}
        {props.mediaImage ? (
          <SkiaImage
            fit="fill"
            height={props.layout.mediaRect.height}
            image={props.mediaImage}
            width={props.layout.mediaRect.width}
            x={props.layout.mediaRect.x}
            y={props.layout.mediaRect.y}
          />
        ) : null}
        {showMasks &&
        props.maskEffect &&
        props.maskImage &&
        props.maskUniforms ? (
          <Rect
            height={props.layout.mediaRect.height}
            width={props.layout.mediaRect.width}
            x={props.layout.mediaRect.x}
            y={props.layout.mediaRect.y}
          >
            <Shader
              source={props.maskEffect}
              uniforms={props.maskUniforms as never}
            >
              <ImageShader
                fit="fill"
                image={props.maskImage as never}
                rect={props.layout.mediaRect}
                sampling={{
                  filter: FilterMode.Nearest,
                  mipmap: MipmapMode.None,
                }}
                tx="clamp"
                ty="clamp"
              />
            </Shader>
          </Rect>
        ) : null}
        {showBoxes
          ? props.boxes.map((box) => (
              <Fragment key={box.key}>
                {box.fillColor ? (
                  <RoundedRect
                    color={box.fillColor}
                    height={box.rect.height}
                    r={box.radius}
                    width={box.rect.width}
                    x={box.rect.x}
                    y={box.rect.y}
                  />
                ) : null}
                {box.strokeColor && box.strokeWidth ? (
                  <RoundedRect
                    color={box.strokeColor}
                    height={box.rect.height}
                    r={box.radius}
                    strokeWidth={box.strokeWidth}
                    style="stroke"
                    width={box.rect.width}
                    x={box.rect.x}
                    y={box.rect.y}
                  />
                ) : null}
              </Fragment>
            ))
          : null}
        {props.labels.map((label) => (
          <Fragment key={label.key}>
            {label.backgroundColor ? (
              <RoundedRect
                color={label.backgroundColor}
                height={label.backgroundRect.height}
                r={label.cornerRadius}
                width={label.backgroundRect.width}
                x={label.backgroundRect.x}
                y={label.backgroundRect.y}
              />
            ) : null}
            <SkiaText
              color={label.textColor}
              font={label.font}
              text={label.text}
              x={label.textX}
              y={label.baselineY}
            />
          </Fragment>
        ))}
      </Canvas>
      {props.children}
    </View>
  );
}

function createSyncedBoxOverlays(
  boxes: readonly BoxDrawInstruction[],
  layout: ReactNativeFrameLayout,
) {
  return boxes.map((box, index) => {
    const radius =
      box.shape === BoxShape.RoundedRect ? (box.cornerRadius ?? 0) : 0;

    return createSyncedBoxOverlay({
      fillColor: box.fill ? toRgba(box.fill.color, box.fill.alpha) : undefined,
      key: `${box.rect.x}:${box.rect.y}:${index}`,
      radius: radius * layout.scale,
      rect: layout.mapRect(box.rect),
      strokeColor: box.stroke
        ? toRgba(box.stroke.color, box.stroke.alpha)
        : undefined,
      strokeWidth: box.stroke?.width,
    });
  });
}

function createSyncedBoxOverlay(overlay: SyncedBoxOverlay): SyncedBoxOverlay {
  return overlay;
}

function createSyncedLabelOverlays(
  labels: readonly LabelDrawInstruction[],
  layout: ReactNativeFrameLayout,
) {
  return labels.map((label, index) => {
    const fontSize = label.textStyle?.fontSize ?? 13;
    const font = matchFont({ fontSize });
    const bounds = font.measureText(label.text);
    const metrics = font.getMetrics();
    const textHeight = metrics.descent - metrics.ascent;
    const labelLayout = resolveReactNativeLabelLayout({
      instruction: label,
      layout,
      textSize: {
        height: textHeight,
        width: bounds.width,
      },
    });

    return {
      backgroundColor: label.background
        ? toRgba(label.background.color, label.background.alpha)
        : undefined,
      backgroundRect: labelLayout.backgroundRect,
      baselineY: labelLayout.textPoint.y - metrics.ascent,
      cornerRadius: labelLayout.cornerRadius,
      font,
      key: `${label.text}:${index}`,
      text: label.text,
      textColor: toRgba(
        label.textStyle?.color ?? 0xffffff,
        label.textStyle?.alpha ?? 1,
      ),
      textX: labelLayout.textPoint.x,
    };
  });
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
  const packet = createReactNativePreparedFramePacket({
    boxStyle: createDemoBoxStyle(),
    detectionFrame,
    labelStyle: createDemoLabelStyle(),
    mediaFrame: {
      metadata: {
        duration: 1 / 30,
        frameIndex: detectionFrame.frameIndex ?? 0,
        height: options.mediaHeight,
        mediaTime: detectionFrame.mediaTime,
        width: options.mediaWidth,
      },
      payload: null,
    },
  });

  return {
    boxes: createSyncedBoxOverlays(packet.presentation.boxes, options.layout),
    labels: createSyncedLabelOverlays(
      packet.presentation.labels,
      options.layout,
    ),
  };
}

function LiveCameraProof(props: {
  readonly mode: DemoMode;
  readonly onModeChange: (mode: DemoMode) => void;
  readonly segmentation: LiveSegmentation;
}) {
  const window = useWindowDimensions();
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
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
  const [detectionDisplayMode, setDetectionDisplayMode] =
    useState<LiveDetectionDisplayMode>("masks");
  const [redactedClasses, setRedactedClasses] = useState<readonly string[]>([]);
  const [tapMenuLabel, setTapMenuLabel] = useState<string | null>(null);
  const frameRenderer = useFrameRenderer();
  const canvasWidth = window.width;
  const canvasHeight = window.height;
  const showMaskLayer = detectionDisplayMode === "masks";
  const showBoxLayer = detectionDisplayMode === "boxes";
  // The mask lane doubles as the redaction lane: when classes are redacted in
  // boxes display mode, the mask artifact still runs and carries the opaque
  // mosaic bbox fills.
  const redactionActive = redactedClasses.length > 0;
  const emptyLiveMaskUniforms = useMemo(
    () => createEmptyLiveMaskUniforms(),
    [],
  );
  const liveLayout = useMemo(
    () =>
      resolveReactNativeFrameLayout({
        canvasHeight,
        canvasWidth,
        mediaHeight: liveFrame?.height ?? LIVE_FRAME_TARGET_RESOLUTION.height,
        mediaWidth: liveFrame?.width ?? LIVE_FRAME_TARGET_RESOLUTION.width,
      }),
    [canvasHeight, canvasWidth, liveFrame?.height, liveFrame?.width],
  );
  const liveFrameRendererStyle = useMemo(
    () =>
      resolveLiveFrameRendererStyle({
        canvasHeight,
        canvasWidth,
        orientation: liveFrame?.frameOrientation ?? "left",
      }),
    [canvasHeight, canvasWidth, liveFrame?.frameOrientation],
  );
  const livePerformance = useMemo(
    () => summarizeLivePerformance(livePerformanceSamples),
    [livePerformanceSamples],
  );
  const liveMaskImage = useSharedValue<SkiaImageType | null>(null);
  // Holds the mask image that was on screen one packet ago. Disposing the
  // previous image immediately after swapping races the UI thread, which can
  // still be drawing it — an ImageShader over a disposed image paints the
  // whole media rect black. Deferring disposal by one packet removes the race.
  const retiredLiveMaskImage = useSharedValue<SkiaImageType | null>(null);
  const liveMaskUniforms = useSharedValue<ReactNativeIdMaskUniforms>(
    createEmptyLiveMaskUniforms(),
  );
  const liveMediaRect = useSharedValue<LiveMediaRect>({
    height: liveLayout.mediaRect.height,
    width: liveLayout.mediaRect.width,
    x: liveLayout.mediaRect.x,
    y: liveLayout.mediaRect.y,
  });
  const lastReadoutReportAt = useSharedValue(0);
  const lastErrorReportAt = useSharedValue(0);
  const droppedFrameCount = useSharedValue(0);
  const lastPresentedFrame = useSharedValue(false);
  const lastArtifactBytes = useSharedValue(0);
  const lastArtifactHeight = useSharedValue(0);
  const lastArtifactWidth = useSharedValue(0);
  const lastInferenceTickDurationMs = useSharedValue(0);
  const lastMaskCount = useSharedValue(0);
  const lastMaskFillDurationMs = useSharedValue(0);
  const lastMaskPrepDurationMs = useSharedValue(0);
  const lastMaskUploadDurationMs = useSharedValue(0);
  const lastSegmentationDurationMs = useSharedValue(0);
  const lastSerializationDurationMs = useSharedValue(0);
  const lastShaderActive = useSharedValue(false);
  const lastMaskBuilderName = useSharedValue("none");
  const lastMaskFallbackReason = useSharedValue("");
  const lastMaskJsFallbackCount = useSharedValue(0);
  const liveNativeMaskBuilder = useMemo(
    () => loadReactNativeLiveIdMaskNativeBuilder(),
    [],
  );
  // Mirrors the display-mode state into a shared value so the frame worklet
  // does not capture React state. Capturing state (or any per-render value)
  // changes the worklet identity every render, which makes useFrameOutput
  // re-serialize and swap the camera frame callback on the live camera thread
  // several times per second.
  const showMaskLayerShared = useSharedValue(showMaskLayer);
  const redactedClassesShared = useSharedValue<readonly string[]>([]);
  const runSegmentationOnFrame = props.segmentation.runOnFrame;
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
    liveMediaRect.value = {
      height: liveLayout.mediaRect.height,
      width: liveLayout.mediaRect.width,
      x: liveLayout.mediaRect.x,
      y: liveLayout.mediaRect.y,
    };
  }, [liveLayout.mediaRect, liveMediaRect]);
  useEffect(() => {
    setLivePerformanceSamples([]);
  }, [detectionDisplayMode]);
  useEffect(() => {
    showMaskLayerShared.value = showMaskLayer;
  }, [showMaskLayer, showMaskLayerShared]);
  useEffect(() => {
    redactedClassesShared.value = redactedClasses;
  }, [redactedClasses, redactedClassesShared]);

  const reportLiveFrame = useCallback((frame: LiveFrameState) => {
    setLiveFrame(frame);
    setLivePerformanceSamples((samples) =>
      appendLivePerformanceSample(samples, frame),
    );
  }, []);
  const reportDroppedFrame = useCallback(() => {
    droppedFrameCount.value += 1;
  }, [droppedFrameCount]);
  const reportLiveError = useCallback((error: LiveFrameError) => {
    console.error("[debug][rn-live]", error);
    setLiveError(error);
  }, []);
  const reportLiveDetections = useCallback(
    (detections: readonly LiveOverlayDetection[]) => {
      setLiveDetections(detections);
    },
    [],
  );
  // Tapping a detection opens a small action menu for its class. Class-based
  // actions need no tracker: the class name is the identity, and any new
  // instance of a redacted class is covered the moment it is detected.
  const handleLiveStageTap = useCallback(
    (point: { readonly x: number; readonly y: number }) => {
      let pickedLabel: string | null = null;
      let pickedArea = Number.POSITIVE_INFINITY;

      for (const detection of liveDetections) {
        const rect = liveLayout.mapRect({
          height: detection.bbox.y2 - detection.bbox.y1,
          width: detection.bbox.x2 - detection.bbox.x1,
          x: detection.bbox.x1,
          y: detection.bbox.y1,
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

      setTapMenuLabel(pickedLabel);
    },
    [liveDetections, liveLayout],
  );
  const toggleRedactedClass = useCallback((label: string) => {
    setRedactedClasses((classes) =>
      classes.includes(label)
        ? classes.filter((className) => className !== label)
        : [...classes, label],
    );
  }, []);

  // Stable identity matters: useFrameOutput re-serializes and swaps the
  // camera frame callback whenever this function changes, so its dependencies
  // must all be render-stable (shared values, useCallback reporters, memoized
  // handles). Per-render data flows in through shared values instead.
  const onLiveInferenceFrame = useCallback(
    (frame: Frame) => {
      "worklet";

      let stage = "start";

      try {
        const syncMode = "synced";
        const segmentFrame = runSegmentationOnFrame;
        const shouldRunInference = segmentFrame !== null;

        if (shouldRunInference) {
          const inferenceStartedAt = Date.now();

          stage = "segmentation-run";
          const segmentationStartedAt = Date.now();
          const rawDetections = runWithWorkletDebugLogging(
            {
              args: createLiveFrameDebugArgs(stage, frame),
              description: "run RF-DETR segmentation on camera frame",
              namespace: "rn-live",
            },
            () =>
              segmentFrame(frame, LIVE_SEGMENTATION_MIRROR_FRAME, {
                confidenceThreshold: 0.45,
                maxInstances: LIVE_MAX_INSTANCES,
                returnMaskAtOriginalResolution:
                  LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION,
              }),
          );
          const segmentationMs = Date.now() - segmentationStartedAt;
          stage = "mask-read-layout";
          const mediaRect = liveMediaRect.value;
          const detectionFrameSize = resolveLiveDetectionFrameSize(frame);
          stage = "mask-serialize-detections";
          const serializationStartedAt = Date.now();
          const detections = runWithWorkletDebugLogging(
            {
              args: {
                detectionCount: rawDetections.length,
                frameHeight: frame.height,
                framePixelFormat: frame.pixelFormat,
                frameTimestamp: frame.timestamp,
                frameWidth: frame.width,
                stage,
              },
              description: "serialize RF-DETR detections for live mask prep",
              namespace: "rn-live",
            },
            () => {
              const serialized: LiveSerializedDetection[] = [];

              for (let index = 0; index < rawDetections.length; index += 1) {
                const detection = rawDetections[index]!;
                const label: string =
                  typeof detection.label === "string" ? detection.label : "";
                const color = resolveDemoClassColor(label, index % 10);

                serialized[index] = {
                  bbox: detection.bbox,
                  color,
                  label,
                  mask: detection.mask,
                  maskHeight: detection.maskHeight,
                  maskWidth: detection.maskWidth,
                  score: detection.score,
                };
              }

              return serialized;
            },
          );
          const serializationMs = Date.now() - serializationStartedAt;
          const overlayDetections: LiveOverlayDetection[] = [];

          for (let index = 0; index < detections.length; index += 1) {
            const detection = detections[index]!;

            overlayDetections[index] = {
              bbox: detection.bbox,
              color: detection.color,
              label: detection.label ?? "object",
              score: detection.score ?? 0,
            };
          }

          scheduleOnRN(reportLiveDetections, overlayDetections);

          stage = "redaction-filter";
          const redactedList = redactedClassesShared.value;
          const redactionEnabled = redactedList.length > 0;
          const masksDisplayed = showMaskLayerShared.value;
          let maskDetections = detections;
          const mosaicMaskIds: number[] = [];

          if (redactionEnabled) {
            if (masksDisplayed) {
              // Masks display: the artifact keeps every detection; redacted
              // classes are flagged so the shader fills their mask silhouette
              // with the opaque mosaic instead of the translucent color.
              for (let index = 0; index < detections.length; index += 1) {
                const detection = detections[index]!;

                if (redactedList.indexOf(detection.label ?? "") !== -1) {
                  mosaicMaskIds[mosaicMaskIds.length] = index + 1;
                }
              }
            } else {
              // Boxes display: the mask lane carries only redacted classes,
              // each rewritten to a 1x1 all-ones mask so its whole bbox fills
              // opaquely with the mosaic — conservative, never mask-shaped.
              const selected: LiveSerializedDetection[] = [];

              for (let index = 0; index < detections.length; index += 1) {
                const detection = detections[index]!;

                if (redactedList.indexOf(detection.label ?? "") !== -1) {
                  mosaicMaskIds[selected.length] = selected.length + 1;
                  selected[selected.length] = {
                    bbox: detection.bbox,
                    color: detection.color,
                    label: detection.label,
                    mask: PRIVACY_FULL_BBOX_MASK,
                    maskHeight: 1,
                    maskWidth: 1,
                    score: detection.score,
                  };
                }
              }

              maskDetections = selected;
            }
          }

          stage = "mask-prepare";
          const maskStartedAt = Date.now();
          let preparedMask: LiveSkiaMaskFrame | null = null;

          if (masksDisplayed || redactionEnabled) {
            try {
              preparedMask = createLiveSkiaMaskFrame({
                artifactMaxPixels: LIVE_MASK_ARTIFACT_MAX_PIXELS,
                artifactMaxSide: LIVE_MASK_ARTIFACT_MAX_SIDE,
                detections: maskDetections,
                edgeSmoothing: masksDisplayed ? undefined : 0,
                frameHeight: detectionFrameSize.height,
                frameWidth: detectionFrameSize.width,
                mediaRect: {
                  height: mediaRect.height,
                  width: mediaRect.width,
                  x: mediaRect.x,
                  y: mediaRect.y,
                },
                mosaicCellPx: LIVE_PRIVACY_MOSAIC_CELL_PX,
                mosaicMaskIds,
                nativeBuilder: liveNativeMaskBuilder,
              });
            } catch (error) {
              if (Date.now() - lastErrorReportAt.value > 250) {
                lastErrorReportAt.value = Date.now();
                scheduleOnRN(
                  reportLiveError,
                  createLiveFrameError(stage, error, frame),
                );
              }
            }
          }

          const maskPrepMs = Date.now() - maskStartedAt;
          const maskCount = rawDetections.length;

          if (preparedMask) {
            lastMaskBuilderName.value = preparedMask.builder;
            lastMaskFallbackReason.value = preparedMask.fallbackReason ?? "";

            if (preparedMask.builder === "js") {
              lastMaskJsFallbackCount.value += 1;
            }
          }

          lastInferenceTickDurationMs.value = Date.now() - inferenceStartedAt;
          lastArtifactBytes.value = preparedMask?.byteLength ?? 0;
          lastArtifactHeight.value = preparedMask?.height ?? 0;
          lastArtifactWidth.value = preparedMask?.width ?? 0;
          lastMaskCount.value = maskCount;
          lastMaskFillDurationMs.value = preparedMask?.fillMs ?? 0;
          lastMaskPrepDurationMs.value = maskPrepMs;
          lastMaskUploadDurationMs.value = preparedMask?.uploadMs ?? 0;
          lastSegmentationDurationMs.value = segmentationMs;
          lastSerializationDurationMs.value = serializationMs;

          if (preparedMask) {
            stage = "mask-assign-prepared";
            runWithWorkletDebugLogging(
              {
                args: {
                  frameHeight: frame.height,
                  framePixelFormat: frame.pixelFormat,
                  frameTimestamp: frame.timestamp,
                  frameWidth: frame.width,
                  maskCount,
                  stage,
                },
                description: "assign prepared live mask shared values",
                namespace: "rn-live",
              },
              () => {
                const previousMaskImage = liveMaskImage.value;
                const retiredMaskImage = retiredLiveMaskImage.value;

                liveMaskUniforms.value = preparedMask.uniforms;
                liveMaskImage.value = preparedMask.image;
                retiredLiveMaskImage.value = previousMaskImage;
                disposeLiveSkiaImage(retiredMaskImage);
              },
            );
            lastShaderActive.value = true;
          } else {
            stage = "mask-assign-empty";
            runWithWorkletDebugLogging(
              {
                args: {
                  frameHeight: frame.height,
                  framePixelFormat: frame.pixelFormat,
                  frameTimestamp: frame.timestamp,
                  frameWidth: frame.width,
                  maskCount,
                  stage,
                },
                description: "clear live mask shared values",
                namespace: "rn-live",
              },
              () => {
                const previousMaskImage = liveMaskImage.value;
                const retiredMaskImage = retiredLiveMaskImage.value;

                liveMaskUniforms.value = emptyLiveMaskUniforms;
                liveMaskImage.value = null;
                retiredLiveMaskImage.value = previousMaskImage;
                disposeLiveSkiaImage(retiredMaskImage);
              },
            );
            lastShaderActive.value = false;
          }

          stage = "render-synced-frame";
          runWithWorkletDebugLogging(
            {
              args: {
                frameHeight: frame.height,
                framePixelFormat: frame.pixelFormat,
                frameTimestamp: frame.timestamp,
                frameWidth: frame.width,
                maskCount,
                stage,
              },
              description:
                "present camera frame only after matching mask packet is ready",
              namespace: "rn-live",
            },
            () => {
              frameRenderer.renderFrame(frame);
              lastPresentedFrame.value = true;
            },
          );
        }

        if (Date.now() - lastReadoutReportAt.value > 250) {
          stage = "readout-report";
          lastReadoutReportAt.value = Date.now();
          scheduleOnRN(reportLiveFrame, {
            artifactBytes: lastArtifactBytes.value,
            artifactHeight: lastArtifactHeight.value,
            artifactWidth: lastArtifactWidth.value,
            droppedFrames: droppedFrameCount.value,
            framePixelFormat: frame.pixelFormat,
            frameOrientation: frame.orientation,
            frameIsMirrored: frame.isMirrored,
            hasPresentedFrame: lastPresentedFrame.value,
            height: resolveLiveDetectionFrameSize(frame).height,
            inferenceTickMs: lastInferenceTickDurationMs.value,
            maskBuilder: lastMaskBuilderName.value,
            maskFallbackReason: lastMaskFallbackReason.value,
            maskJsFallbackCount: lastMaskJsFallbackCount.value,
            maskResolution: LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION
              ? "original"
              : "model",
            maskCount: lastMaskCount.value,
            maskFillMs: lastMaskFillDurationMs.value,
            maskPrepMs: lastMaskPrepDurationMs.value,
            maskUploadMs: lastMaskUploadDurationMs.value,
            segmentationMs: lastSegmentationDurationMs.value,
            serializationMs: lastSerializationDurationMs.value,
            shaderActive: lastShaderActive.value,
            syncMode,
            timestamp: frame.timestamp,
            width: resolveLiveDetectionFrameSize(frame).width,
          });
        }
      } catch (error) {
        if (Date.now() - lastErrorReportAt.value > 250) {
          lastErrorReportAt.value = Date.now();
          scheduleOnRN(
            reportLiveError,
            createLiveFrameError(stage, error, frame),
          );
        }
      } finally {
        frame.dispose();
      }
    },
    [
      droppedFrameCount,
      emptyLiveMaskUniforms,
      frameRenderer,
      lastArtifactBytes,
      lastArtifactHeight,
      lastArtifactWidth,
      lastErrorReportAt,
      lastInferenceTickDurationMs,
      lastMaskBuilderName,
      lastMaskCount,
      lastMaskFallbackReason,
      lastMaskFillDurationMs,
      lastMaskJsFallbackCount,
      lastMaskPrepDurationMs,
      lastMaskUploadDurationMs,
      lastPresentedFrame,
      lastReadoutReportAt,
      lastSegmentationDurationMs,
      lastSerializationDurationMs,
      lastShaderActive,
      liveMaskImage,
      liveMaskUniforms,
      liveMediaRect,
      liveNativeMaskBuilder,
      redactedClassesShared,
      reportLiveDetections,
      reportLiveError,
      reportLiveFrame,
      retiredLiveMaskImage,
      runSegmentationOnFrame,
      showMaskLayerShared,
    ],
  );

  const inferenceFrameOutput = useFrameOutput({
    allowDeferredStart: false,
    dropFramesWhileBusy: true,
    enablePhysicalBufferRotation: false,
    enablePreviewSizedOutputBuffers: true,
    onFrame: onLiveInferenceFrame,
    onFrameDropped() {
      reportDroppedFrame();
    },
    pixelFormat: "rgb",
    targetResolution: LIVE_FRAME_TARGET_RESOLUTION,
  });

  const cameraOutputs = useMemo(
    () => [inferenceFrameOutput],
    [inferenceFrameOutput],
  );

  const liveMaskEffect = useMemo(
    () => Skia.RuntimeEffect.Make(REACT_NATIVE_ID_MASK_SHADER_SOURCE),
    [],
  );

  const modelStatus = formatSegmentationStatus(props.segmentation);
  const canRunCamera = hasPermission && device && props.segmentation.isReady;

  return (
    <View style={styles.liveScreen}>
      <StatusBar hidden />
      <SyncedFrameStage
        boxes={liveSyncedOverlays.boxes}
        canvasHeight={canvasHeight}
        canvasStyle={StyleSheet.absoluteFill}
        canvasWidth={canvasWidth}
        labels={liveSyncedOverlays.labels}
        layout={liveLayout}
        maskEffect={liveMaskEffect}
        maskImage={liveMaskImage}
        maskUniforms={liveMaskUniforms}
        onPress={handleLiveStageTap}
        mediaLayer={
          <>
            {device ? (
              <Camera
                device={device}
                isActive={Boolean(canRunCamera)}
                orientationSource="interface"
                outputs={cameraOutputs}
                style={styles.captureCamera}
              />
            ) : null}
            <NativeFrameRendererView
              renderer={frameRenderer}
              style={[styles.frameRendererSurface, liveFrameRendererStyle]}
            />
          </>
        }
        showBoxes={showBoxLayer}
        showMasks={showMaskLayer || redactionActive}
        stageStyle={styles.liveStage}
      >
        {!canRunCamera ? (
          <View style={styles.stageOverlay}>
            <Text style={styles.overlayTitle}>Live camera</Text>
            <Text style={styles.overlayBody}>
              {!hasPermission
                ? "Waiting for camera permission"
                : !device
                  ? "No back camera available"
                  : modelStatus}
            </Text>
          </View>
        ) : null}

        {showLiveHud ? (
          <>
            <View style={styles.liveTopBar}>
              <View style={styles.liveBrand}>
                <BrandMark />
                <View style={styles.headerCopy}>
                  <Text style={styles.title}>supervision-js</Text>
                  <Text style={styles.subtitle}>Live RF-DETR camera</Text>
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
                value={`${liveFrame?.maskCount ?? 0} ${detectionDisplayMode}`}
              />
            </View>

            {redactionActive ? (
              <View style={styles.privacyChipRow}>
                {redactedClasses.map((className) => (
                  <TouchableOpacity
                    key={className}
                    onPress={() =>
                      setRedactedClasses((classes) =>
                        classes.filter((entry) => entry !== className),
                      )
                    }
                  >
                    <StatusPill
                      tone="ready"
                      value={`hidden: ${className || "object"} ✕`}
                    />
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <View style={styles.liveActions}>
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
                  value={LIVE_SEGMENTATION_PROFILE_LABEL}
                />
                <LiveMetric
                  label="Seg p50/p90"
                  value={formatLivePerformanceMetric(
                    livePerformance?.segmentation,
                  )}
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

        {tapMenuLabel !== null ? (
          <View style={styles.detectionMenu}>
            <Text style={styles.detectionMenuTitle}>
              {tapMenuLabel || "object"}
            </Text>
            <TouchableOpacity
              onPress={() => {
                toggleRedactedClass(tapMenuLabel);
                setTapMenuLabel(null);
              }}
              style={styles.detectionMenuAction}
            >
              <Text style={styles.detectionMenuActionText}>
                {redactedClasses.includes(tapMenuLabel)
                  ? "Show (remove redaction)"
                  : "Redact (privacy)"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setTapMenuLabel(null)}
              style={styles.detectionMenuCancel}
            >
              <Text style={styles.floatingButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </SyncedFrameStage>
    </View>
  );
}

function ModeSwitch(props: {
  readonly mode: DemoMode;
  readonly onModeChange: (mode: DemoMode) => void;
}) {
  return (
    <View style={styles.modeSwitch}>
      <TouchableOpacity
        onPress={() => props.onModeChange("static")}
        style={[
          styles.modeButton,
          props.mode === "static" ? styles.modeButtonActive : null,
        ]}
      >
        <Text
          style={[
            styles.modeButtonText,
            props.mode === "static" ? styles.modeButtonTextActive : null,
          ]}
        >
          Static
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => props.onModeChange("live")}
        style={[
          styles.modeButton,
          props.mode === "live" ? styles.modeButtonActive : null,
        ]}
      >
        <Text
          style={[
            styles.modeButtonText,
            props.mode === "live" ? styles.modeButtonTextActive : null,
          ]}
        >
          Live
        </Text>
      </TouchableOpacity>
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
  if (segmentation.error) {
    return "model error";
  }

  if (segmentation.isReady) {
    return "RF-DETR Seg ready";
  }

  return `preloading ${Math.round(segmentation.downloadProgress * 100)}%`;
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

function toRgba(color: number, alpha: number) {
  const red = (color >> 16) & 255;
  const green = (color >> 8) & 255;
  const blue = color & 255;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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

interface LiveSkiaMaskFrameOptions {
  readonly artifactMaxPixels: number;
  readonly artifactMaxSide: number;
  readonly detections: readonly LiveSerializedDetection[];
  readonly edgeSmoothing?: number;
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly mediaRect: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly mosaicCellPx?: number;
  readonly mosaicMaskIds?: readonly number[];
  readonly nativeBuilder: ReactNativeLiveIdMaskNativeBuilderHandle | null;
}

interface LiveSkiaMaskFrame {
  readonly builder: "native" | "js";
  readonly byteLength: number;
  readonly fallbackReason?: string;
  readonly fillMs: number;
  readonly height: number;
  readonly image: SkiaImageType;
  readonly uploadMs: number;
  readonly uniforms: ReactNativeIdMaskUniforms;
  readonly width: number;
}

function createLiveSkiaMaskFrame(
  options: LiveSkiaMaskFrameOptions,
): LiveSkiaMaskFrame | null {
  "worklet";

  let maskPrepStage = "mask-init";

  try {
    maskPrepStage = "mask-build-artifact";
    const build = createReactNativeLiveIdMaskArtifactAuto({
      borderWidth: DEMO_MASK_BORDER_WIDTH,
      detections: options.detections,
      fillOpacity: DEMO_MASK_FILL_OPACITY,
      frameHeight: options.frameHeight,
      frameWidth: options.frameWidth,
      maxPixels: options.artifactMaxPixels,
      maxSide: options.artifactMaxSide,
      nativeBuilder: options.nativeBuilder,
    });

    if (!build) {
      return null;
    }

    const { artifact, diagnostics } = build;
    const uploadStartedAt = Date.now();

    maskPrepStage = "mask-create-skia-data";
    if (!Skia.Data || typeof Skia.Data.fromBytes !== "function") {
      throw {
        message: "Skia.Data.fromBytes is unavailable in the frame worklet",
        name: "TypeError",
      };
    }

    const imageData = Skia.Data.fromBytes(artifact.data);

    maskPrepStage = "mask-create-skia-image";
    if (!Skia.Image || typeof Skia.Image.MakeImage !== "function") {
      throw {
        message: "Skia.Image.MakeImage is unavailable in the frame worklet",
        name: "TypeError",
      };
    }

    const image = Skia.Image.MakeImage(
      {
        alphaType: AlphaType.Opaque,
        colorType: ColorType.Alpha_8,
        height: artifact.height,
        width: artifact.width,
      },
      imageData,
      artifact.width,
    );

    if (!image) {
      return null;
    }

    const uploadMs = Date.now() - uploadStartedAt;

    maskPrepStage = "mask-resolve-uniforms";
    const uniforms = resolveReactNativeLiveIdMaskUniforms({
      artifact,
      edgeSmoothing: options.edgeSmoothing,
      mediaRect: options.mediaRect,
      mosaicCellPx: options.mosaicCellPx,
      mosaicMaskIds: options.mosaicMaskIds,
    });

    return {
      builder: diagnostics.builder,
      byteLength: artifact.data.byteLength,
      fallbackReason: diagnostics.fallbackReason,
      fillMs: diagnostics.fillMs,
      height: artifact.height,
      image,
      uploadMs,
      uniforms,
      width: artifact.width,
    };
  } catch (error) {
    let message = "unknown error";
    let name = "Error";

    if (typeof error === "string") {
      message = error;
    } else if (typeof error === "object" && error !== null) {
      const record = error as {
        readonly message?: unknown;
        readonly name?: unknown;
      };

      if (typeof record.message === "string") {
        message = record.message;
      }

      if (typeof record.name === "string") {
        name = record.name;
      }
    }

    throw {
      message: `${maskPrepStage}: ${message}`,
      name,
    };
  }
}

function createEmptyLiveMaskUniforms(): ReactNativeIdMaskUniforms {
  return {
    uBorderEnabled: 0,
    uEdgeSmoothing: 0,
    uFeatherTexels: 1,
    uFillPalette: createNumberArray(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    uMaxStrokeWidth: 0,
    uMediaRect: [0, 0, 1, 1],
    uMosaicCellPx: 0,
    uMosaicFlags: createNumberArray(MAX_ID_MASK_PALETTE_ENTRIES),
    uOpacity: 0,
    uStrokePalette: createNumberArray(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    uStrokeWidths: createNumberArray(MAX_ID_MASK_PALETTE_ENTRIES),
    uTextureSize: [1, 1],
  };
}

function createNumberArray(length: number) {
  return new Array<number>(length).fill(0);
}

function resolveLiveDetectionFrameSize(frame: {
  readonly height: number;
  readonly orientation: string;
  readonly width: number;
}) {
  "worklet";

  if (frame.orientation === "left" || frame.orientation === "right") {
    return {
      height: frame.width,
      width: frame.height,
    };
  }

  return {
    height: frame.height,
    width: frame.width,
  };
}

function resolveLiveFrameRendererStyle(options: {
  readonly canvasHeight: number;
  readonly canvasWidth: number;
  readonly orientation: string;
}): ViewStyle {
  if (options.orientation === "left" || options.orientation === "right") {
    return {
      height: options.canvasWidth,
      left: (options.canvasWidth - options.canvasHeight) / 2,
      position: "absolute",
      top: (options.canvasHeight - options.canvasWidth) / 2,
      transform: [
        { rotate: options.orientation === "left" ? "90deg" : "-90deg" },
      ],
      width: options.canvasHeight,
    };
  }

  return {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    transform: options.orientation === "down" ? [{ rotate: "180deg" }] : [],
  };
}

function createLiveFrameError(
  stage: string,
  error: unknown,
  frame: {
    readonly hasNativeBuffer: boolean;
    readonly hasPixelBuffer: boolean;
    readonly height: number;
    readonly isPlanar: boolean;
    readonly pixelFormat: string;
    readonly timestamp: number;
    readonly width: number;
  },
): LiveFrameError {
  "worklet";

  const serialized = serializeDebugError(error);

  return {
    code: serialized.code,
    frameHeight: frame.height,
    framePixelFormat: frame.pixelFormat,
    frameTimestamp: frame.timestamp,
    frameWidth: frame.width,
    hasNativeBuffer: frame.hasNativeBuffer,
    hasPixelBuffer: frame.hasPixelBuffer,
    isPlanar: frame.isPlanar,
    message: serialized.message,
    name: serialized.name,
    stage,
  };
}

function createLiveFrameDebugArgs(
  stage: string,
  frame: {
    readonly hasNativeBuffer: boolean;
    readonly hasPixelBuffer: boolean;
    readonly height: number;
    readonly isPlanar: boolean;
    readonly pixelFormat: string;
    readonly timestamp: number;
    readonly width: number;
  },
) {
  "worklet";

  return {
    frameHeight: frame.height,
    framePixelFormat: frame.pixelFormat,
    frameTimestamp: frame.timestamp,
    frameWidth: frame.width,
    hasNativeBuffer: frame.hasNativeBuffer,
    hasPixelBuffer: frame.hasPixelBuffer,
    isPlanar: frame.isPlanar,
    stage,
  };
}

function disposeLiveSkiaImage(image: SkiaImageType | null) {
  "worklet";

  if (image && typeof image.dispose === "function") {
    image.dispose();
  }
}

const styles = StyleSheet.create({
  body: {
    color: "#9aa4b2",
    fontSize: 12,
    fontWeight: "600",
  },
  brand: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  canvasFrame: {
    backgroundColor: "#05070b",
    borderColor: "#1a202b",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  canvasSurface: {
    borderRadius: 14,
    zIndex: 2,
  },
  syncedFrameStage: {
    overflow: "hidden",
    position: "relative",
  },
  card: {
    backgroundColor: "#080b11",
    borderColor: "#1a202b",
    borderRadius: 12,
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
    color: "#9aa4b2",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardValue: {
    color: "#f5f7fb",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 3,
  },
  control: {
    alignItems: "center",
    backgroundColor: "#080b11",
    borderColor: "#1a202b",
    borderRadius: 12,
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
  floatingButton: {
    backgroundColor: "rgba(5, 7, 11, 0.72)",
    borderColor: "rgba(216, 226, 240, 0.18)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  floatingButtonActive: {
    backgroundColor: "rgba(248, 250, 252, 0.94)",
    borderColor: "rgba(248, 250, 252, 0.54)",
  },
  floatingButtonText: {
    color: "#d7dde7",
    fontSize: 11,
    fontWeight: "900",
  },
  floatingButtonTextActive: {
    color: "#050608",
  },
  floatingIconButton: {
    backgroundColor: "rgba(5, 7, 11, 0.72)",
    borderColor: "rgba(216, 226, 240, 0.18)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  frameRendererSurface: {
    overflow: "hidden",
    zIndex: 1,
  },
  header: {
    alignItems: "center",
    backgroundColor: "#080b11",
    borderColor: "#1a202b",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerCopy: {
    gap: 1,
  },
  mark: {
    backgroundColor: "#141923",
    borderColor: "#2b3342",
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
    backgroundColor: "#7ee7f4",
    left: 9,
    top: 8,
  },
  markMint: {
    backgroundColor: "#92f2b3",
    left: 18,
    top: 6,
  },
  markViolet: {
    backgroundColor: "#8d7df3",
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
  liveBrand: {
    alignItems: "center",
    backgroundColor: "rgba(5, 7, 11, 0.66)",
    borderColor: "rgba(216, 226, 240, 0.14)",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  liveDebugPanel: {
    backgroundColor: "rgba(5, 7, 11, 0.68)",
    borderColor: "rgba(216, 226, 240, 0.16)",
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
    backgroundColor: "rgba(14, 19, 29, 0.74)",
    borderColor: "rgba(216, 226, 240, 0.1)",
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 70,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  liveMetricLabel: {
    color: "#8f99ab",
    fontSize: 8,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  liveMetricValue: {
    color: "#dfffe7",
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
    backgroundColor: "rgba(5, 7, 11, 0.74)",
    borderColor: "rgba(216, 226, 240, 0.18)",
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
    backgroundColor: "rgba(5, 7, 11, 0.88)",
    borderColor: "rgba(216, 226, 240, 0.2)",
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
    color: "#9aa4b2",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  detectionMenuAction: {
    alignItems: "center",
    backgroundColor: "rgba(248, 250, 252, 0.94)",
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
    width: "100%",
  },
  detectionMenuActionText: {
    color: "#050608",
    fontSize: 12,
    fontWeight: "900",
  },
  detectionMenuCancel: {
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 6,
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
    backgroundColor: "#070a10",
    borderColor: "#1a202b",
    borderRadius: 11,
    borderWidth: 1,
    flex: 1,
    gap: 3,
    minWidth: 0,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  metricLabel: {
    color: "#788397",
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
    color: "#dfffe7",
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  metricsGrid: {
    flexDirection: "row",
    gap: 8,
  },
  modeButton: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modeButtonActive: {
    backgroundColor: "#f5f7fb",
  },
  modeButtonText: {
    color: "#9aa4b2",
    fontSize: 11,
    fontWeight: "900",
  },
  modeButtonTextActive: {
    color: "#050608",
  },
  modeSwitch: {
    alignItems: "center",
    backgroundColor: "#05070b",
    borderColor: "#1a202b",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 2,
    padding: 3,
  },
  safeArea: {
    backgroundColor: "#050608",
    flex: 1,
  },
  screen: {
    backgroundColor: "#050608",
    flex: 1,
    gap: 10,
    padding: 12,
  },
  subtitle: {
    color: "#9aa4b2",
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
    backgroundColor: "rgba(8, 11, 17, 0.82)",
    borderColor: "#28303e",
    borderRadius: 12,
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
    color: "#d7dde7",
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  overlayTitle: {
    color: "#ffd976",
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
    backgroundColor: "rgba(9, 12, 18, 0.82)",
    borderColor: "#28303e",
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
    color: "#d7dde7",
    fontSize: 10,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  statusPillWarning: {
    borderColor: "#5f5126",
  },
  title: {
    color: "#f5f7fb",
    fontSize: 16,
    fontWeight: "900",
  },
  toggleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
});
