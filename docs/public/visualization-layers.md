---
title: Visualization Layers
children:
  - ./visualization-layers/boxes.md
  - ./visualization-layers/masks.md
  - ./visualization-layers/labels.md
  - ./visualization-layers/polygons.md
  - ./visualization-layers/polylines.md
  - ./visualization-layers/keypoints-and-skeletons.md
---

# Visualization Layers

A visualization layer is the public unit that connects semantic detection data
to a presentation style. Consumers choose the layers they want; the browser
renderer decides how to draw them efficiently.

This name is intentional:

- **detections** own geometry, identity, class, confidence, and masks;
- **styles** describe how one supported layer should look;
- **annotation renderers** are the user-visible capabilities enabled through
  `MediaRendererPresentation.renderers`;
- **annotator facades** may later compose these layers into higher-level use
  cases;
- PixiJS containers, shaders, textures, and prepared artifacts remain private
  renderer details.

The focused playgrounds below use the frozen basketball fixture, a real
`MediaSession`, and the same style contracts available from the published
`supervision` package. Change a control to update both the scene and its
minimal code snippet. Polylines remain documented without a playground until a
frozen fixture contains semantic open-path data.

- [Boxes](./visualization-layers/boxes.md)
- [Masks](./visualization-layers/masks.md)
- [Labels](./visualization-layers/labels.md)
- [Polygons](./visualization-layers/polygons.md)
- [Polylines](./visualization-layers/polylines.md)
- [Keypoints and skeletons](./visualization-layers/keypoints-and-skeletons.md)

## Renderer Configuration

Use `annotationRenderers` to describe a scene through a single renderer list. The
current renderers preserve the established backend ordering for masks,
polygons, vectors, and labels, so adopting the list does not change the
composition behavior of existing layers.

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.label({ style: labelStyle }),
  ],
});
```

The older `maskStyle`, `boxStyle`, and related fields remain compatible. They
are especially useful for source-specific presentation overrides; a renderer
with an explicit style supplies the global style and a matching source override
still wins for that source. When a `renderers` list is present, it selects the
enabled built-ins: omitted layers are disabled, including when the list is
empty. A listed renderer without an explicit `style` uses its matching legacy
style field. Source-specific overrides refine selected layers but cannot
re-enable an omitted renderer.
