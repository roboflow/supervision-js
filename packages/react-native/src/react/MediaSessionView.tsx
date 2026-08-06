import {
  AlphaType,
  Canvas,
  ColorType,
  FilterMode,
  Image as SkiaImage,
  ImageShader,
  MipmapMode,
  Picture,
  Rect,
  RoundedRect,
  Shader,
  Skia,
  Text as SkiaText,
  matchFont,
  useImage,
} from "@shopify/react-native-skia";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type StyleProp, type ViewStyle, View } from "react-native";
import {
  BoxShape,
  type DetectionPickOptions,
  type DetectionPickResult,
  type LabelDrawInstruction,
  resolveDetectionClassColorStyle,
} from "supervision-js-core";

import {
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
  pickReactNativeDetectionAtPoint,
  resolveReactNativeFrameLayout,
  resolveReactNativeIdMaskUniforms,
  resolveReactNativeLabelLayout,
} from "../index";
import {
  createReactNativeSkiaVectorFrame,
  disposeReactNativeSkiaImage,
  disposeReactNativeSkiaPicture,
} from "../skia";
import {
  getStaticBindingState,
  type ReactNativeMediaSessionViewBinding,
} from "./static-media-session-binding";
import { resolveReactNativeSkiaLabelFontStyle } from "./label-font";

interface SceneRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface SceneBox {
  readonly fillColor?: string;
  readonly key: string;
  readonly radius: number;
  readonly rect: SceneRect;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
}

interface SceneLabel {
  readonly backgroundColor?: string;
  readonly backgroundRect: SceneRect;
  readonly baselineY: number;
  readonly cornerRadius: number;
  readonly font: ReturnType<typeof matchFont>;
  readonly key: string;
  readonly text: string;
  readonly textColor: string;
  readonly textX: number;
}

function disposeReactNativeSkiaRuntimeEffect(
  effect: ReturnType<typeof Skia.RuntimeEffect.Make> | null,
) {
  effect?.dispose();
}

const UNINITIALIZED_RESOURCE_KEY = Symbol("uninitialized-resource-key");

/**
 * Creates and owns a native drawing resource after React commits.
 *
 * React can discard render-time `useMemo` values in Strict Mode or concurrent
 * rendering, so allocating disposable Skia resources during render leaks them.
 * The owner retains a replaced resource for one presentation and defers final
 * unmount disposal so React Strict Mode's immediate effect replay can cancel it.
 */
function useCommittedSkiaResource<T>(
  key: unknown,
  create: () => T | null,
  dispose: (resource: T | null) => void,
) {
  const [renderedResource, setRenderedResource] = useState<{
    key: unknown;
    resource: T | null;
  }>({ key: UNINITIALIZED_RESOURCE_KEY, resource: null });
  const createRef = useRef(create);
  createRef.current = create;
  const ownership = useRef<{
    current: T | null;
    key: unknown;
    retired: T | null;
  }>({
    current: null,
    key: UNINITIALIZED_RESOURCE_KEY,
    retired: null,
  });
  const unmountDisposal = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (unmountDisposal.current) {
      clearTimeout(unmountDisposal.current);
      unmountDisposal.current = null;
    }

    const currentOwnership = ownership.current;

    if (currentOwnership.key === key) {
      return;
    }

    const next = createRef.current();
    dispose(currentOwnership.retired);
    currentOwnership.retired = currentOwnership.current;
    currentOwnership.current = next;
    currentOwnership.key = key;
    setRenderedResource({ key, resource: next });
  }, [dispose, key]);

  useEffect(
    () => () => {
      const currentOwnership = ownership.current;
      const disposal = setTimeout(() => {
        if (unmountDisposal.current !== disposal) {
          return;
        }

        unmountDisposal.current = null;
        dispose(currentOwnership.current);
        dispose(currentOwnership.retired);
        currentOwnership.current = null;
        currentOwnership.key = UNINITIALIZED_RESOURCE_KEY;
        currentOwnership.retired = null;
      }, 0);
      unmountDisposal.current = disposal;
    },
    [dispose],
  );

  return renderedResource.key === key ? renderedResource.resource : null;
}

export interface MediaSessionViewProps {
  readonly backgroundColor?: string;
  readonly binding: ReactNativeMediaSessionViewBinding;
  readonly children?: ReactNode;
  readonly height: number;
  readonly onPick?: (pick: DetectionPickResult | null) => void;
  readonly pickOptions?: DetectionPickOptions;
  readonly showBoxes?: boolean;
  readonly showKeypoints?: boolean;
  readonly showMasks?: boolean;
  readonly showPolygons?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly width: number;
}

/**
 * Package-owned, renderer-complete static media scene.
 *
 * The view accepts an opaque binding and exposes only semantic picking. Its
 * implementation owns Skia images, shader uniforms, frame layout, vectors,
 * and native resource disposal.
 */
export function MediaSessionView(props: MediaSessionViewProps) {
  const state = getStaticBindingState(props.binding);
  const image = useImage(state.imageSource);
  const [selection, setSelection] = useState<{
    readonly binding: ReactNativeMediaSessionViewBinding;
    readonly pick: DetectionPickResult | null;
  } | null>(null);
  const selectedPick =
    selection?.binding === props.binding ? selection.pick : null;

  useEffect(() => {
    if (selection && selection.binding !== props.binding) {
      setSelection(null);
      props.onPick?.(null);
    }
  }, [props.binding, props.onPick, selection]);

  const presentation = state.packet.presentation;
  const layout = useMemo(
    () =>
      resolveReactNativeFrameLayout({
        canvasHeight: props.height,
        canvasWidth: props.width,
        mediaHeight: presentation.mediaMetadata.height,
        mediaWidth: presentation.mediaMetadata.width,
      }),
    [presentation.mediaMetadata, props.height, props.width],
  );
  const maskImage = useCommittedSkiaResource(
    state.packet.maskArtifact,
    () => {
      const artifact = state.packet.maskArtifact;

      return artifact
        ? Skia.Image.MakeImage(
            {
              alphaType: AlphaType.Opaque,
              colorType: ColorType.Alpha_8,
              height: artifact.height,
              width: artifact.width,
            },
            Skia.Data.fromBytes(artifact.data),
            artifact.width,
          )
        : null;
    },
    disposeReactNativeSkiaImage,
  );
  const maskEffect = useCommittedSkiaResource(
    REACT_NATIVE_ID_MASK_SHADER_SOURCE,
    () => Skia.RuntimeEffect.Make(REACT_NATIVE_ID_MASK_SHADER_SOURCE),
    disposeReactNativeSkiaRuntimeEffect,
  );
  const maskUniforms = useMemo(() => {
    const artifact = state.packet.maskArtifact;

    return artifact
      ? resolveReactNativeIdMaskUniforms({ artifact, layout })
      : null;
  }, [layout, state.packet.maskArtifact]);
  const boxes = useMemo(() => {
    const overlays: SceneBox[] = presentation.boxes.map((box, index) => ({
      fillColor: box.fill ? toRgba(box.fill.color, box.fill.alpha) : undefined,
      key: `${box.rect.x}:${box.rect.y}:${index}`,
      radius:
        (box.shape === BoxShape.RoundedRect ? (box.cornerRadius ?? 0) : 0) *
        layout.scale,
      rect: layout.mapRect(box.rect),
      strokeColor: box.stroke
        ? toRgba(box.stroke.color, box.stroke.alpha)
        : undefined,
      strokeWidth: box.stroke?.width,
    }));

    if (selectedPick?.detection.rect) {
      overlays.push({
        key: "selected",
        radius: 14 * layout.scale,
        rect: layout.mapRect(selectedPick.detection.rect),
        strokeColor: toRgba(
          resolveDetectionClassColorStyle(selectedPick.detection.className)
            .fill,
          1,
        ),
        strokeWidth: 4,
      });
    }

    return overlays;
  }, [layout, presentation.boxes, selectedPick]);
  const labels = useMemo(
    () => createSceneLabels(presentation.labels, layout),
    [layout, presentation.labels],
  );
  const vectorFrameKey = useMemo(
    () =>
      ({
        layout: layout.mediaRect,
        presentation,
        showKeypoints: props.showKeypoints,
        showPolygons: props.showPolygons,
      }) as const,
    [layout.mediaRect, presentation, props.showKeypoints, props.showPolygons],
  );
  const vectorFrame = useCommittedSkiaResource(
    vectorFrameKey,
    () =>
      createReactNativeSkiaVectorFrame({
        frameHeight: presentation.mediaMetadata.height,
        frameWidth: presentation.mediaMetadata.width,
        keypoints: props.showKeypoints === false ? [] : presentation.keypoints,
        mediaRect: layout.mediaRect,
        polygons: props.showPolygons === false ? [] : presentation.polygons,
        polylines: presentation.polylines,
      })?.picture ?? null,
    disposeReactNativeSkiaPicture,
  );

  const selectAt = (point: { readonly x: number; readonly y: number }) => {
    const pick = pickReactNativeDetectionAtPoint(
      state.detectionFrame,
      layout,
      point,
      props.pickOptions,
    );

    setSelection({ binding: props.binding, pick });
    props.onPick?.(pick);
  };

  return (
    <View
      onResponderRelease={(event) =>
        selectAt({
          x: event.nativeEvent.locationX,
          y: event.nativeEvent.locationY,
        })
      }
      onStartShouldSetResponder={() => true}
      style={[props.style, { height: props.height, width: props.width }]}
    >
      <Canvas style={{ height: props.height, width: props.width }}>
        {props.backgroundColor ? (
          <Rect
            color={props.backgroundColor}
            height={props.height}
            width={props.width}
            x={0}
            y={0}
          />
        ) : null}
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
        {props.showMasks !== false &&
        maskEffect &&
        maskImage &&
        maskUniforms ? (
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
        {vectorFrame ? <Picture picture={vectorFrame} /> : null}
        {props.showBoxes !== false
          ? boxes.map((box) => <SceneBox key={box.key} box={box} />)
          : null}
        {labels.map((label) => (
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

function SceneBox(props: { readonly box: SceneBox }) {
  const { box } = props;

  return (
    <Fragment>
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
  );
}

function createSceneLabels(
  labels: readonly LabelDrawInstruction[],
  layout: ReturnType<typeof resolveReactNativeFrameLayout>,
): readonly SceneLabel[] {
  return labels.map((label, index) => {
    const font = matchFont(
      resolveReactNativeSkiaLabelFontStyle(label.textStyle),
    );
    const bounds = font.measureText(label.text);
    const metrics = font.getMetrics();
    const labelLayout = resolveReactNativeLabelLayout({
      instruction: label,
      layout,
      textSize: {
        height: metrics.descent - metrics.ascent,
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

function toRgba(color: number, alpha: number) {
  const red = (color >> 16) & 255;
  const green = (color >> 8) & 255;
  const blue = color & 255;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
