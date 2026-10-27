# Oriented rectangle editing example

Run `npm run example:vanilla:dev` from the repository root and open
`http://127.0.0.1:5178/examples/vanilla/oriented-box.html`.

The example uses only the public `supervision` and `supervision/editing`
entrypoints. It creates its own still-image fixture, so no downloads, API keys
or model service are required. A host-owned array and snapshot history receive
one committed detection per edit.

- Draw rectangle creates four ordered corners without an accompanying `rect`.
- Select a rectangle and drag its small external control to rotate it.
- Corner and edge handles resize in the rectangle's local axes.
- Escape cancels the current edit. Undo and Redo operate on completed edits.
- Scroll to zoom. Reset view restores the full image.
- Expand Committed ordered geometry to inspect the saved corners.

General quadrilaterals can render and move but do not receive rectangle
controls. A detection with both an independent `rect` and `orientedBox` retains
its existing axis-aligned rectangle handles. The library assigns no class or
direction semantics to the ordered local axes.

![Selected oriented rectangle after rotation and local-axis resizing](oriented-box-editing.png)

For repeatable mouse, touch, zoom and cancellation checks, start this example
on port 5191 and an isolated Chrome instance with remote debugging on port
9336, then run from the repository root:

```sh
node tools/oriented-box-editing-eval.mjs
```

The script accepts the example URL and Chrome debug URL as optional positional
arguments. It writes browser evidence to the ignored `artifacts/` directory.
