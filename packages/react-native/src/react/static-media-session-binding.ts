import type {
  BoxStyle,
  DetectionFrame,
  KeypointStyle,
  LabelStyle,
  MaskStyle,
  MediaFrameMetadata,
  PolygonStyle,
  PolylineStyle,
} from "supervision-js-core";
import {
  createReactNativePreparedFramePacket,
  type ReactNativePreparedFramePacket,
} from "../index";

declare const mediaSessionViewBindingBrand: unique symbol;

/**
 * Opaque renderer binding consumed by `MediaSessionView`.
 *
 * The binding deliberately exposes only semantic readouts. Skia images,
 * shader uniforms, layout objects, and disposal stay inside the React/Skia
 * adapter so application code cannot accidentally split a prepared packet.
 */
export interface ReactNativeMediaSessionViewBinding {
  readonly [mediaSessionViewBindingBrand]: "react-native-media-session-view";
}

/** Sources supported by React Native Skia's `useImage` loader. */
export type ReactNativeStaticMediaImageSource =
  | number
  | string
  | { readonly uri: string; readonly width: number; readonly height: number };

export interface CreateReactNativeStaticMediaSessionBindingOptions {
  readonly boxStyle?: BoxStyle;
  readonly detectionFrame: DetectionFrame;
  readonly imageSource: ReactNativeStaticMediaImageSource;
  readonly keypointStyle?: KeypointStyle;
  readonly labelStyle?: LabelStyle;
  readonly maskStyle?: MaskStyle;
  readonly mediaMetadata: MediaFrameMetadata;
  readonly polygonStyle?: PolygonStyle;
  readonly polylineStyle?: PolylineStyle;
}

export interface ReactNativeMediaSessionViewReadout {
  readonly detectionCount: number;
  readonly keypointCount: number;
  readonly maskCount: number;
  readonly polygonCount: number;
}

interface StaticBindingState {
  readonly detectionFrame: DetectionFrame;
  readonly imageSource: ReactNativeStaticMediaImageSource;
  readonly packet: ReactNativePreparedFramePacket<ReactNativeStaticMediaImageSource>;
  readonly readout: ReactNativeMediaSessionViewReadout;
}

const staticBindingStates = new WeakMap<
  ReactNativeMediaSessionViewBinding,
  StaticBindingState
>();

/**
 * Prepares semantic static-frame input for the package-owned Skia scene.
 * The package retains the resulting prepared packet; callers receive an
 * opaque binding rather than renderer artifacts.
 */
export function createReactNativeStaticMediaSessionBinding(
  options: CreateReactNativeStaticMediaSessionBindingOptions,
): ReactNativeMediaSessionViewBinding {
  const packet = createReactNativePreparedFramePacket({
    boxStyle: options.boxStyle,
    detectionFrame: options.detectionFrame,
    keypointStyle: options.keypointStyle,
    labelStyle: options.labelStyle,
    maskStyle: options.maskStyle,
    mediaFrame: {
      metadata: options.mediaMetadata,
      payload: options.imageSource,
    },
    polygonStyle: options.polygonStyle,
    polylineStyle: options.polylineStyle,
  });
  const binding = {} as ReactNativeMediaSessionViewBinding;

  staticBindingStates.set(binding, {
    detectionFrame: options.detectionFrame,
    imageSource: options.imageSource,
    packet,
    readout: {
      detectionCount: options.detectionFrame.detections.length,
      keypointCount: packet.presentation.keypoints.length,
      maskCount: packet.maskArtifact?.maskCount ?? 0,
      polygonCount: packet.presentation.polygons.length,
    },
  });

  return binding;
}

/** Returns presentation-safe diagnostics for application UI. */
export function getReactNativeMediaSessionViewReadout(
  binding: ReactNativeMediaSessionViewBinding,
): ReactNativeMediaSessionViewReadout {
  return getStaticBindingState(binding).readout;
}

export function getStaticBindingState(
  binding: ReactNativeMediaSessionViewBinding,
): StaticBindingState {
  const state = staticBindingStates.get(binding);

  if (!state) {
    throw new Error(
      "MediaSessionView received a binding that was not created by supervision-js-react-native.",
    );
  }

  return state;
}
