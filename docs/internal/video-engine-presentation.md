# Video Engine Presentation

Video is push-only. A video media source is engine-backed: the engine owns the
playhead and the decoder, and it announces every frame it has decided is on
screen. The scene composites that frame and draws every annotation layer from
the same moment. The engine holds no canvas and paints nothing, and there is
deliberately no getter for the frame on screen: a second reader of "what is
displayed right now" is a second opinion about the current moment, which is the
desync this design exists to make impossible.

Everything below is current behavior, not a plan. The atomic present rules are
law for future edits.

## The Engine Boundary

Two specifiers resolve, and nothing else: `@roboflow/video-engine` and
`@roboflow/video-engine/analysis`. `no-restricted-imports` in
`eslint.config.js` errors on any other entry, including relative paths into the
engine's checkout, so this repo cannot bind itself to the engine's file layout.

Types and runtime arrive from different places:

- Every typecheck reads the producer's emitted declarations. The producer
  generates them with `npm run types:videoengine` from its `app/` directory,
  and both `packages/web/tsconfig.json` and `demo/tsconfig.json` map the two
  specifiers onto that output. Neither compiles the engine's source, so this
  repo's strictness never lands on another repo's internals.
- What runs resolves to the engine's TypeScript source, through aliases in
  `demo/vite.config.ts` and `vitest.config.ts`.
- Rollup treats both specifiers as external, so the engine is never bundled
  into the published package.

Every one of those mappings points at a checkout of the producer beside this
repository, so the typechecks, the demo and the Vitest suite all need it present
to resolve those specifiers at all.

The engine import inside `packages/web/src/media/video-engine-media-source.ts`
is dynamic for one reason: importing `supervision` must keep working for
consumers who never open an engine source, and the package smoke test imports
the built entry with no engine available.

The adapter exposes the loaded engine as `engine` on the opened source. The
renderer looks for that property, and finding a presented-frame channel there is
what switches the scene from pull to push. One-off reads such as thumbnails and
single frame grabs are answered separately, through the engine's analysis entry
opened lazily on first use, so a consumer that never asks for one never opens a
second decode source. Presentation never travels that seam.

## The Atomic Present

`packages/web/src/renderers/pixi-frame-present.ts` turns one announced frame
into one screen. Its rules are law:

- The media time is derived once, from the event, and is the only time any step
  receives. Every step is typed `(mediaTime: number) => T`.
- No step in the synchronous call graph may read a clock, a playhead getter, or
  a store. The argument is the answer to when it is.
- Nothing awaits between the pixel upload and the last layer, so no other frame
  can be presented in the middle of one.
- One render closes the block, after every layer has drawn.
- The frame is closed exactly once, on the way out, by its only owner.

`assertPresentedTimestamp` is the tripwire, armed in every build including
production. It reads as a tautology against the line above it, and that is the
point: it is the line that breaks the day a refactor hands one step a time of
its own.

The ordering is pinned by name in
`packages/web/src/renderers/pixi-frame-present.test.ts`: "uploads pixels, then
draws, then renders once" holds the sequence, "draws every layer from the
presented timestamp alone" and "reports a step that drew from a time of its own"
hold the single clock, and "closes the frame it was handed, including when a
layer throws" holds ownership.

Adding a layer to the present means adding a step that takes the media time,
reads nothing else, and returns synchronously. Anything that needs to await, or
to know the wall clock, does not belong inside the present.

The pixels ride one GPU texture: the compositor copies the decoder's frame
straight into it, and a decode of another size swaps the texture atomically, so
a refused swap leaves nothing behind. `captureFrame` reads the composited
surface rather than re-decoding. `pixi-media-scene.compositor.test.ts` covers
those cases against a fake device.

## Rendering Only On Change

Under push presentation Pixi's ticker paints nothing. Every render is an
explicit answer to something that changed: a presented frame, the prepared
window advancing, a layer turned on or off, restyling, hover or selection, a
viewport move, a resize, or the swapchain coming back after the tab was hidden.

`scene-render-scheduler.ts` compares a description of everything a render would
put on screen against what was last drawn, so a notification that describes the
current picture costs nothing. It owns no timer, ticker or animation frame:
nobody notifies it, nothing renders. It counts the renders it issues, and
`renderer.getRenderCount()` reports that count under push presentation and
`null` under pull, where the ticker paints every animation frame and no count
would describe it.

The zero-render gate is asserted, not assumed: "holds at zero renders while
paused, untouched, for ten seconds" in
`packages/web/src/renderers/pixi-media-scene.push.test.ts`, and "holds at zero
renders once the window has settled" in
`packages/web/src/renderers/pixi-media-scene.prepared-window.test.ts`.

Paused focus is static by policy. The focus layer's fade advances with the
presented media time, so it fades while the media moves and settles at once when
a hover or selection arrives with no frame behind it. No animation keeps the
scene rendering on its own.

## The Prepared Annotation Window

Readiness is a fact about a frame, not about the session.
`packages/web/src/renderers/prepared-annotation-window.ts` admits a frame only
when its detections are resident and every enabled cook, such as the mask and
polygon layers, reports its artifact prepared for that frame. Inside the window
every enabled layer draws; outside it, they draw nothing, so an uncovered frame
can never keep the previous frame's annotations on screen.

Under push presentation the annotation layers read the window's own timeline
rather than the detection timeline, which is what makes "outside the window" mean
"no frame at all" for every layer at once.

A cook landing never writes into the draw in progress: notifications that arrive
while a present is running are ignored, because a draw or render inside one
present would put a second render in it. A landing for the frame on screen
reaches the screen as a redraw of that frame, raised by the window's own term in
the render description, which is also how detections arriving while paused get
drawn.

The behavior is pinned by name in
`packages/web/src/renderers/pixi-media-scene.prepared-window.test.ts`: "draws no
annotation layers for a frame it does not cover", "never leaves the previous
frame's annotations on an uncovered frame", "renders exactly once when the
window reaches the frame on screen", "redraws when the last-owed cook lands,
whichever layer owns it", and "renders detections that arrive while paused".

`renderer.getPreparedAnnotationWindow()` returns the window's real readiness
snapshot for instruments, and `null` when the scene free-runs on the ticker.

## Transport Delegation

The renderer's playback surface delegates: `MediaRenderer` methods reach
`packages/web/src/renderers/media-renderer-transport.ts`, which speaks to the
`PresentedFrameChannel` the opened source published, which is the engine. The
renderer asks; the producer decides. Seconds meet milliseconds in the transport
and nowhere else.

- A drag is a pair. Every pointer move is a `scrub` inside one gesture the
  producer is told about, and the `commit` that lands the released position ends
  that gesture, so the producer decides whether to resume.
- Stepping walks one real source frame in presentation order, in either
  direction.
- Playback state and playhead time are read from the producer, seeking included.
- Looping is one replay at the announced end: the engine has no loop of its own,
  so the transport calls play once when the producer reports `ENDED` and looping
  is on.
- The producer's playhead also keeps the detection buffer hot, fed on every
  playhead move rather than from anywhere near the present.

`packages/web/src/renderers/media-renderer-core.push.test.ts` holds the shape,
starting with "never pulls a sample", "drives a drag as scrubs inside one
gesture and a seek that releases it", and "replays from the start when the
producer ends and loop is on".

## Where To See It Running

The demo is the integration, not a separate experiment. Fixture videos and
uploaded files both open through `createVideoEngineMediaRendererSource()`, and
the diagnostics panel reads the presented-frame stream through a tap that
records and forwards while holding nothing, plus the renderer's own render count
and prepared-window snapshot.

## The Pull Path That Remains

The pull machinery still exists and still runs. It serves:

- the default `src` path, where a URL or object URL opens through the Mediabunny
  source;
- `normalizeMediaProgressively()` and the rest of media normalization and
  preparation;
- `createMediaStreamRendererSource()` for browser `MediaStream` inputs.

A pull scene keeps Pixi's ticker, has no prepared annotation window, and reports
no render count. Deleting that machinery is a planned, separate decision, so
none of it is precedent: new video work goes through the engine-backed source
and the push path described above.
