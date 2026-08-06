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
