# React Native Example

Experimental Expo app for validating the `supervision-js-react-native` package
on a phone or emulator.

It has two modes:

- Static: renders a bundled basketball frame and detections through React Native
  Skia using draw instructions resolved from `supervision-js-core` styles.
- Live: uses VisionCamera plus ExecuTorch RF-DETR Nano instance segmentation as
  an example inference producer. The frame worklet imports the camera frame as a
  Skia image, prepares one ID-mask artifact, and renders media plus masks in the
  same Skia canvas.

The mask layer follows the same performance principle as the browser package:
compressed RLE masks are prepared once into a single frame-level ID-mask
artifact, uploaded as an `Alpha_8` Skia image, and colored with one runtime
shader pass. The live mode prepares ExecuTorch binary masks directly into the
ID-mask artifact so the hot path does not round-trip through React state. Native
video playback, hot prepared windows, and worker/native-thread preparation are
future proofs.

## Run

From the repository root:

```sh
npm run example:react-native:dev-client
```

This starts Metro for an Expo development build in offline LAN mode. Offline
mode is intentional: it avoids Expo account GraphQL calls, which are not needed
for local development and can fail before Metro serves the app. The example uses
native dependencies that are not available in Expo Go.

If the development build is already installed, prefer launching directly into
the app URL:

```sh
npm run example:react-native:dev-client:ios
```

or:

```sh
npm run example:react-native:dev-client:android
```

If the phone cannot reach the LAN dev server, use the tunnel command. This path
requires Expo's online tunnel service and may fail independently of the app:

```sh
npm run example:react-native:dev-client:tunnel
```

To create the development build first:

```sh
npm run example:react-native:ios -- --device
```

or:

```sh
npm run example:react-native:android
```

The demo should show a basketball frame, class-colored masks/boxes, labels, a
selection outline, and a compact prepared-ID-mask readout. Switch to `Live` to
test camera-frame rendering with RF-DETR Nano instance segmentation. If the
readout says `Shader unavailable`, the GPU mask proof is not active.

The live camera proof uses native dependencies and camera permissions. After
changing native dependencies, Babel plugins, or `app.json`, rebuild the
development client:

```sh
npm run example:react-native:ios -- --device
```

Then start Metro for the installed development client:

```sh
npm run example:react-native:dev-client:ios
```

## Boundaries

- The demo may use Expo and React Native Skia.
- The demo may use ExecuTorch and VisionCamera as inference/media producers.
- `packages/react-native` must not depend on Expo, Pixi, Mediabunny, DOM APIs,
  browser workers, IndexedDB, ExecuTorch, VisionCamera, or `packages/web`.
- Media frames are externally supplied. The package only resolves core semantic
  detections/styles into mobile-friendly drawing data.
