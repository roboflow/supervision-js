# React Native Example

Experimental Expo app for validating the `supervision-js-react-native` package
on a phone or emulator.

This is intentionally a static-frame proof. It renders a bundled basketball
frame and detections through React Native Skia using draw instructions resolved
from `supervision-js-core` styles. Native video playback, camera frames, mask
preparation, and mobile picking are future proofs.

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

The demo should show a basketball frame, class-colored detection boxes, and a
small toggle that updates the resolved box style live.

## Boundaries

- The demo may use Expo and React Native Skia.
- `packages/react-native` must not depend on Expo, Pixi, Mediabunny, DOM APIs,
  browser workers, IndexedDB, or `packages/web`.
- Media frames are externally supplied. The package only resolves core semantic
  detections/styles into mobile-friendly drawing data.
