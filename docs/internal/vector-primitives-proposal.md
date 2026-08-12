# Vector Primitives And Annotation Renderers

Status: current internal architecture guidance

Last reviewed: August 12, 2026

## Purpose

Annotation renderers are the public unit of visualization. Vector primitives
are implementation details that let browser and native backends draw those
semantic renderers without exposing PixiJS or backend resources in the public
API.

This document records the boundary between those concepts. The
[annotator use-case roadmap](annotator-use-case-roadmap.md) remains the
canonical plan for future capabilities, fixtures, and delivery order.

## Public Contract

Consumers configure visible capabilities through
`MediaRendererPresentation.renderers` and the `annotationRenderers` factories:

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.box(),
    annotationRenderers.mask(),
    annotationRenderers.region({
      id: "player-badge",
      target: { className: "person" },
      source: {
        kind: "asset",
        asset: { src: new URL("./badge.png", import.meta.url).href },
      },
      region: { kind: "bounds" },
      compose: { mode: "over", zIndex: 1 },
    }),
  ],
});
```

- A supplied renderer list is authoritative for enabled annotation renderers.
- Renderer `id` is stable presentation identity.
- Singleton renderers such as boxes and masks keep the established scene
  order and use their existing style contracts.
- Direct, multi-instance renderers such as `region` carry semantic
  configuration in their descriptors. They do not need a synthetic singleton
  style field or canonical default.
- List order is not a general z-order API. A renderer that supports ordering
  exposes it explicitly in its semantic contract, as `region.compose.zIndex`
  does.
- Legacy specialized style fields remain compatibility inputs for the
  corresponding listed singleton renderer; they are not a second capability
  system.

## Internal Lowering

Renderer implementations may lower semantic configuration to reusable
renderer-neutral instructions such as:

- ellipses and arcs;
- anchored markers;
- open or closed paths;
- sprites and media regions.

Those instructions belong in `packages/core` only when multiple backends or
renderers need a platform-neutral contract. Pixi graphics, textures, filters,
display objects, loaders, and prepared artifacts remain private to the browser
backend.

Adding a primitive alone does not create a public visualization capability. A
capability becomes public only through a typed `AnnotationRenderer`
descriptor, factory, validation, backend implementation, and package export.

## Delivery Contract

Every public renderer addition must include:

1. a semantic renderer descriptor and `annotationRenderers` factory;
2. registry or direct-renderer wiring that preserves existing renderer paths;
3. focused public documentation and navigation;
4. a committed real fixture and playground when the fixture contains the
   required semantic input;
5. a synchronized minimal `session.setPresentation({ renderers: [...] })`
   example;
6. focused core/backend tests plus package and docs contract updates.

Ship one public renderer capability per PR. A convenience facade may lower to
an existing renderer instead of creating another rendering system.

## Invariants

- Existing box, mask, label, polygon, polyline, and keypoint hot paths remain
  unchanged unless that renderer is the explicit subject of the change.
- A new renderer does not alter detection identity, editing, picking, mask
  preparation, or cache invalidation of existing renderers.
- Visibility, source overrides, loading, ephemeral, and creation state apply
  consistently to every renderer that consumes detections.
- Unsupported backend capabilities fail validation rather than disappearing
  silently.
- Public contracts never expose PixiJS, DOM, worker, decoder, texture, shader,
  or prepared-artifact types.
