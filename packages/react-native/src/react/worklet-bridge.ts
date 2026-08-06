/** Schedules a throttled worklet result onto the React Native JS runtime. */
export function scheduleReactNativeOnJs<TValue>(
  callback: (value: TValue) => void,
  value: TValue,
) {
  "worklet";

  // Optional peer: keep Worklets out of the base and application boundaries.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { scheduleOnRN } = require("react-native-worklets") as {
    scheduleOnRN<T>(callback: (next: T) => void, next: T): void;
  };
  scheduleOnRN(callback, value);
}

/** Loads Reanimated only inside the optional React Native presentation boundary. */
export function useReactNativeSharedValue<TValue>(initialValue: TValue): {
  value: TValue;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSharedValue } = require("react-native-reanimated") as {
    useSharedValue<T>(value: T): { value: T };
  };
  return useSharedValue(initialValue);
}
