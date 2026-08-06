import { scheduleOnRN } from "react-native-worklets";

/** Schedules a throttled worklet result onto the React Native JS runtime. */
export function scheduleReactNativeOnJs<TValue>(
  callback: (value: TValue) => void,
  value: TValue,
) {
  "worklet";

  scheduleOnRN(callback, value);
}
