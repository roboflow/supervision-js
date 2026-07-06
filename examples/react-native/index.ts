import { registerRootComponent } from "expo";
import { initExecutorch } from "react-native-executorch";
import { ExpoResourceFetcher } from "react-native-executorch-expo-resource-fetcher";

import App from "./App";

initExecutorch({
  resourceFetcher: ExpoResourceFetcher,
});

registerRootComponent(App);
