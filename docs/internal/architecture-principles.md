# Architecture Principles

`supervision-js` should be designed renderer-first. The core architecture should
make it possible to render computer vision media and overlays with predictable
timing, high throughput, and future backend flexibility.

## Renderer Owns Composition

The renderer should own the full visual composition:

- media texture;
- annotation layers;
- interaction layers;
- debug and instrumentation layers;
- optional UI affordances that need to be synchronized with the scene.

This avoids the fragile split where a DOM `<video>` element plays underneath a
separate canvas overlay. Browser media APIs such as
`requestVideoFrameCallback()` are useful clocks, but they should not force media
and annotations into separate render systems.

## Media Ownership Means Visual Ownership

The renderer may still use browser-capable media infrastructure as decode and
playback sources. For Milestone 1, that source is Mediabunny reading and decoding
video frames for upload into Pixi. A future proof may revisit browser media
primitives directly, but a visible DOM media element should not become the
composition surface.

The architectural constraint is visual composition: users should see one
renderer-owned scene, not a visible DOM video element with an independently
positioned annotation canvas above it. Keeping the media source internal allows
the renderer to coordinate sizing, timing, layers, and debugging in one place.

This does not eliminate media timing as a design problem. Even in one
renderer-owned scene, video decode and playback advance on a media clock while
the renderer presents frames on a render loop. Annotation state should be chosen
from media frame timing, not from an unrelated application timer.

## Framework-Agnostic Core

The core engine must be usable from vanilla browser code and plain JavaScript.
TypeScript should provide first-class types, but the runtime model should not
depend on TypeScript-only concepts.

React can be introduced later as a wrapper, demo app, or integration package.
It should not own rendering state, frame timing, or annotation updates in the
core engine. The hot path should stay outside React.

## First 2D Backend: PixiJS v8

PixiJS v8 is the strongest first candidate for the 2D renderer proof:

- it is mature in the JavaScript ecosystem;
- it has a practical WebGL production path;
- it supports GPU-accelerated sprites, graphics, and textures;
- it gives the project a realistic way to render media and dense 2D overlays
  quickly.

Pixi WebGL should be treated as the production default for the first proof.
Pixi WebGPU can be explored as experimental or opt-in when browser and Pixi
support are stable enough to justify it.

## Keep Pixi Behind A Boundary

Pixi is the first backend, not the public architecture. Public concepts should
not require users to understand Pixi display objects, containers, graphics, or
texture types.

The early implementation can use Pixi directly where needed, but documentation
and module boundaries should preserve the option to add another backend later.
This matters because the long-term 3D path is unlikely to be Pixi.

## Future 3D Flexibility

Future 3D annotation scenarios should be treated as a separate renderer family,
likely based on Three.js or Babylon.js. The 2D proof should not attempt to solve
3D, but it should avoid choices that make 3D impossible.

The shared model should emerge around concepts that can survive multiple
renderers:

- scene timing;
- media frame identity;
- coordinate spaces;
- layer ordering;
- interaction intent;
- annotation data independent from renderer-specific draw objects.

These concepts should be introduced only when they become necessary. The project
should prefer small boundaries validated by working renderer milestones over a
large abstract model designed in advance.
