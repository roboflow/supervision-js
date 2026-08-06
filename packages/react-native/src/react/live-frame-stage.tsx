import {
  Canvas,
  Circle,
  FilterMode,
  Image as SkiaImage,
  ImageShader,
  Line,
  MipmapMode,
  Picture,
  Rect,
  RoundedRect,
  Shader,
  Skia,
  Text as SkiaText,
  matchFont,
} from "@shopify/react-native-skia";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type StyleProp, type ViewStyle, View } from "react-native";
import {
  BoxShape,
  type BoxDrawInstruction,
  type LabelDrawInstruction,
} from "supervision-js-core";

import {
  REACT_NATIVE_ID_MASK_SHADER_SOURCE,
  createEmptyReactNativeLiveIdMaskUniforms,
  loadReactNativeLiveIdMaskNativeBuilder,
  resolveReactNativeLabelLayout,
  type ReactNativeFrameLayout,
  type ReactNativeFramePresentation,
} from "../index";
import {
  createEmptyReactNativeSkiaMaskImage,
  createEmptyReactNativeSkiaPicture,
  createReactNativeSkiaMaskFrame,
  createReactNativeSkiaVectorFrame,
  disposeReactNativeSkiaImage,
  disposeReactNativeSkiaPicture,
  swapReactNativeSkiaMaskImage,
  swapReactNativeSkiaPicture,
  type ReactNativeSkiaMaskFrame,
  type ReactNativeSkiaMaskFrameOptions,
  type ReactNativeSkiaSharedValue,
  type ReactNativeSkiaVectorFrame,
  type ReactNativeSkiaVectorFrameOptions,
} from "../skia";
import type { ReactNativeVideoSession } from "../sessions";

/**
 * Allocates a disposable native resource only after React commits. The deferred
 * unmount cleanup lets Strict Mode's immediate effect replay retain it.
 */
function useCommittedSkiaResource<T>(
  create: () => T | null,
  dispose: (resource: T | null) => void,
) {
  const [resource, setResource] = useState<T | null>(null);
  const createRef = useRef(create);
  const disposeRef = useRef(dispose);
  const ownedResource = useRef<T | null>(null);
  const unmountDisposal = useRef<ReturnType<typeof setTimeout> | null>(null);

  createRef.current = create;
  disposeRef.current = dispose;

  useLayoutEffect(() => {
    if (unmountDisposal.current) {
      clearTimeout(unmountDisposal.current);
      unmountDisposal.current = null;
    }

    if (ownedResource.current === null) {
      const next = createRef.current();
      ownedResource.current = next;
      setResource(next);
    }

    return () => {
      const disposal = setTimeout(() => {
        if (unmountDisposal.current !== disposal) {
          return;
        }

        unmountDisposal.current = null;
        disposeRef.current(ownedResource.current);
        ownedResource.current = null;
      }, 0);
      unmountDisposal.current = disposal;
    };
  }, []);

  return resource;
}

export interface ReactNativeLiveStagePoint {
  readonly timestamp: number;
  readonly x: number;
  readonly y: number;
}

export interface ReactNativeLiveStageRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface ReactNativeLiveStageBox {
  readonly fillColor?: string;
  readonly key: string;
  readonly radius: number;
  readonly rect: ReactNativeLiveStageRect;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
}

export interface ReactNativeLiveStageLabel {
  readonly backgroundColor?: string;
  readonly backgroundRect: ReactNativeLiveStageRect;
  readonly baselineY: number;
  readonly cornerRadius: number;
  readonly font: ReturnType<typeof matchFont>;
  readonly key: string;
  readonly text: string;
  readonly textColor: string;
  readonly textX: number;
}

export interface ReactNativeLiveStageOverlays {
  readonly boxes: readonly ReactNativeLiveStageBox[];
  readonly labels: readonly ReactNativeLiveStageLabel[];
}

export interface ReactNativeLiveSkiaPresentation {
  readonly isReady: boolean;
  readonly maskImage: ReactNativeSkiaSharedValue<unknown>;
  readonly maskUniforms: ReactNativeSkiaSharedValue<unknown>;
  readonly vectorPicture: ReactNativeSkiaSharedValue<unknown>;
  clear(): void;
  prepareMask(
    options: ReactNativeSkiaMaskFrameOptions,
  ): ReactNativeSkiaMaskFrame | null;
  prepareVector(
    options: ReactNativeSkiaVectorFrameOptions,
  ): ReactNativeSkiaVectorFrame | null;
  presentMask(frame: ReactNativeSkiaMaskFrame | null): void;
  presentVector(frame: ReactNativeSkiaVectorFrame | null): void;
}

export interface ReactNativeLiveFrameStageProps {
  readonly backgroundColor?: string;
  readonly boxes: readonly ReactNativeLiveStageBox[];
  readonly canvasHeight: number;
  readonly canvasStyle?: StyleProp<ViewStyle>;
  readonly canvasWidth: number;
  readonly children?: ReactNode;
  readonly interactionLayer?: ReactNode;
  readonly labels: readonly ReactNativeLiveStageLabel[];
  readonly layout: ReactNativeFrameLayout;
  readonly maskImage?: unknown;
  readonly maskUniforms?: unknown;
  readonly mediaImage?: unknown;
  readonly mediaLayer?: ReactNode;
  readonly onGestureCancel?: () => void;
  readonly onGestureEnd?: (point: ReactNativeLiveStagePoint) => void;
  readonly onGestureMove?: (point: ReactNativeLiveStagePoint) => void;
  readonly onGestureStart?: (point: ReactNativeLiveStagePoint) => void;
  readonly onPress?: (point: {
    readonly x: number;
    readonly y: number;
  }) => void;
  readonly presentation?: ReactNativeLiveSkiaPresentation;
  readonly showBoxes?: boolean;
  readonly showMasks?: boolean;
  readonly stageStyle?: StyleProp<ViewStyle>;
  readonly vectorPicture?: unknown;
}

/**
 * Owns the reusable Skia composition for synchronized native media. The host
 * contributes semantic overlay instructions and product UI, never a shader or
 * disposable Skia resource.
 */
export function ReactNativeLiveFrameStage(
  props: ReactNativeLiveFrameStageProps,
) {
  const effect = useCommittedSkiaResource(
    () => Skia.RuntimeEffect.Make(REACT_NATIVE_ID_MASK_SHADER_SOURCE),
    (resource) => resource?.dispose(),
  );

  const showMasks = props.showMasks ?? true;
  const showBoxes = props.showBoxes ?? true;
  const hasGestureHandler = props.onGestureStart !== undefined;
  const presentation = props.presentation;
  const maskImage = presentation?.maskImage ?? props.maskImage ?? null;
  const maskUniforms = presentation?.maskUniforms ?? props.maskUniforms ?? null;
  const vectorPicture = presentation?.vectorPicture ?? props.vectorPicture;
  const createGesturePoint = (event: {
    readonly nativeEvent: {
      readonly locationX: number;
      readonly locationY: number;
    };
  }): ReactNativeLiveStagePoint => ({
    timestamp: Date.now(),
    x: event.nativeEvent.locationX,
    y: event.nativeEvent.locationY,
  });

  return (
    <View
      onMoveShouldSetResponder={hasGestureHandler ? () => true : undefined}
      onResponderGrant={
        hasGestureHandler
          ? (event) => props.onGestureStart?.(createGesturePoint(event))
          : undefined
      }
      onResponderMove={
        hasGestureHandler
          ? (event) => props.onGestureMove?.(createGesturePoint(event))
          : undefined
      }
      onResponderRelease={
        hasGestureHandler
          ? (event) => props.onGestureEnd?.(createGesturePoint(event))
          : props.onPress
            ? (event) => {
                props.onPress?.({
                  x: event.nativeEvent.locationX,
                  y: event.nativeEvent.locationY,
                });
              }
            : undefined
      }
      onResponderTerminate={
        hasGestureHandler ? props.onGestureCancel : undefined
      }
      onStartShouldSetResponder={
        hasGestureHandler || props.onPress ? () => true : undefined
      }
      style={[
        { overflow: "hidden", position: "relative" },
        props.stageStyle,
        { height: props.canvasHeight, width: props.canvasWidth },
      ]}
    >
      {props.mediaLayer}
      <Canvas
        style={[
          { borderRadius: 14, zIndex: 2 },
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
            image={props.mediaImage as never}
            width={props.layout.mediaRect.width}
            x={props.layout.mediaRect.x}
            y={props.layout.mediaRect.y}
          />
        ) : null}
        {showMasks && effect && maskImage && maskUniforms ? (
          <Rect
            height={props.layout.mediaRect.height}
            width={props.layout.mediaRect.width}
            x={props.layout.mediaRect.x}
            y={props.layout.mediaRect.y}
          >
            <Shader source={effect} uniforms={maskUniforms as never}>
              <ImageShader
                fit="fill"
                image={maskImage as never}
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
        {vectorPicture ? <Picture picture={vectorPicture as never} /> : null}
        {props.interactionLayer}
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

/** Binds a saved-video session's private presentation lanes to the package stage. */
export function ReactNativeVideoFrameStage(
  props: Omit<
    ReactNativeLiveFrameStageProps,
    "maskImage" | "maskUniforms" | "mediaImage"
  > & {
    readonly session: Pick<
      ReactNativeVideoSession,
      "frameImage" | "maskImage" | "maskUniforms"
    > | null;
  },
) {
  return (
    <ReactNativeLiveFrameStage
      {...props}
      maskImage={props.session?.maskImage}
      maskUniforms={props.session?.maskUniforms}
      mediaImage={props.session?.frameImage}
    />
  );
}

/**
 * Creates the package-owned live Skia resource lanes. `present*` functions are
 * worklet-safe and enforce one-presentation retirement before disposal.
 */
export function useReactNativeLiveSkiaPresentation(): ReactNativeLiveSkiaPresentation {
  // Sentinels are native objects, so create them only after this scene commits.
  const emptyMaskImage = useCommittedSkiaResource(
    () => createEmptyReactNativeSkiaMaskImage(),
    disposeReactNativeSkiaImage,
  );
  const emptyVectorPicture = useCommittedSkiaResource(
    () => createEmptyReactNativeSkiaPicture(),
    disposeReactNativeSkiaPicture,
  );
  const reanimated = loadReanimated();
  const maskImage = reanimated.useSharedValue<unknown>(null);
  const maskImageIsEmpty = reanimated.useSharedValue(true);
  const retiredMaskImage = reanimated.useSharedValue<unknown>(null);
  const maskUniforms = reanimated.useSharedValue<unknown>(
    createEmptyReactNativeLiveIdMaskUniforms(),
  );
  const vectorPicture = reanimated.useSharedValue<unknown>(null);
  const vectorPictureIsEmpty = reanimated.useSharedValue(true);
  const retiredVectorPicture = reanimated.useSharedValue<unknown>(null);
  const emptyMaskUniforms = useMemo(
    () => createEmptyReactNativeLiveIdMaskUniforms(),
    [],
  );
  const nativeMaskBuilder = useMemo(
    () => loadReactNativeLiveIdMaskNativeBuilder(),
    [],
  );
  const prepareMask = useMemo(
    () => (options: ReactNativeSkiaMaskFrameOptions) => {
      "worklet";
      return createReactNativeSkiaMaskFrame({
        ...options,
        nativeBuilder:
          options.nativeBuilder === undefined
            ? nativeMaskBuilder
            : options.nativeBuilder,
      });
    },
    [nativeMaskBuilder],
  );

  const isReady = emptyMaskImage !== null && emptyVectorPicture !== null;

  useLayoutEffect(() => {
    if (!isReady) {
      return;
    }

    maskImage.value = emptyMaskImage;
    maskImageIsEmpty.value = true;
    maskUniforms.value = emptyMaskUniforms;
    vectorPicture.value = emptyVectorPicture;
    vectorPictureIsEmpty.value = true;
  }, [
    emptyMaskImage,
    emptyMaskUniforms,
    emptyVectorPicture,
    isReady,
    maskImage,
    maskImageIsEmpty,
    maskUniforms,
    vectorPicture,
    vectorPictureIsEmpty,
  ]);

  const clear = useMemo(
    () => () => {
      "worklet";
      if (!emptyMaskImage || !emptyVectorPicture) {
        return;
      }

      maskUniforms.value = emptyMaskUniforms;
      swapReactNativeSkiaMaskImage(
        maskImage as never,
        maskImageIsEmpty,
        retiredMaskImage as never,
        null,
        emptyMaskImage,
      );
      swapReactNativeSkiaPicture(
        vectorPicture as never,
        vectorPictureIsEmpty,
        retiredVectorPicture as never,
        null,
        emptyVectorPicture,
      );
    },
    [
      emptyMaskImage,
      emptyMaskUniforms,
      emptyVectorPicture,
      maskImage,
      maskImageIsEmpty,
      maskUniforms,
      retiredMaskImage,
      retiredVectorPicture,
      vectorPicture,
      vectorPictureIsEmpty,
    ],
  );
  const presentMask = useMemo(
    () => (frame: ReactNativeSkiaMaskFrame | null) => {
      "worklet";
      if (!emptyMaskImage) {
        return;
      }

      maskUniforms.value = frame?.uniforms ?? emptyMaskUniforms;
      swapReactNativeSkiaMaskImage(
        maskImage as never,
        maskImageIsEmpty,
        retiredMaskImage as never,
        frame?.image ?? null,
        emptyMaskImage,
      );
    },
    [
      emptyMaskImage,
      emptyMaskUniforms,
      maskImage,
      maskImageIsEmpty,
      maskUniforms,
      retiredMaskImage,
    ],
  );
  const presentVector = useMemo(
    () => (frame: ReactNativeSkiaVectorFrame | null) => {
      "worklet";
      if (!emptyVectorPicture) {
        return;
      }

      swapReactNativeSkiaPicture(
        vectorPicture as never,
        vectorPictureIsEmpty,
        retiredVectorPicture as never,
        frame?.picture ?? null,
        emptyVectorPicture,
      );
    },
    [
      emptyVectorPicture,
      retiredVectorPicture,
      vectorPicture,
      vectorPictureIsEmpty,
    ],
  );

  useEffect(
    () => () => {
      if (!maskImageIsEmpty.value) {
        disposeReactNativeSkiaImage(maskImage.value as never);
      }
      disposeReactNativeSkiaImage(retiredMaskImage.value as never);
      if (!vectorPictureIsEmpty.value) {
        disposeReactNativeSkiaPicture(vectorPicture.value as never);
      }
      disposeReactNativeSkiaPicture(retiredVectorPicture.value as never);
    },
    [
      maskImage,
      maskImageIsEmpty,
      retiredMaskImage,
      retiredVectorPicture,
      vectorPicture,
      vectorPictureIsEmpty,
    ],
  );

  return useMemo(
    () => ({
      clear,
      isReady,
      maskImage,
      maskUniforms,
      prepareMask,
      prepareVector: createReactNativeSkiaVectorFrame,
      presentMask,
      presentVector,
      vectorPicture,
    }),
    [
      clear,
      isReady,
      maskImage,
      maskUniforms,
      prepareMask,
      presentMask,
      presentVector,
      vectorPicture,
    ],
  );
}

/** Converts resolved renderer instructions into Skia-stage overlay geometry. */
export function createReactNativeLiveStageOverlays(options: {
  readonly layout: ReactNativeFrameLayout;
  readonly presentation: Pick<ReactNativeFramePresentation, "boxes" | "labels">;
}): ReactNativeLiveStageOverlays {
  return {
    boxes: createBoxes(options.presentation.boxes, options.layout),
    labels: createLabels(options.presentation.labels, options.layout),
  };
}

export interface ReactNativeNormalizedInteractionPath {
  readonly key: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** Generic package-owned interaction lane for app-defined normalized geometry. */
export function ReactNativeLiveInteractionOverlay(props: {
  readonly marker?: { readonly x: number; readonly y: number } | null;
  readonly mediaRect: ReactNativeLiveStageRect;
  readonly paths?: readonly ReactNativeNormalizedInteractionPath[];
}) {
  const mapPoint = (point: { readonly x: number; readonly y: number }) => ({
    x: props.mediaRect.x + point.x * props.mediaRect.width,
    y: props.mediaRect.y + point.y * props.mediaRect.height,
  });

  return (
    <>
      {props.paths?.flatMap((path) => {
        const points = path.points.map(mapPoint);
        const segmentCount =
          points.length > 2 ? points.length : Math.max(0, points.length - 1);

        return Array.from({ length: segmentCount }, (_, index) => (
          <Line
            color="#ffffff"
            key={`${path.key}-${index}`}
            opacity={0.9}
            p1={points[index]!}
            p2={points[(index + 1) % points.length]!}
            strokeWidth={2}
          />
        ));
      })}
      {props.marker ? (
        <Circle
          color="#ffffff"
          cx={mapPoint(props.marker).x}
          cy={mapPoint(props.marker).y}
          opacity={0.88}
          r={12}
          strokeWidth={3}
          style="stroke"
        />
      ) : null}
    </>
  );
}

function createBoxes(
  boxes: readonly BoxDrawInstruction[],
  layout: ReactNativeFrameLayout,
): ReactNativeLiveStageBox[] {
  return boxes.map((box, index) => ({
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
}

function createLabels(
  labels: readonly LabelDrawInstruction[],
  layout: ReactNativeFrameLayout,
): ReactNativeLiveStageLabel[] {
  return labels.map((label, index) => {
    const fontSize = label.textStyle?.fontSize ?? 13;
    const font = matchFont({ fontSize });
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
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function loadReanimated(): {
  useSharedValue<TValue>(value: TValue): ReactNativeSkiaSharedValue<TValue>;
} {
  if (typeof require !== "function") {
    throw new Error("React Native Reanimated is unavailable in this runtime.");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("react-native-reanimated") as {
    useSharedValue<TValue>(value: TValue): ReactNativeSkiaSharedValue<TValue>;
  };
}
