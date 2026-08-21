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

| flag                 | default                                                     |
| -------------------- | ----------------------------------------------------------- |
| `--chrome-debug-url` | `http://127.0.0.1:9223`                                     |
| `--url`              | `http://localhost:5173/`                                    |
| `--out`              | `tools/demo-eval/report.json`                               |
| `--scenario`         | `all`, or a comma-separated subset (see the list below)     |
| `--storybook`        | `http://localhost:6006`                                     |
| `--battery`          | `http://127.0.0.1:8123/stress-battery.js`                   |
| `--attempts`         | `3` tries before a disturbed window is invalid              |
| `--repeat`           | `1` full pass; more takes the median and reports the spread |
| `--baseline`         | `tools/demo-eval/baseline.json`                             |
| `--update-baseline`  | off; records this run as the new baseline                   |
| `--tolerance`        | the baseline file's own, normally `25` percent              |

`--scenario` also takes a comma-separated list, for example
`--scenario drag,playhead`. Pass flags through npm with `--`, for example
`npm run eval:demo -- --scenario paints`.

Scenario names: `paints`, `sync`, `latency`, `layers`, `throttle`, `blanking`,
`drag`, `playhead`, `backscrub`, `focus`, `hotkeys`, `battery`.

The run prints a summary and writes
`{ startedAt, scenarios, metrics, verdicts, failures, baseline }` to the report
path. Both that file and `baseline.json` are written by the tool, so
`.prettierignore` excludes them from the format check; unlike the report, the
baseline belongs in the repository, because a baseline nobody else has is not
a baseline. Each verdict is `pass`, `fail`,
`invalid-environment` or `skipped`; the process exits 1 when any verdict is
`fail`, and also when a metric regressed against the baseline. An
`invalid-environment` verdict means the tool refused to turn a disturbed window
into a number, and the summary says what disturbed it.

## The baseline

A threshold catches a fall off a cliff. It does not catch a number walking from
40ms to 190ms one commit at a time while a 250ms limit keeps reporting pass,
which is how most of these numbers got slow the first time. So every run also
compares itself against `baseline.json`: the numbers this machine measured on a
day somebody was willing to defend them.

```bash
npm run eval:demo -- --repeat 3                     # measure and compare
npm run eval:demo -- --repeat 3 --update-baseline   # record a new baseline
npm run eval:demo -- --scenario drag,playhead       # one gesture, quickly
```

The comparison reports each metric as a percentage of what it was, and the run
exits 1 on a regression as well as on a threshold breach. A metric only counts
as regressed when it moves the wrong way by more than the tolerance **and** by
more than its own noise floor, which is the absolute change this machine
produces run to run with nothing changed. Both live next to the metric in
`baseline.mjs`; the noise floor is what keeps a number whose baseline is 0 or
0.4 from crying on every run. A metric whose right answer is a fixed value
rather than a budget carries no tolerance at all, so only its noise floor
stands between it and a regression: one shortcut in four dying is a quarter of
them gone, and no percentage should absorb that.

Measure on a quiet machine, and use `--repeat 3` to compare as well as to
record. Roughly one pass in three on this machine is disturbed by something
else on it, and a single disturbed pass reports regressions that are not
there: one run taken while other work was going on came back with five
regressed and twenty-five steady, and every one of the five was the machine.
Three passes and a median drop that pass on the floor. Recording a baseline
while a test suite ran beside it put the throttled picture at 0.80 of the source
rate against 0.99 with nothing else running; a second browser tab on the same
demo puts the drag's canvas lag at 3.40s against 2.27s, and loses a release
outright about one pass in five.

Changing how a metric is measured retires its recorded number, and the file
cannot tell: a stale entry compares this week's instrument against last week's
and reports a percentage that means nothing. So the entry is replaced by hand,
in the same commit, or removed outright when the metric is. `drag.lagP95Seconds`
was replaced this way when it moved off `currentTime` and onto the engine's
trace; its old value of 1.672s was a reading of a different quantity and is
gone. The five passes recorded in its place spread by 0.035s, and three other
sessions on the same build sat at 2.27s, 2.87s and 3.40s, so about 0.6s
separates one session's mode from another's and its noise floor has to cover
that and no more. The floors in `baseline.mjs` are the other half of a rebuilt
metric: a floor is the spread of the instrument that produced it, and one left
behind from a looser instrument absorbs every regression the tolerance was
meant to catch.

Recording is deliberate and never automatic. `--update-baseline` refuses while
any scenario is failing or invalid, because freezing a broken number as the new
normal is how a baseline stops meaning anything; `--allow-failing-baseline`
overrides that on purpose and writes the failing verdicts into the file so
nobody later reads those numbers as a target. The file also records the
machine, and the commit and dirtiness of both checkouts, since the engine is
consumed from source and its working tree is part of what every number here
measures. A baseline recorded on another processor is somebody else's numbers,
and the summary says so rather than printing deltas between two machines.

Use `--repeat 3` when recording. Each pass is measured whole, the median of
each metric becomes the baseline, and the spread is kept beside it so a quiet
median cannot hide a loud machine. Across passes the worst verdict stands and
every failure carries the pass it came from, while the scenario detail printed
under each name is the last pass's; the medians live in the report's `metrics`
block.

## What each scenario proves

**paints** traces six paused seconds and six playing seconds, and photographs
the page with Chrome's paint-rect overlay on. A paused demo should paint exactly
nothing: a paused page that still paints is doing per-frame DOM work with no
frame to show for it. Playing, it asserts two separate things, and keeping them
separate is the point:

- **How often** the main thread paints, from the trace. A canvas presenting
  video paints once per presented frame; every paint beyond that is DOM work
  sitting on top of playback, and the budget is 15 passes a second.
- **How far** a repaint spreads, from the overlay. The transport's widest honest
  damage is one timeline lane, so the budget away from the picture is 1% of the
  viewport, and a flash covering nine tenths of the viewport in both directions
  fails outright however small its rate.

The report also carries `Layout` and `Commit` counts and the scene render delta
so a paint regression can be traced to the layer that caused it.

The rect histogram beside them answers neither question, and reading it as
damage is a trap this harness fell into once. A `Paint` event's `clip` is the
cull rect of the paint chunk it belongs to, so every paint into the root
scrolling layer carries the full viewport whatever it actually invalidated: a
`1500x1150` row means the main thread ran that many paint passes, not that it
redrew the page that many times. In the run that made the point, the histogram
showed 64 viewport-sized rects while the overlay in the same window measured the
widest repaint at `156x11`, 1716px² against a 17250px² budget. The overlay is
the instrument; the histogram is a census of paint passes and the layers they
went into.

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

### The per-defect guards

Six scenarios exist because the thing each measures shipped broken once, and a
person watching the player found it. Each drives the page the way a hand does.

**blanking** plays ten seconds and watches the annotations rather than the
picture: how many frames the mask cook is ahead of the playhead, what share of
sampled frames drew no detection at all, and what share were on screen before
their masks were cooked. The defect: detections went missing every ten seconds
or so, because the detection buffer only reloaded once the playhead had already
left the window it was drawing from, and the PNG round trip in the mask cook
never let it get ahead.

**drag** presses the timeline at 15%, drags to 85% over a paced 1200ms, and lets
go. Four defects lived in that one gesture, so it reports four numbers: how far
the frames that reached the canvas sat behind the position they were serving,
the longest the screen held a single frame while the thumb kept moving, how many
frames a second actually reached the screen, and how long the release took to
land. It then presses play and checks the clock moves: the release that never
reached the producer left the engine mechanically paused for good while the chip
still read Playing, and only trying to play afterwards finds that.

The lag number comes from the engine's own trace, armed around the gesture and
freed after it. Nothing on the main thread knows which frame is on the canvas:
`currentTime` is written the moment a scrub is commanded, so a lag measured
against it times the command travelling and calls it the picture arriving. Read
that way it could not fail on the defect it exists for, and it did not behave
like a measurement either: five passes on one unchanged build gave 1.642, 0.032,
1.148, 0.032 and 1.677 seconds, a 52x spread, while its three neighbours on the
same passes moved by 1.2x to 1.3x. Read off the trace, five passes on that same
build spread 0.035s, which is what makes the baseline comparison mean something
for it. The spread was the metric, not the machine.

Read the three drag numbers together, because none of them sees what the others
do. A screen that paints steadily but always from two seconds ago is only in the
lag number; a screen frozen on one frame paints nothing, so it has no lag to
report and the hold and frame-rate gates are what fail. Repeating the same drag
without reloading takes the lag from 2.3s to zero as the cache warms, so a run's
number describes the cache it was measured against as much as the code.

**playhead** pauses, holds for four seconds and reads the playhead's transform
alongside the media clock. A stopped picture whose playhead keeps sliding is the
defect. It then samples five positions and fits a line through them, so a
playhead drawn away from the time it is drawing fails too.

**backscrub** walks five stops forwards, then the same five backwards, and
compares the coloured ink on the canvas at each. Masks that arrive on the way
forward and not on the way back is the defect, and comparing the two passes is
what makes it visible without anyone deciding in advance how much ink a frame
owes. Measured at exactly 1.000 at every stop; the same frames with masks off
carry 0.50 to 0.75 of their ink, so the floor sits between the two.

**focus** photographs one paused frame with the overlay off and again with it
on, and reduces the pair to two numbers: how much dark the overlay added, and
how much of the picture it left bright. An overlay that vanishes adds no dark;
an overlay that loses its cutout leaves nothing bright. The first is what
shipped.

**hotkeys** clicks a layer checkbox, confirms the checkbox is what now holds
focus, and then presses Space, Space, `.` and ArrowRight. That click is what
killed them: a checkbox is an `input`, the key handler treated every focused
input as somewhere the user was typing, and every shortcut the hint bar still
advertised stopped answering.

Three more guards for the same defects are unit tests rather than scenarios,
because what they check has no browser in it. `guards.test.ts` feeds each
scenario's verdict both healthy numbers and the signature of the defect it
exists for, so no gate here can quietly become one that cannot fail.
`baseline.test.ts` covers the comparison arithmetic. `source-contracts.test.ts`
reads the two invariants that live inside React hooks this repo has no DOM
environment to render.

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
