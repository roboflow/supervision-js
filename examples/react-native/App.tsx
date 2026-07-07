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
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
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
} from "react-native-vision-camera";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  LabelPlacement,
  MaskRenderMode,
  type DetectionPickResult,
} from "supervision-js-core";
import { models, useInstanceSegmentation } from "react-native-executorch";
import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
  type ReactNativeIdMaskUniforms,
  createReactNativeIdMaskFrame,
  pickReactNativeDetectionAtPoint,
  resolveReactNativeIdMaskUniforms,
  resolveReactNativeFrameLayout,
  resolveReactNativeFramePresentation,
  resolveReactNativeLabelLayout,
} from "supervision-js-react-native";

import basketballFrame from "./assets/basketball-frame.jpg";
import {
  basketballDetectionFrame,
  basketballFrameMetadata,
  colorForClass,
} from "./src/basketball-frame";
import {
  runWithWorkletDebugLogging,
  serializeDebugError,
} from "./src/debug-logging";

type DemoMode = "static" | "live";
type LiveSyncMode = "latest" | "synced";
const LIVE_INFERENCE_INTERVAL_MS = Math.round(1000 / 15);
const LIVE_MAX_INSTANCES = 6;
const LIVE_MASK_FILL_OPACITY = 0.5;
const LIVE_MASK_ARTIFACT_MAX_WIDTH = 1280;
const LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION = true;
const LIVE_FRAME_TARGET_RESOLUTION = { height: 1280, width: 720 };
const LIVE_SEGMENTATION_MIRROR_FRAME = false;
const liveSegmentationModel = models.instance_segmentation.rf_detr_nano();

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
  const maskStyle = useMemo(
    () =>
      new BaseMaskStyle({
        color: (detection) => colorForClass(detection.className ?? ""),
        mode: MaskRenderMode.FillAndStroke,
        opacity: 0.55,
        stroke: (detection) => ({
          alpha: 1,
          color: colorForClass(detection.className ?? ""),
          width: detection.className === "basketball" ? 3 : 2,
        }),
      }),
    [],
  );

  const presentation = useMemo(
    () =>
      resolveReactNativeFramePresentation({
        boxStyle: new BaseBoxStyle({
          cornerRadius: rounded ? 12 : 0,
          fill: (detection) => ({
            alpha: detection.className === "basketball" ? 0.36 : 0.12,
            color: colorForClass(detection.className ?? ""),
          }),
          shape: rounded ? BoxShape.RoundedRect : BoxShape.Rect,
          stroke: (detection) => ({
            alpha: 1,
            color: colorForClass(detection.className ?? ""),
            width: detection.className === "basketball" ? 3 : 2,
          }),
        }),
        detectionFrame: basketballDetectionFrame,
        labelStyle: new BaseLabelStyle({
          background: (detection) => ({
            alpha: 0.82,
            color: colorForClass(detection.className ?? ""),
            cornerRadius: 4,
            paddingX: 5,
            paddingY: 2,
          }),
          includeConfidence: true,
          offsetY: 4,
          placement: LabelPlacement.InsideTop,
          textStyle: {
            alpha: 1,
            color: 0xffffff,
            fontSize: 10,
            fontWeight: "800",
          },
        }),
        maskStyle,
        mediaFrame: {
          metadata: {
            duration: 1 / 30,
            ...basketballFrameMetadata,
          },
          payload: basketballFrame,
        },
      }),
    [maskStyle, rounded],
  );

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

  const maskPreparation = useMemo(() => {
    const startedAt = Date.now();
    const artifact = createReactNativeIdMaskFrame({
      detectionFrame: basketballDetectionFrame,
      maskStyle,
    });

    return {
      artifact,
      prepMs: Date.now() - startedAt,
    };
  }, [maskStyle]);
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

  const labelLayouts = useMemo(
    () =>
      presentation.labels.map((label, index) => {
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
          baselineY: labelLayout.textPoint.y - metrics.ascent,
          font,
          index,
          instruction: label,
          layout: labelLayout,
        };
      }),
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

        <View
          onResponderRelease={(event) => {
            const point = {
              x: event.nativeEvent.locationX,
              y: event.nativeEvent.locationY,
            };
            setSelectedPick(
              pickReactNativeDetectionAtPoint(
                basketballDetectionFrame,
                layout,
                point,
                { padding: 8 },
              ),
            );
          }}
          onStartShouldSetResponder={() => true}
          style={[
            styles.canvasFrame,
            { height: canvasHeight, width: canvasWidth },
          ]}
        >
          <Canvas
            style={[
              styles.canvasSurface,
              { height: canvasHeight, width: canvasWidth },
            ]}
          >
            <Rect
              color="#030712"
              height={canvasHeight}
              width={canvasWidth}
              x={0}
              y={0}
            />
            {image ? (
              <SkiaImage
                fit="fill"
                height={layout.mediaRect.height}
                image={image}
                width={layout.mediaRect.width}
                x={layout.mediaRect.x}
                y={layout.mediaRect.y}
              />
            ) : null}
            {maskEffect && maskImage && maskUniforms ? (
              <Rect
                height={layout.mediaRect.height}
                width={layout.mediaRect.width}
                x={layout.mediaRect.x}
                y={layout.mediaRect.y}
              >
                <Shader source={maskEffect} uniforms={maskUniforms}>
                  <ImageShader
                    fit="fill"
                    image={maskImage}
                    rect={layout.mediaRect}
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
            {presentation.boxes.map((box, index) => {
              const rect = layout.mapRect(box.rect);
              const radius =
                box.shape === BoxShape.RoundedRect
                  ? (box.cornerRadius ?? 0)
                  : 0;
              const key = `${box.rect.x}:${box.rect.y}:${index}`;
              const fillColor = box.fill
                ? toRgba(box.fill.color, box.fill.alpha)
                : null;
              const strokeColor = box.stroke
                ? toRgba(box.stroke.color, box.stroke.alpha)
                : null;

              return (
                <Fragment key={key}>
                  {fillColor ? (
                    <RoundedRect
                      color={fillColor}
                      height={rect.height}
                      r={radius * layout.scale}
                      width={rect.width}
                      x={rect.x}
                      y={rect.y}
                    />
                  ) : null}
                  {strokeColor && box.stroke ? (
                    <RoundedRect
                      color={strokeColor}
                      height={rect.height}
                      r={radius * layout.scale}
                      strokeWidth={box.stroke.width}
                      style="stroke"
                      width={rect.width}
                      x={rect.x}
                      y={rect.y}
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {selectedPick?.detection.rect ? (
              <RoundedRect
                color={toRgba(
                  colorForClass(selectedPick.detection.className ?? ""),
                  1,
                )}
                height={layout.mapRect(selectedPick.detection.rect).height}
                r={14 * layout.scale}
                strokeWidth={4}
                style="stroke"
                width={layout.mapRect(selectedPick.detection.rect).width}
                x={layout.mapRect(selectedPick.detection.rect).x}
                y={layout.mapRect(selectedPick.detection.rect).y}
              />
            ) : null}
            {labelLayouts.map((label) => {
              const background = label.instruction.background;
              const textStyle = label.instruction.textStyle;
              const key = `${label.instruction.text}:${label.index}`;

              return (
                <Fragment key={key}>
                  {background ? (
                    <RoundedRect
                      color={toRgba(background.color, background.alpha)}
                      height={label.layout.backgroundRect.height}
                      r={label.layout.cornerRadius}
                      width={label.layout.backgroundRect.width}
                      x={label.layout.backgroundRect.x}
                      y={label.layout.backgroundRect.y}
                    />
                  ) : null}
                  <SkiaText
                    color={toRgba(
                      textStyle?.color ?? 0xffffff,
                      textStyle?.alpha ?? 1,
                    )}
                    font={label.font}
                    text={label.instruction.text}
                    x={label.layout.textPoint.x}
                    y={label.baselineY}
                  />
                </Fragment>
              );
            })}
          </Canvas>
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
        </View>

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

interface LiveSerializedDetection {
  readonly bbox: {
    readonly x1: number;
    readonly x2: number;
    readonly y1: number;
    readonly y2: number;
  };
  readonly label: string;
  readonly mask: Uint8Array;
  readonly maskHeight: number;
  readonly maskWidth: number;
  readonly score: number;
}

interface LiveFrameState {
  readonly droppedFrames: number;
  readonly frameIsMirrored: boolean;
  readonly framePixelFormat: string;
  readonly frameOrientation: string;
  readonly hasPresentedFrame: boolean;
  readonly height: number;
  readonly inferenceTickMs: number;
  readonly maskResolution: string;
  readonly maskCount: number;
  readonly maskPrepMs: number;
  readonly segmentationMs: number;
  readonly serializationMs: number;
  readonly shaderActive: boolean;
  readonly syncMode: LiveSyncMode;
  readonly timestamp: number;
  readonly width: number;
}

interface LiveOverlayDetection {
  readonly bbox: LiveSerializedDetection["bbox"];
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
  const [droppedFrames, setDroppedFrames] = useState(0);
  const [showLiveHud, setShowLiveHud] = useState(true);
  const [showLiveDebug, setShowLiveDebug] = useState(false);
  const [showMaskLayer, setShowMaskLayer] = useState(true);
  const [liveSyncMode, setLiveSyncMode] = useState<LiveSyncMode>("synced");
  const frameRenderer = useFrameRenderer();
  const canvasWidth = window.width;
  const canvasHeight = window.height;
  const strictSyncMode = liveSyncMode === "synced";
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
        orientation: strictSyncMode
          ? (liveFrame?.frameOrientation ?? "left")
          : "up",
        syncMode: liveSyncMode,
      }),
    [
      canvasHeight,
      canvasWidth,
      liveFrame?.frameOrientation,
      liveSyncMode,
      strictSyncMode,
    ],
  );
  const liveMaskImage = useSharedValue<SkiaImageType | null>(null);
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
  const lastInferenceStartedAt = useSharedValue(0);
  const lastPresentedFrame = useSharedValue(false);
  const lastInferenceTickDurationMs = useSharedValue(0);
  const lastMaskCount = useSharedValue(0);
  const lastMaskPrepDurationMs = useSharedValue(0);
  const lastSegmentationDurationMs = useSharedValue(0);
  const lastSerializationDurationMs = useSharedValue(0);
  const lastShaderActive = useSharedValue(false);
  const runSegmentationOnFrame = props.segmentation.runOnFrame;
  const liveLabelOverlays = useMemo(() => {
    const font = matchFont({ fontSize: 13 });
    const metrics = font.getMetrics();
    const textHeight = metrics.descent - metrics.ascent;

    return liveDetections.map((detection, index) => {
      const rect = liveLayout.mapRect({
        height: detection.bbox.y2 - detection.bbox.y1,
        width: detection.bbox.x2 - detection.bbox.x1,
        x: detection.bbox.x1,
        y: detection.bbox.y1,
      });
      const text = `${detection.label || "object"} ${formatConfidence(
        detection.score,
      )}`;
      const bounds = font.measureText(text);
      const backgroundWidth = Math.ceil(bounds.width + 14);
      const backgroundHeight = Math.ceil(textHeight + 7);
      const backgroundX = Math.max(
        6,
        Math.min(canvasWidth - backgroundWidth - 6, rect.x),
      );
      const backgroundY = Math.max(6, rect.y - backgroundHeight - 5);

      return {
        background: {
          height: backgroundHeight,
          width: backgroundWidth,
          x: backgroundX,
          y: backgroundY,
        },
        baselineY: backgroundY + 3 - metrics.ascent,
        detection,
        font,
        index,
        rect,
        text,
        textX: backgroundX + 7,
      };
    });
  }, [canvasWidth, liveDetections, liveLayout]);

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

  const reportLiveFrame = useCallback(
    (frame: Omit<LiveFrameState, "droppedFrames">) => {
      setLiveFrame({
        ...frame,
        droppedFrames,
      });
    },
    [droppedFrames],
  );
  const reportDroppedFrame = useCallback(() => {
    setDroppedFrames((current) => current + 1);
  }, []);
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

  const renderFrameOutput = useFrameOutput({
    allowDeferredStart: false,
    dropFramesWhileBusy: true,
    enablePhysicalBufferRotation: true,
    enablePreviewSizedOutputBuffers: false,
    onFrame(frame) {
      "worklet";

      const stage = "render-frame";

      try {
        runWithWorkletDebugLogging(
          {
            args: createLiveFrameDebugArgs(stage, frame),
            description: "present camera frame through VisionCamera renderer",
            namespace: "rn-live",
          },
          () => {
            frameRenderer.renderFrame(frame);
            lastPresentedFrame.value = true;
          },
        );
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
    onFrameDropped() {
      reportDroppedFrame();
    },
    pixelFormat: "native",
    targetResolution: LIVE_FRAME_TARGET_RESOLUTION,
  });

  const inferenceFrameOutput = useFrameOutput({
    allowDeferredStart: !strictSyncMode,
    dropFramesWhileBusy: true,
    enablePhysicalBufferRotation: false,
    enablePreviewSizedOutputBuffers: false,
    onFrame(frame) {
      "worklet";

      let stage = "start";

      try {
        const syncMode = strictSyncMode ? "synced" : "latest";
        const shouldRunInference =
          runSegmentationOnFrame &&
          Date.now() - lastInferenceStartedAt.value >=
            (strictSyncMode ? 0 : LIVE_INFERENCE_INTERVAL_MS);

        if (shouldRunInference) {
          const inferenceStartedAt = Date.now();

          lastInferenceStartedAt.value = inferenceStartedAt;
          stage = "segmentation-run";
          const segmentationStartedAt = Date.now();
          const rawDetections = runWithWorkletDebugLogging(
            {
              args: createLiveFrameDebugArgs(stage, frame),
              description: "run RF-DETR segmentation on camera frame",
              namespace: "rn-live",
            },
            () =>
              runSegmentationOnFrame(frame, LIVE_SEGMENTATION_MIRROR_FRAME, {
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
                const label =
                  typeof detection.label === "string" ? detection.label : "";

                serialized[index] = {
                  bbox: detection.bbox,
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
              label: detection.label,
              score: detection.score,
            };
          }

          scheduleOnRN(reportLiveDetections, overlayDetections);

          stage = "mask-prepare";
          const maskStartedAt = Date.now();
          let preparedMask: LiveSkiaMaskFrame | null = null;

          try {
            preparedMask = createLiveSkiaMaskFrame({
              debugArgs: {
                detectionCount: detections.length,
                frameHeight: frame.height,
                framePixelFormat: frame.pixelFormat,
                frameTimestamp: frame.timestamp,
                frameWidth: frame.width,
                mediaRectHeight: mediaRect.height,
                mediaRectWidth: mediaRect.width,
                mediaRectX: mediaRect.x,
                mediaRectY: mediaRect.y,
              },
              detections,
              frameHeight: detectionFrameSize.height,
              frameWidth: detectionFrameSize.width,
              mediaRect: {
                height: mediaRect.height,
                width: mediaRect.width,
                x: mediaRect.x,
                y: mediaRect.y,
              },
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

          const maskPrepMs = Date.now() - maskStartedAt;
          const maskCount = rawDetections.length;
          lastInferenceTickDurationMs.value = Date.now() - inferenceStartedAt;
          lastMaskCount.value = maskCount;
          lastMaskPrepDurationMs.value = maskPrepMs;
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

                liveMaskImage.value = preparedMask.image;
                liveMaskUniforms.value = preparedMask.uniforms;
                disposeLiveSkiaImage(previousMaskImage);
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

                liveMaskImage.value = null;
                liveMaskUniforms.value = emptyLiveMaskUniforms;
                disposeLiveSkiaImage(previousMaskImage);
              },
            );
            lastShaderActive.value = false;
          }

          if (strictSyncMode) {
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
        }

        if (Date.now() - lastReadoutReportAt.value > 250) {
          stage = "readout-report";
          lastReadoutReportAt.value = Date.now();
          scheduleOnRN(reportLiveFrame, {
            framePixelFormat: frame.pixelFormat,
            frameOrientation: frame.orientation,
            frameIsMirrored: frame.isMirrored,
            hasPresentedFrame: lastPresentedFrame.value,
            height: resolveLiveDetectionFrameSize(frame).height,
            inferenceTickMs: lastInferenceTickDurationMs.value,
            maskResolution: LIVE_RETURN_MASKS_AT_ORIGINAL_RESOLUTION
              ? "original"
              : "model",
            maskCount: lastMaskCount.value,
            maskPrepMs: lastMaskPrepDurationMs.value,
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
    onFrameDropped() {
      reportDroppedFrame();
    },
    pixelFormat: "rgb",
    targetResolution: LIVE_FRAME_TARGET_RESOLUTION,
  });

  const cameraOutputs = useMemo(
    () =>
      strictSyncMode
        ? [inferenceFrameOutput]
        : [renderFrameOutput, inferenceFrameOutput],
    [inferenceFrameOutput, renderFrameOutput, strictSyncMode],
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
      <View
        style={[styles.liveStage, { height: canvasHeight, width: canvasWidth }]}
      >
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
        <Canvas
          style={[
            styles.canvasSurface,
            StyleSheet.absoluteFill,
            { height: canvasHeight, width: canvasWidth },
          ]}
        >
          {showMaskLayer && liveMaskEffect ? (
            <Rect
              height={liveLayout.mediaRect.height}
              width={liveLayout.mediaRect.width}
              x={liveLayout.mediaRect.x}
              y={liveLayout.mediaRect.y}
            >
              <Shader source={liveMaskEffect} uniforms={liveMaskUniforms}>
                <ImageShader
                  fit="fill"
                  image={liveMaskImage as never}
                  rect={liveLayout.mediaRect}
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
          {liveLabelOverlays.map((label) => (
            <Fragment key={`${label.detection.label}:${label.index}`}>
              <RoundedRect
                color={toRgba(
                  resolveLiveColorForClass(label.detection.label),
                  0.84,
                )}
                height={label.background.height}
                r={5}
                width={label.background.width}
                x={label.background.x}
                y={label.background.y}
              />
              <SkiaText
                color="rgba(255, 255, 255, 0.96)"
                font={label.font}
                text={label.text}
                x={label.textX}
                y={label.baselineY}
              />
            </Fragment>
          ))}
        </Canvas>
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
              <StatusPill
                tone={strictSyncMode ? "ready" : undefined}
                value={strictSyncMode ? "strict sync" : "latest masks"}
              />
              <StatusPill value={`${liveFrame?.maskCount ?? 0} masks`} />
            </View>

            <View style={styles.liveActions}>
              <TouchableOpacity
                onPress={() => setShowMaskLayer((value) => !value)}
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
                onPress={() =>
                  setLiveSyncMode((current) =>
                    current === "synced" ? "latest" : "synced",
                  )
                }
                style={[
                  styles.floatingButton,
                  strictSyncMode ? styles.floatingButtonActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.floatingButtonText,
                    strictSyncMode ? styles.floatingButtonTextActive : null,
                  ]}
                >
                  {strictSyncMode ? "Synced" : "Latest"}
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
                  value={liveFrame ? liveFrame.syncMode : liveSyncMode}
                />
                <LiveMetric
                  label="Seg"
                  value={liveFrame ? `${liveFrame.segmentationMs}ms` : "-"}
                />
                <LiveMetric
                  label="Prep"
                  value={liveFrame ? `${liveFrame.maskPrepMs}ms` : "-"}
                />
                <LiveMetric
                  label="Tick"
                  value={liveFrame ? `${liveFrame.inferenceTickMs}ms` : "-"}
                />
                <LiveMetric label="Dropped" value={String(droppedFrames)} />
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
      </View>
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

interface LiveSkiaMaskFrameOptions {
  readonly debugArgs: {
    readonly detectionCount: number;
    readonly frameHeight: number;
    readonly framePixelFormat: string;
    readonly frameTimestamp: number;
    readonly frameWidth: number;
    readonly mediaRectHeight: number;
    readonly mediaRectWidth: number;
    readonly mediaRectX: number;
    readonly mediaRectY: number;
  };
  readonly detections: readonly LiveSerializedDetection[];
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly mediaRect: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
}

interface LiveSkiaMaskFrame {
  readonly image: SkiaImageType;
  readonly uniforms: ReactNativeIdMaskUniforms;
}

function createLiveSkiaMaskFrame(
  options: LiveSkiaMaskFrameOptions,
): LiveSkiaMaskFrame | null {
  "worklet";

  let maskPrepStage = "mask-init";

  try {
    const maskLimit = MAX_ID_MASK_PALETTE_ENTRIES - 1;
    const detectionCount =
      options.detections.length < maskLimit
        ? options.detections.length
        : maskLimit;
    const frameWidth = Math.max(1, Math.round(options.frameWidth));
    const frameHeight = Math.max(1, Math.round(options.frameHeight));
    const artifactScale =
      frameWidth > LIVE_MASK_ARTIFACT_MAX_WIDTH
        ? LIVE_MASK_ARTIFACT_MAX_WIDTH / frameWidth
        : 1;
    const width = Math.max(1, Math.round(frameWidth * artifactScale));
    const height = Math.max(1, Math.round(frameHeight * artifactScale));

    for (let index = 0; index < detectionCount; index += 1) {
      const detection = options.detections[index]!;

      if (
        detection.mask.length !==
        detection.maskWidth * detection.maskHeight
      ) {
        continue;
      }
    }

    if (width <= 0 || height <= 0) {
      return null;
    }

    maskPrepStage = "mask-allocate-artifact";
    const data = new Uint8Array(width * height);
    const fillPalette: number[] = [];
    const strokePalette: number[] = [];
    const strokeWidths: number[] = [];

    for (let index = 0; index < MAX_ID_MASK_PALETTE_ENTRIES * 4; index += 1) {
      fillPalette[index] = 0;
      strokePalette[index] = 0;
    }

    for (let index = 0; index < MAX_ID_MASK_PALETTE_ENTRIES; index += 1) {
      strokeWidths[index] = 0;
    }

    for (let index = 0; index < detectionCount; index += 1) {
      const detection = options.detections[index]!;

      if (
        detection.mask.length !==
        detection.maskWidth * detection.maskHeight
      ) {
        continue;
      }

      const maskId = index + 1;
      maskPrepStage = "mask-resolve-color";
      const fallbackIndex = index % 10;
      let color = 0x38bdf8;

      if (fallbackIndex === 1) {
        color = 0x22c55e;
      } else if (fallbackIndex === 2) {
        color = 0xa78bfa;
      } else if (fallbackIndex === 3) {
        color = 0xfacc15;
      } else if (fallbackIndex === 4) {
        color = 0xf97316;
      } else if (fallbackIndex === 5) {
        color = 0xf472b6;
      } else if (fallbackIndex === 6) {
        color = 0x60a5fa;
      } else if (fallbackIndex === 7) {
        color = 0xfb7185;
      } else if (fallbackIndex === 8) {
        color = 0x34d399;
      } else if (fallbackIndex === 9) {
        color = 0xe879f9;
      }

      maskPrepStage = "mask-write-palette";
      const paletteOffset = maskId * 4;
      const red = ((color >> 16) & 0xff) / 255;
      const green = ((color >> 8) & 0xff) / 255;
      const blue = (color & 0xff) / 255;

      fillPalette[paletteOffset] = red;
      fillPalette[paletteOffset + 1] = green;
      fillPalette[paletteOffset + 2] = blue;
      fillPalette[paletteOffset + 3] = 1;
      strokePalette[paletteOffset] = red;
      strokePalette[paletteOffset + 1] = green;
      strokePalette[paletteOffset + 2] = blue;
      strokePalette[paletteOffset + 3] = 0.95;
      strokeWidths[maskId] = 2;

      maskPrepStage = "mask-compute-target";
      const targetX0 = Math.max(
        0,
        Math.floor(detection.bbox.x1 * artifactScale),
      );
      const targetY0 = Math.max(
        0,
        Math.floor(detection.bbox.y1 * artifactScale),
      );
      const targetX1 = Math.min(
        width,
        Math.ceil(detection.bbox.x2 * artifactScale),
      );
      const targetY1 = Math.min(
        height,
        Math.ceil(detection.bbox.y2 * artifactScale),
      );
      const targetWidth = targetX1 - targetX0;
      const targetHeight = targetY1 - targetY0;

      if (targetWidth <= 0 || targetHeight <= 0) {
        continue;
      }

      maskPrepStage = "mask-fill-artifact";
      for (let y = 0; y < targetHeight; y += 1) {
        const sourceY = Math.min(
          detection.maskHeight - 1,
          Math.floor((y / targetHeight) * detection.maskHeight),
        );
        const sourceRowOffset = sourceY * detection.maskWidth;
        const targetRowOffset = (targetY0 + y) * width;

        for (let x = 0; x < targetWidth; x += 1) {
          const sourceX = Math.min(
            detection.maskWidth - 1,
            Math.floor((x / targetWidth) * detection.maskWidth),
          );

          if (detection.mask[sourceRowOffset + sourceX]) {
            data[targetRowOffset + targetX0 + x] = maskId;
          }
        }
      }
    }

    maskPrepStage = "mask-create-skia-data";
    if (!Skia.Data || typeof Skia.Data.fromBytes !== "function") {
      throw {
        message: "Skia.Data.fromBytes is unavailable in the frame worklet",
        name: "TypeError",
      };
    }

    const imageData = Skia.Data.fromBytes(data);

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
        height,
        width,
      },
      imageData,
      width,
    );

    if (!image) {
      return null;
    }

    return {
      image,
      uniforms: {
        uBorderEnabled: 1,
        uFillPalette: fillPalette,
        uMaxStrokeWidth: 2,
        uMediaRect: [
          options.mediaRect.x,
          options.mediaRect.y,
          options.mediaRect.width,
          options.mediaRect.height,
        ],
        uOpacity: LIVE_MASK_FILL_OPACITY,
        uStrokePalette: strokePalette,
        uStrokeWidths: strokeWidths,
        uTextureSize: [width, height],
      },
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
    uFillPalette: createNumberArray(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    uMaxStrokeWidth: 0,
    uMediaRect: [0, 0, 1, 1],
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
  readonly syncMode: LiveSyncMode;
}): ViewStyle {
  if (options.syncMode !== "synced") {
    return {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    };
  }

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

function resolveLiveColorForClass(className: string | undefined) {
  const normalizedClassName = (className ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");

  if (normalizedClassName === "horse") {
    return 0x38bdf8;
  }

  if (normalizedClassName === "person" || normalizedClassName === "keyboard") {
    return 0x22c55e;
  }

  if (normalizedClassName === "cow" || normalizedClassName === "tv") {
    return 0xa78bfa;
  }

  if (
    normalizedClassName === "basketball" ||
    normalizedClassName === "bottle" ||
    normalizedClassName === "sports ball"
  ) {
    return 0xf97316;
  }

  if (normalizedClassName === "yellow team player") {
    return 0xfacc15;
  }

  if (normalizedClassName === "white team player") {
    return 0xf8fafc;
  }

  if (normalizedClassName === "cup") {
    return 0xfacc15;
  }

  if (normalizedClassName === "bed") {
    return 0xf472b6;
  }

  if (normalizedClassName === "laptop") {
    return 0x60a5fa;
  }

  if (normalizedClassName === "knife") {
    return 0xfb7185;
  }

  if (
    normalizedClassName === "cell phone" ||
    normalizedClassName === "potted plant"
  ) {
    return 0x34d399;
  }

  let hash = 0;

  for (let index = 0; index < normalizedClassName.length; index += 1) {
    hash = (hash * 31 + normalizedClassName.charCodeAt(index)) >>> 0;
  }

  switch (hash % 10) {
    case 0:
      return 0x38bdf8;
    case 1:
      return 0x22c55e;
    case 2:
      return 0xa78bfa;
    case 3:
      return 0xfacc15;
    case 4:
      return 0xf97316;
    case 5:
      return 0xf472b6;
    case 6:
      return 0x60a5fa;
    case 7:
      return 0xfb7185;
    case 8:
      return 0x34d399;
    default:
      return 0xe879f9;
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
