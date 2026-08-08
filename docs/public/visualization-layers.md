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
- **visualization layers** are the user-visible capabilities enabled through
  `MediaRendererPresentation`;
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
