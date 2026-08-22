# supervision-js-video-engine

Frame-accurate video decoding, scrubbing, and playback for the browser, built on
[WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) and
[mediabunny](https://github.com/Vanilagy/mediabunny). It decodes off the main
thread, addresses frames by identity rather than by timestamp, and keeps the
playhead on the frame a caller asked for.

## Installation

```sh
npm install supervision-js-video-engine
```

[`supervision`](https://www.npmjs.com/package/supervision) declares this package
as an **optional** peer dependency and loads it through a dynamic import, so
installing `supervision` does not install the engine. Add it when an application
opens a video-engine media source; `supervision` says so by name if that import
fails at runtime.

The engine also stands alone. Nothing in it depends on `supervision`.

## Entry Points

| Entry                                  | Contents                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `supervision-js-video-engine`          | `VideoEngine`, the frame timeline, seek units, decode-resolution strategies, errors and diagnostics    |
| `supervision-js-video-engine/analysis` | `AnalysisSession`, `FrameExtractor`, `FrameWalker` for pulling frames out of a source without a player |
| `supervision-js-video-engine/worker`   | The decode worker as a module URL                                                                      |

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
