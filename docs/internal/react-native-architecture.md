# React Native Architecture

This note defines the current direction for a future React Native package. It is
not a public API promise.

## Package Boundary

`packages/react-native` depends on `supervision-js-core`, not on
`packages/web`. The package should reuse semantic detections, timelines,
source-composition contracts, picking contracts, and style resolution from core.

It must not import Pixi, Mediabunny, DOM APIs, IndexedDB, browser workers, or the
browser package entrypoint.

## Rendering Direction

React Native rendering should use native-friendly technology such as Skia or a
native GPU surface. The first proof should accept externally supplied media
frames or native frame handles and resolve core presentation styles into
draw instructions.

The package should remain non-Expo-coupled. Expo may be a consumer environment,
but the library boundary should not require Expo APIs.

## Media Direction

Mediabunny is browser-focused and should stay in `packages/web`. React Native
will need platform media providers for files, camera streams, and native video
frames. Those providers should conform to core media-frame metadata contracts
without making core know about native texture handles or camera APIs.

## Storage Direction

IndexedDB is browser-only. React Native cold storage should eventually use
mobile storage primitives such as filesystem-backed chunks, SQLite, or MMKV-like
stores. Storage policies should mirror core retention policy concepts, but the
storage engine belongs to the React Native package or the host app.

## Inference Boundary

ExecuTorch and other on-device inference engines are detection producers, not
rendering dependencies. A host app may run a model with ExecuTorch and append
detections into the same core-shaped pipeline, but `supervision-js-react-native`
should not depend on ExecuTorch to render detections.

## Current Proof

The current private package only resolves one externally supplied media frame
and one detection frame through core styles. That proves the dependency
direction and style contract. Native video playback, camera integration,
mask GPU preparation, and native picking remain future proofs.
