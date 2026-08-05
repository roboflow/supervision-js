# Problem Framing

`supervision-js` is the browser and TypeScript-first subset of Roboflow's
Python `supervision` ecosystem. It does not recreate the full Python library in
JavaScript. Its job is to provide the browser-native rendering foundation needed
for serious computer vision media workloads.

## The Real Problem

Computer vision applications need to render rich annotations over images, video,
livestreams, and eventually 3D scenes. The hard part is not drawing one box on a
canvas. The hard part is rendering dense, synchronized visual state while media
is changing frame by frame.

The library should eventually support workloads such as:

- many bounding boxes, labels, and track ids;
- masks, polygons, keypoints, and temporal trails;
- dense overlays that update with video or stream timing;
- interactive inspection and editing layers;
- performance-sensitive demos and production workflows.

This is a rendering and synchronization problem before it is an annotation model
problem. If the renderer cannot own the visual composition and update loop, the
annotation API will be built on a weak foundation.

## Target Use Cases

The first credible uses should be small but real:

- browser demos for computer vision models and datasets;
- research and prototyping workflows that need fast visual iteration;
- internal Roboflow tools that need richer annotation rendering than a DOM
  overlay can provide;
- future open-source workflows where users need a reliable, framework-agnostic
  rendering library.

The project should feel production-minded from the beginning: careful
boundaries, measured performance, and plain JavaScript usability alongside
TypeScript-first authoring.

## Non-Goals For The First Phase

The first phase should not design the whole product surface. In particular:

- do not build a complete annotation framework up front;
- do not introduce a large primitive hierarchy before renderer constraints are
  known;
- do not make React part of the core rendering engine;
- do not route the rendering hot path through React state;
- do not visually compose media as a DOM element underneath a separate
  annotation renderer;
- do not promise full Python Supervision API parity;
- do not make experimental React Native work part of the browser package
  compatibility promise.

The safe first bet is to prove the rendering engine, then let the annotation
model emerge from measured needs.
