---
title: Migrating to 0.3
group: Guides
summary: Update exhaustive editing consumers for oriented rectangle geometry and rotation.
---

# Migrating to 0.3

Version `0.3.0` adds oriented rectangle editing and expands three public editing
enums. This is a source compatibility break for exhaustive consumers of those
enums, even when the application never enables oriented box editing. The new
minor version marks that break in the experimental `0.x` line.

```sh
npm install supervision@0.3.0
```

## Update exhaustive editing consumers

The enums are available from `supervision/editing`:

| Enum                         | New member    | Value           |
| ---------------------------- | ------------- | --------------- |
| `AnnotationGestureStateKind` | `Rotating`    | `"rotating"`    |
| `AnnotationGeometryKind`     | `OrientedBox` | `"orientedBox"` |
| `AnnotationHandleKind`       | `Rotate`      | `"rotate"`      |

Add the new members to exhaustive `Record` mappings, switches with `never`
checks, and any application logic that assumes the previous set of values.
For example, a `Record<AnnotationGestureStateKind, InteractionState>` now needs
an explicit `Rotating` entry. Give rotation its own application state when the
application distinguishes gestures; do not silently label it as resizing.
Review gesture-dependent UI, cancellation, undo/redo, geometry dispatch, and
handle dispatch alongside those mappings.

Deploy the consumer changes with its dependency upgrade. Applications pinned to
an exact previous version keep that version until they explicitly upgrade;
applications using a compatible `0.2.x` range must opt into `0.3.0`.

## Existing engine implementations

The new `getHandles` and `setModifiers` methods remain optional on
`AnnotationEditingEngine` and `BuiltInAnnotationEditingEngine`, so existing
structurally typed engine implementations and test doubles need not add them.
`createAnnotationEditingEngine()` returns a
`ConfiguredAnnotationEditingEngine` that guarantees both capabilities. The new
rotation-handle and rotation-resolution options are optional too. These optional
additions do not remove the exhaustive-enum migration above.

See [Oriented Boxes](../annotation-renderers/oriented-box.md#edit-oriented-rectangles)
for creation tools, configured handles, and rotation constraints. If upgrading
from `0.1.7`, also apply [Migrating to 0.2](migrating-to-0.2.md).
