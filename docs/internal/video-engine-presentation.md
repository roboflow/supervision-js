# Web Video Engine Presentation

An engine-backed video media source presents by pushing. The engine owns the
playhead and the decoder, and it announces every frame it has decided is on
screen. The scene composites that frame and draws every annotation layer from
the same moment. The engine holds no canvas and paints nothing, and there is
deliberately no getter for the frame on screen: a second reader of "what is
displayed right now" is a second opinion about the current moment, which is the
desync this design exists to make impossible.

Everything below is current behavior, not a plan. The atomic present rules are
law for future edits.

## The Engine Boundary

The engine is the private `packages/video-engine` workspace, published inside
`supervision` under the `web-video-engine` subpath. Two specifiers carry code,
and nothing else: `supervision/web-video-engine` and
`supervision/web-video-engine/analysis`, the second being the only one that
pulls Mediabunny. A third export, `supervision/web-video-engine/worker`, is the
built worker as a deployment asset for hosts whose CSP forbids `blob:` workers.

`supervision/web-video-engine` is a barrel, `packages/web/src/web-video-engine`.
It re-exports the engine, and beside it the adapter that opens one:
`createWebVideoEngineMediaRendererSource` and `openWebVideoEngineMediaSource` are
importable from the subpath and from `supervision` itself, and are the same
functions either way. `#web-video-engine` is the browser package's own alias for
the staged engine build; only the barrel and the media seam may name it. `no-restricted-imports` in
`eslint.config.js` errors on any other entry, and on relative paths into
`packages/video-engine/src`, so importers cannot bind themselves to the engine's
file layout.

Types and runtime arrive from different places:

- Every typecheck reads the engine's emitted declarations. `packages/web`
  resolves `#web-video-engine` through `paths`, and `npm run typecheck` builds
  the engine before it reaches `supervision` and the demo, so those declarations
  are present.
- Vitest resolves both specifiers to the engine's TypeScript source, through
  aliases in `vitest.config.ts`, the same way it resolves `supervision` and
  `supervision-js-core`.
- Rollup treats the alias as external and rewrites it to a path relative to
  each chunk. The engine's own build output is staged into
  `packages/web/dist/web-video-engine`, its root entry renamed `engine` so the
  barrel can take `index`, so what the alias names ships beside the entry that
  reaches for it rather than inside it.
- The barrel is built as its own Rollup configuration. Given the engine and the
  entry that lazily loads it in one graph, Rollup hoists the engine into a
  static import of the main entry, which is the one thing this whole
  arrangement exists to prevent.

The engine import inside `packages/web/src/media/video-engine-media-source.ts`
is dynamic for one reason: the engine embeds a 1.5 MB decode worker, and a
consumer who only annotates images must not download it. A static import would
fold the engine into the main entry chunk; the dynamic one splits it out, and
tree-shaking drops it entirely when nothing opens an engine source.

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

`drawFramePresentLayers` is where that sequence is declared. A redraw at a
resting playhead walks the same declaration, so the two cannot drift.

Adding a layer to the present means adding a step that takes the media time,
reads nothing else, and returns synchronously. Anything that needs to await, or
to know the wall clock, does not belong inside the present.

The pixels ride one GPU texture: the compositor copies the decoder's frame
straight into it, and a decode of another size swaps the texture atomically, so
a refused swap leaves nothing behind. `captureFrame` reads the composited
surface rather than re-decoding. `pixi-media-scene.compositor.test.ts` covers
those cases against a fake device.

Not every browser converts a decoded frame into a copy source. Firefox's queue
takes only ImageBitmap, HTMLImageElement, HTMLCanvasElement and OffscreenCanvas,
and refuses a VideoFrame with a TypeError raised inside the present, which
abandons the steps after the upload and leaves the annotation layers drawing
over a picture that never arrived. `acceptsVideoFrameUpload` asks the device
once, when the compositor is built, and a device that refuses sends its frames
through the same staging canvas every non-WebGPU scene already uses. The answer
is a property of the browser, so nothing is probed per frame and a browser that
takes the frame keeps the straight copy.

A refusing device is the narrow case; the wide one is a browser with no WebGPU
to refuse. `navigator.gpu` is undefined in Safari 18.6, in the page and in a
worker, so Pixi builds its WebGL renderer, `createSceneMediaCompositor` finds no
device, and every present runs `uploadFrameToStagingCanvas`: one 2D draw of the
decoded frame into the staging canvas, then one upload of that whole canvas into
the sprite's texture. Both steps land inside the present: Pixi's GL texture
system uploads from the `update()` call rather than at render time, so this cost
follows presented frames rather than the renders `renderPresent` coalesces.

The upload is what Safari costs: on the demo's default clip it runs once per
presented frame at 24.8 ms, and about seven tenths of the wall clock goes into
it during playback. It is not the pixels. The same frames uploaded straight from
the decoded VideoFrame into a WebGL texture, in the same browser, take 0.6 ms
each, measured with a forced readback after every upload so neither figure can
be work WebKit deferred, and the pixel that comes back is the staging route's
colour rather than the black a bad upload gives. Part of that gap is per-pixel
and part of it is that the staging surface is media-sized whatever the decode
delivers, so a decode below media size is drawn back up before it is uploaded.
It is sized that way because `captureFrame` reads it, and a capture is
media-sized on both paths. Anything that stops writing that canvas therefore
owns the captured pixels, the decode sizes the sprite has to keep ignoring, and
a per-browser answer to whether this WebGL context takes a VideoFrame at all,
which is the question `acceptsVideoFrameUpload` already asks the GPU queue.

That settles the upload and nothing else. A source only reaches the compositor
once WebCodecs has decoded it, and `openInput` refuses a track whose codec
`canDecode` rejects. A browser's WebCodecs support can be narrower than its media
element's: Firefox 154 plays HEVC in a `<video>` while `VideoDecoder` reports
`hvc1` and `hev1` configurations unsupported, so an HEVC source raises
`DecodeUnsupported` before a frame is ever presented. The demo's own `horse_trail`
fixture is HEVC Main 10, which is why it errors in Firefox while the H.264
basketball fixtures play. That is Firefox's decoder and not a rule about
non-Chromium browsers: Safari 18.6 reports `hvc1` and `hev1` supported alongside
`avc1`, `vp8`, `vp09` and `av01`, and opens and plays `horse_trail`.

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

Readiness is two facts about a frame, not one about the session.
`packages/web/src/renderers/prepared-annotation-window.ts` reports which
detection frame a media time draws, and separately which enabled cooks, such as
the mask and polygon layers, hold a prepared artifact for it. The frame is
handed over as soon as the timeline holds it: a layer still owing its artifact
skips its own draw, while the layers with nothing to cook draw that frame
anyway. Above 1x, where mask cooking cannot match the demand, that is what keeps
boxes and labels on screen.

Under push presentation every layer draws from the frame the media time selects,
so a media time the timeline holds no frame for clears every layer at once, and
the previous frame's annotations can never stay on screen.

A cook landing never writes into the draw in progress: notifications that arrive
while a present is running are ignored, because a draw or render inside one
present would put a second render in it. A landing for the frame on screen
reaches the screen as a redraw of that frame, raised by the window's own term in
the render description, which is also how detections arriving while paused get
drawn.

The behavior is pinned by name in
`packages/web/src/renderers/pixi-media-scene.prepared-window.test.ts`: "draws
the vector layers of a frame whose cooks are still owed", "never leaves the
previous frame's annotations on the next one", "renders exactly once when the
window reaches the frame on screen", "redraws for each cook that lands,
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
uploaded files both open through `createWebVideoEngineMediaRendererSource()`, and
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
no render count. None of it is precedent for the push path: new video work goes
through the engine-backed source
and the push path described above.
