---
title: Annotation Renderers
children:
  - ./annotation-renderers/boxes.md
  - ./annotation-renderers/masks.md
  - ./annotation-renderers/mask-halo.md
  - ./annotation-renderers/labels.md
  - ./annotation-renderers/polygons.md
  - ./annotation-renderers/polylines.md
  - ./annotation-renderers/keypoints-and-skeletons.md
  - ./annotation-renderers/asset-regions.md
---

# Annotation Renderers

An annotation renderer is the public unit that connects semantic detection data
to a presentation style and contributes that visualization to the
renderer-owned scene. Consumers choose the renderers they want; the browser
backend decides how to draw them efficiently.

The responsibilities stay separate:

- **detections** own geometry, identity, class, confidence, and masks;
- **styles** describe how one supported renderer should look;
- **annotation renderers** select the user-visible capabilities enabled through
  `MediaRendererPresentation.renderers`;
- **annotator facades** may later compose renderers into higher-level use
  cases;
- PixiJS containers, shaders, textures, and prepared artifacts remain private
  backend details.

The focused playgrounds below use the frozen basketball fixture, a real
`MediaSession`, and the same style contracts available from the published
`supervision` package. Change a control to update both the scene and its
minimal code snippet. The polyline playground uses the fixture's committed,
motion-gated basketball trajectory rather than inventing geometry at runtime.

- [Boxes](./annotation-renderers/boxes.md)
- [Masks](./annotation-renderers/masks.md)
- [Mask Halo](./annotation-renderers/mask-halo.md)
- [Labels](./annotation-renderers/labels.md)
- [Polygons](./annotation-renderers/polygons.md)
- [Polylines](./annotation-renderers/polylines.md)
- [Keypoints and skeletons](./annotation-renderers/keypoints-and-skeletons.md)
- [Asset regions](./annotation-renderers/asset-regions.md)

## Renderer Configuration

Use `annotationRenderers` to describe a scene through a single renderer list.
The current renderers preserve the established backend ordering for masks,
polygons, vectors, and labels, so adopting the list does not change their
composition behavior.

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.label({ style: labelStyle }),
  ],
});
```

The older top-level `maskStyle`, `boxStyle`, and related fields remain compatible
and continue to support source-specific presentation overrides. New global
presentation code should prefer the renderer list. A renderer with an explicit
style supplies the global style and a matching source override still wins for
that source. When a `renderers` list is present, omitted renderers are disabled,
including when the list is empty. A listed renderer without an explicit
`style` uses its matching compatibility field. Source-specific overrides refine
selected renderers but cannot re-enable an omitted renderer.

Most established renderers are singleton style-backed layers. Asset-region
renderers are intentionally multi-instance: each descriptor has its own `id`,
target, source, anchor, transform, and composition order, so an application can
place independent assets without creating a parallel layer API.
