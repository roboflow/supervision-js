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
