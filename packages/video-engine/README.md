# supervision-js-web-video-engine

Frame-accurate video decoding, scrubbing, and playback for the browser, built on
[WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) and
[mediabunny](https://github.com/Vanilagy/mediabunny). It decodes off the main
thread, addresses frames by identity rather than by timestamp, and keeps the
playhead on the frame a caller asked for.

## Where It Is Published

Nowhere on its own. This is a private workspace of the `supervision-js`
repository, like `supervision-js-core`. Its build is staged into
[`supervision`](https://www.npmjs.com/package/supervision), which is the one
published package, and applications reach the engine from there:

```ts
import { VideoEngine } from "supervision/web-video-engine";
```

`supervision` loads it through a dynamic import at the moment a video source
opens, so an application that never opens one emits none of this code.

Nothing here depends on `supervision`. The dependency runs one way, which is
what lets the browser package treat the engine as a leaf it can load late.

## Entry Points

| Entry                                   | Contents                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `supervision/web-video-engine`          | `VideoEngine`, the frame timeline, seek units, decode-resolution strategies, errors and diagnostics    |
| `supervision/web-video-engine/analysis` | `AnalysisSession`, `FrameExtractor`, `FrameWalker` for pulling frames out of a source without a player |
| `supervision/web-video-engine/worker`   | The decode worker as a module URL                                                                      |

The two module entries are split so that importing a player type never pulls the
demuxer into a bundle: opening a source reaches it, reading state does not.

The worker entry is an escape hatch. The build embeds the worker as source text
and spawns it from a blob URL, so an ordinary consumer never has to resolve,
copy, or host a worker file.

## Browser Requirements

WebCodecs and workers. WebGPU is used for presentation where the worker realm
exposes it and falls back to a 2D canvas everywhere else. An environment that
cannot decode a source surfaces a `VideoEngineError` with code
`DECODE_UNSUPPORTED` from `VideoEngine.load`, rather than failing at import.

## Documentation

See the [supervision-js repository](https://github.com/roboflow/supervision-js#readme).

## License

MIT
