# React Native Example

Experimental Expo app for validating the `supervision-js-react-native` package
on a phone or emulator.

It has four modes:

- Static: renders a bundled basketball frame and detections through the
  package-owned `MediaSessionView` and static session binding.
- Live: uses VisionCamera plus ExecuTorch RF-DETR Nano instance segmentation as
  an example inference producer. The producer prepares one bounded ID-mask
  artifact from model-resolution masks; package-owned live presentation updates
  the Skia state and only presents the same camera frame after the matching
  annotation packet is ready.
- Video: exercises the package-owned iOS saved-video source and compatibility
  session. Playback is analysis-paced, supports pause/resume/stop, and does not
  claim seek support.
- Instant CV: reuses the live strict-sync lane for example-owned Golden Pose,
  Safety Zone, and Privacy recipes without promoting those product rules into
  the package API.

The mask layer follows the same performance principle as the browser package:
compressed RLE masks are prepared once into a single frame-level ID-mask
artifact, uploaded as an `Alpha_8` Skia image, and colored with one runtime
shader pass. The live mode prepares ExecuTorch binary masks directly into the
ID-mask artifact so the hot path does not round-trip through React state. The
live proof is strict-sync only: it does not display a newer camera frame with an
older mask artifact. Saved-video decoding and native mask preparation are
package-owned on iOS; the remaining work is to migrate that compatibility
session onto the generic session core and add an Android saved-video source.

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
test strict-synced camera-frame rendering with RF-DETR Nano instance
segmentation, `Video` to exercise analysis-paced saved-video processing, or
`Instant CV` to exercise the example recipes. The live debug HUD reports
delivered frame size, prepared artifact size, segmentation time, mask
fill/upload time, total tick time, and dropped frames. If the readout says
`Shader unavailable`, the GPU mask proof is not active.

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

- The demo may use Expo, but presentation must use the package `./react`
  entrypoint rather than direct React Native Skia imports or resource factories.
- The demo may use ExecuTorch and VisionCamera as inference/media producers.
- `packages/react-native` must not depend on Expo, Pixi, Mediabunny, DOM APIs,
  browser workers, IndexedDB, ExecuTorch, VisionCamera, or `packages/web`.
- The package owns generic media-session contracts, static/live/video React
  presentation, Skia resource retirement/disposal, the VisionCamera adapter,
  the iOS saved-video source, and reusable preparation worklets. Hosts still
  own inference, product rules, persistence, and product UI.
