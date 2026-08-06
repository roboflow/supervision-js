import type { SkImage } from "@shopify/react-native-skia";

import type { ReactNativeIdMaskUniforms } from "../index";

/**
 * Renderer-private saved-video lanes. They deliberately do not appear in the
 * public MediaSession-shaped API: only package React components may bind them
 * to Skia.
 */
export interface ReactNativeVideoSessionPresentationLanes {
  readonly frameImage: { readonly value: SkImage | null };
  readonly maskImage: { readonly value: SkImage | null };
  readonly maskUniforms: { readonly value: ReactNativeIdMaskUniforms };
}

const presentationLanes = new WeakMap<
  object,
  ReactNativeVideoSessionPresentationLanes
>();

export function bindReactNativeVideoSessionPresentation(
  session: object,
  lanes: ReactNativeVideoSessionPresentationLanes,
) {
  presentationLanes.set(session, lanes);
}

export function getReactNativeVideoSessionPresentation(session: object | null) {
  return session ? (presentationLanes.get(session) ?? null) : null;
}
