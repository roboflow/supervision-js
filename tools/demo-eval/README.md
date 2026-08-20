# demo-eval

Measures the running demo the way a reviewer would: does it paint when nothing
moves, do the boxes land on the frame they belong to, how long does a seek take,
and does the engine survive being scrubbed by an impatient thumb. Everything is
read over the Chrome DevTools Protocol from a real browser against a real dev
server, so the numbers describe the app as shipped rather than a unit under a
mock.

## Prerequisites

- **Chrome with remote debugging.** Start it with
  `--remote-debugging-port=9223`. Any profile works; the tool opens its own tab
  and closes it again.
- **The demo dev server** on `http://localhost:5173/` (`npm run demo:dev`). The
  page must expose `window.__demoRenderer`, which the dev build does.
- **Optional: Storybook** on `http://localhost:6006` for the `battery`
  scenario, serving the `framesampler--default` story.
- **Optional: the stress battery** served at
  `http://127.0.0.1:8123/stress-battery.js`, for example
  `python3 -m http.server 8123` in the directory holding that file. The
  `battery` scenario skips itself, with the reason in the report, when either
  server is absent.

## Running it

```bash
npm run eval:demo
```

Flags, all optional:

| flag                 | default                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `--chrome-debug-url` | `http://127.0.0.1:9223`                                            |
| `--url`              | `http://localhost:5173/`                                           |
| `--out`              | `tools/demo-eval/report.json`                                      |
| `--scenario`         | `all` (or `paints`/`sync`/`latency`/`layers`/`throttle`/`battery`) |
| `--storybook`        | `http://localhost:6006`                                            |
| `--battery`          | `http://127.0.0.1:8123/stress-battery.js`                          |
| `--attempts`         | `3` tries before a disturbed window is invalid                     |

Pass flags through npm with `--`, for example
`npm run eval:demo -- --scenario paints`.

The run prints a summary and writes
`{ startedAt, scenarios, verdicts, failures }` to the report path. That file is
generated output: keep it out of commits, and note that `npm run format:check`
covers it unless `tools/demo-eval/report.json` is listed in `.prettierignore`. Each verdict
is `pass`, `fail`, `invalid-environment` or `skipped`; the process exits 1 when
any verdict is `fail`. An `invalid-environment` verdict means the tool refused
to turn a disturbed window into a number, and the summary says what disturbed
it.

## What each scenario proves

**paints** traces six paused seconds and six playing seconds and buckets every
`Paint` by clip rect. A paused demo should paint exactly nothing: a paused page
that still paints is doing per-frame DOM work with no frame to show for it.
While playing, the canvas presents through one rect class (its own box, or the
viewport-sized layer rect when the canvas backs most of the page); every other
paint is DOM work sitting on top of playback, and its rate has to stay under
three times the rate frames are presented. The report also carries `Layout` and
`Commit` counts and the scene render delta so a paint regression can be traced
to the layer that caused it.

**sync** pauses, seeks to five spread positions, and waits for a detection
frame that is genuinely new rather than the previous window's leftover. It then
compares the requested time, `getState().currentTime` and
`activeDetectionFrameTime`. Boxes drawn against a neighbouring frame are the
visible bug this catches, so the playhead has to sit within one frame period of
the detection it is drawing.

**latency** times five awaited seeks and six alternating steps from inside the
page, after an untimed warm-up pass so cold decode setup stays out of the
numbers. Thresholds: seek p95 under 250ms, step p95 under 80ms. Stepping is the
gesture a labeller repeats hundreds of times an hour, which is why its budget is
the tight one.

**throttle** is the slow-machine floor. It sets a 2x CPU slowdown through
`Emulation.setCPUThrottlingRate`, plays six seconds from `t=5s`, and asserts
three things a player has to hold to still be worth watching: the picture
presents at least 90% of the source frame rate, at least 97% of sampled frames
carry a detection, and no main-thread task runs past 200ms.

Every floor comes from a sweep of 1x, 2x, 4x and 6x on an M3 Max against the 70s
horse fixture. This page's own main thread measured 15% busy at 1x, 30% at 2x,
54% at 4x and 82% at 6x. Through 2x the picture held 0.997 to 1.112 of the
source rate with every sampled frame carrying a detection, and the longest
main-thread task was 122ms; at 4x the rate fell to 0.803 and tasks reached
179ms, at 6x 361ms. So 2x is the hardest slowdown the demo survives whole today
and the rate the floor is asserted at. It is the knob to raise once the mask
cook stops flooding the main thread; the gate is written so raising
`THROTTLE_RATE` is the only edit.

The report also carries the prepared window's depth and the cook backlog.
Neither is asserted. On one unchanged build the window came out bimodal across
sessions: some runs sat 150 to 211 frames ahead of the playhead, others spent
their whole life at zero ahead with about 200 of the same 211 frames uncooked,
at every throttle level including 1x. Until that splits into something a session
can be judged on, a floor written against it would fail on which side of the coin
the run landed.

**battery** opens the FrameSampler story, injects the gesture stress harness and
runs `battery(1)`: sixteen scripted scrub, fling, jitter and play-pause-spam
scenarios, each followed by a check that the frame pump is still alive. It
reports pass/fail per scenario, so a gesture that wedges the engine names
itself.

## The decoder starvation trap

A playing measurement window can look perfectly healthy in a trace while
measuring nothing at all. When another tab holds the hardware decoder sessions,
this page keeps reporting `playbackState: "playing"`, the compositor keeps
committing, and the trace fills with events, but the media clock does not move
and no frames are presented. Paint counts gathered over that window describe an
idle page wearing a playing page's costume, and every rate derived from them is
meaningless. So every playing window is checked against the media clock before
its numbers are used: if playback claims to be playing while the clock is frozen
and zero frames were presented, the scenario is reported as
`invalid-environment` with the starvation signature spelled out rather than as a
pass or a fail. Close the other tab holding the decoder and run it again. The
same guard covers the smaller version of the problem, a window where playback
advanced too little to be measuring playback at all.

Two related guards protect the same honesty: a window in which the page
navigated, or in which the dev server hot-patched the app, is discarded and
retried up to `--attempts` times, because a reload restarts the renderer
mid-trace and a hot patch re-renders the whole app into the paint counts.
