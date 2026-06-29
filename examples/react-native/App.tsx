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
  useImage,
} from "@shopify/react-native-skia";
import { StatusBar } from "expo-status-bar";
import { Fragment, useMemo, useState } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  LabelPlacement,
  MaskRenderMode,
  type DetectionPickResult,
} from "supervision-js-core";
import {
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
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

export default function App() {
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
          <StatusPill
            tone={maskShaderStatus === "active" ? "ready" : "warning"}
            value={maskShaderStatus === "active" ? "Skia shader" : "No shader"}
          />
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

function Metric(props: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{props.label}</Text>
      <Text style={styles.metricValue}>{props.value}</Text>
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
