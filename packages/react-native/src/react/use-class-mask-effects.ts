import { useEffect, useMemo } from "react";

import {
  createReactNativeClassMaskEffectsResolver,
  type ReactNativeClassMaskEffects,
} from "../sessions";
import { useReactNativeSharedValue } from "./worklet-bridge";

/** Mirrors infrequent class-effect UI state into the package-owned worklet lane. */
export function useReactNativeClassMaskEffects(
  effects: ReactNativeClassMaskEffects,
) {
  const sharedEffects = useReactNativeSharedValue(effects);

  useEffect(() => {
    sharedEffects.value = effects;
  }, [effects, sharedEffects]);

  return useMemo(
    () => createReactNativeClassMaskEffectsResolver(sharedEffects),
    [sharedEffects],
  );
}
