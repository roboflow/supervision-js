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

  const canvasWidth = Math.max(320, window.width - 32);
  const canvasHeight = Math.round(canvasWidth * 0.72);
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
        labelStyle: new BaseLabelStyle({ includeConfidence: true }),
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
          <Text style={styles.title}>supervision-js</Text>
          <Text style={styles.subtitle}>React Native rendering proof</Text>
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
        </View>

        <View style={styles.card}>
          <View>
            <Text style={styles.cardTitle}>Fixture</Text>
            <Text style={styles.cardValue}>9s basketball sample · frame 0</Text>
          </View>
          <View style={styles.metricRow}>
            <Metric
              label="Detections"
              value={String(presentation.boxes.length)}
            />
            <Metric label="Scale" value={`${layout.scale.toFixed(3)}x`} />
            <Metric label="Selected" value={formatSelected(selectedPick)} />
          </View>
        </View>

        <View
          style={[
            styles.card,
            maskShaderStatus === "active"
              ? styles.shaderReady
              : styles.shaderUnavailable,
          ]}
        >
          <View>
            <Text style={styles.cardTitle}>Prepared ID mask</Text>
            <Text style={styles.cardValue}>
              {maskShaderStatus === "active"
                ? "Skia shader active"
                : "Shader unavailable"}
            </Text>
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
          <View>
            <Text style={styles.cardTitle}>Inspect</Text>
            <Text style={styles.cardValue}>
              {selectedPick?.detection.className ?? "Tap a detection"}
            </Text>
          </View>
          <View style={styles.metricRow}>
            <Metric
              label="Confidence"
              value={formatConfidence(selectedPick?.detection.confidence)}
            />
            <Metric label="Target" value={selectedPick?.target ?? "none"} />
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
          </View>
        </View>

        <View style={styles.control}>
          <View>
            <Text style={styles.cardTitle}>Box style</Text>
            <Text style={styles.body}>
              Resolved by core styles, drawn by Skia.
            </Text>
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.body}>Rounded</Text>
            <Switch onValueChange={setRounded} value={rounded} />
          </View>
        </View>
      </View>
    </SafeAreaView>
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
    color: "#9ca3af",
    fontSize: 14,
    fontWeight: "600",
  },
  canvasFrame: {
    borderColor: "#1f2937",
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  canvasSurface: {
    borderRadius: 18,
  },
  card: {
    backgroundColor: "#0b0f17",
    borderColor: "#1f2937",
    borderRadius: 18,
    borderWidth: 1,
    gap: 16,
    padding: 16,
  },
  cardTitle: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardValue: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
    marginTop: 4,
  },
  control: {
    alignItems: "center",
    backgroundColor: "#0b0f17",
    borderColor: "#1f2937",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  header: {
    gap: 4,
  },
  metric: {
    flex: 1,
    gap: 4,
  },
  metricLabel: {
    color: "#6b7280",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  metricRow: {
    flexDirection: "row",
    gap: 12,
  },
  metricValue: {
    color: "#d1fae5",
    fontSize: 16,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  safeArea: {
    backgroundColor: "#030712",
    flex: 1,
  },
  screen: {
    backgroundColor: "#030712",
    flex: 1,
    gap: 16,
    padding: 16,
  },
  subtitle: {
    color: "#94a3b8",
    fontSize: 15,
    fontWeight: "700",
  },
  shaderReady: {
    borderColor: "#14532d",
  },
  shaderUnavailable: {
    borderColor: "#7f1d1d",
  },
  title: {
    color: "#f8fafc",
    fontSize: 28,
    fontWeight: "900",
  },
  toggleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
});
