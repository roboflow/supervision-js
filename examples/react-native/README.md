# React Native Example

Experimental Expo app for validating the `supervision-js-react-native` package
on a phone or emulator.

This is intentionally a static-frame proof. It renders a bundled basketball
frame and detections through React Native Skia using draw instructions resolved
from `supervision-js-core` styles.

The mask layer follows the same performance principle as the browser package:
compressed RLE masks are prepared once into a single frame-level ID-mask
artifact, uploaded as an `Alpha_8` Skia image, and colored with one runtime
shader pass. Native video playback, camera frames, hot prepared windows, and
worker/native-thread preparation are future proofs.

## Run

From the repository root:

```sh
npm run dev:client
```

This starts Metro for an Expo development build. The example uses the Expo
preview SDK plus React Native Skia, so Expo Go may not have a new enough native
runtime.

If the development build is already installed, prefer launching directly into
the app URL:

```sh
npm run dev:client:ios
```

or:

```sh
npm run dev:client:android
```

To create the development build first:

```sh
npm run ios:build
```

or:

```sh
npm run android:build
```

The demo should show a basketball frame, class-colored masks/boxes, labels, a
selection outline, and a compact prepared-ID-mask readout. If the readout says
`Shader unavailable`, the GPU mask proof is not active.

## Boundaries

- The demo may use Expo and React Native Skia.
- `packages/react-native` must not depend on Expo, Pixi, Mediabunny, DOM APIs,
  browser workers, IndexedDB, or `packages/web`.
- Media frames are externally supplied. The package only resolves core semantic
  detections/styles into mobile-friendly drawing data.
