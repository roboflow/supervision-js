# demo-eval

Measures the library through the running demo the way a reviewer would: does
the picture hold its rate in every second of a clip, do the boxes land on the
frame they belong to, how long does a seek take, and does the engine survive
being scrubbed by an impatient thumb. Everything is read over the Chrome
DevTools Protocol from a real browser against a real dev server, so the numbers
describe the built artifacts actually served to the browser rather than a unit
under a mock. A valid report must record a consumer commit and dirty state that
match the intended checkout; a running dev server alone does not prove package
output is current.

## Prerequisites

- **Chrome with remote debugging.** Start it with
  `--remote-debugging-port=9223`. Any profile works; the tool opens its own tab
  and closes it again.
- **The demo dev server** on `http://localhost:5173/` (`npm run demo:dev`). The
  page must expose `window.__demoRenderer`, which the dev build does.

The `battery` scenario cannot run in this repository. It needs a Storybook
serving the `framesampler--default` story and a `stress-battery.js` gesture
harness on a static server, and this repository contains neither. The scenario
skips itself and writes the reason into the report; `--storybook` and
`--battery` point it elsewhere if you have both servers.

## Running it

```bash
npm run eval:demo
```

Flags, all optional:

| flag                       | default                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `--chrome-debug-url`       | `http://127.0.0.1:9223`                                                              |
| `--url`                    | `http://localhost:5173/`                                                             |
| `--out`                    | `tools/demo-eval/report.json`                                                        |
| `--scenario`               | `all`, or a comma-separated subset (see the list below)                              |
| `--storybook`              | `http://localhost:6006`                                                              |
| `--battery`                | `http://127.0.0.1:8123/stress-battery.js`                                            |
| `--attempts`               | `3` tries before a disturbed window is invalid; each retry reloads                   |
| `--repeat`                 | `1` full pass; more takes the median and reports the spread                          |
| `--baseline`               | `tools/demo-eval/baseline.json`                                                      |
| `--update-baseline`        | off; records this run as the new baseline                                            |
| `--allow-failing-baseline` | off; records a baseline over failing verdicts                                        |
| `--tolerance`              | the baseline file's own, normally `25` percent                                       |
| `--view`                   | `demo`; also `benchmarks`, `debug`, or `as-is` to take the view the demo was left in |

`--scenario` also takes a comma-separated list, for example
`--scenario drag,playhead`. Pass flags through npm with `--`, for example
`npm run eval:demo -- --scenario cadence`.

The view decides how much work the page does outside the scenario: the Debug
view's readouts rewrite ten times a second and land in every frame time this
tool samples. A baseline records the view it was measured in, and a run that
compares against a baseline recorded in another view says so instead of
printing deltas between two different pages.

Scenario names: `sync`, `latency`, `layers`, `cadence`, `throttle`, `blanking`,
`drag`, `playhead`, `backscrub`, `focus`, `battery`.

The run prints a summary and writes
`{ startedAt, source, media, fixture, backend, mediaPath, scenarios, metrics,
verdicts, failures, baseline }`
to the report path. Both that file and a recorded baseline are written by the
tool, so `.prettierignore` excludes them from the format check. Each verdict is
`pass`, `fail`, `invalid-environment` or `skipped`; the process exits 1 when any
verdict is `fail`, and also when a metric regressed against a baseline. An
`invalid-environment` verdict means the tool refused to turn a disturbed window
into a number, and the summary says what disturbed it.

## How it finds the controls

Every control this tool drives carries a `data-eval` id. The demo declares the
set in `demo/src/eval-hooks.ts`, this tool declares the same set in
`hooks.mjs`, and `source-contracts.test.ts` fails when the two disagree. A run
resolves every declared id against the live page before it measures anything and
reports `contract fail`, which exits 1, naming the ids that have gone missing.
Finding controls by class name or by the text on them instead lets a redesign
turn a gate into an abstention, and an abstention is not a failure: nothing else
in the summary says a gate has stopped running.

The inspector column shows one tab at a time and mounts nothing from the
others, so a control is absent rather than hidden whenever its own tab is not
the one showing. The tool opens the tab that owns the controls it is about to
drive, and visits every tab before it decides a declared id has gone missing.

Which clip the demo opened on, and which media path opened it, are read off the
shell rather than off those controls, through the `data-eval-fixture`,
`data-eval-fixture-label` and `data-eval-media-path` attributes the demo stamps
there. The shell is mounted in every view and every tab; the buttons that set
those values are each mounted in one tab only, so a run that read the buttons
would record whichever tab it happened to leave open.

The style panel's sections unmount their bodies while they are collapsed, so
the layer toggles and the mask border slider are absent rather than hidden
until something opens them. The tool opens the two it reads and leaves them
open for the whole run: the inspector is a fixed-width column that scrolls on
its own, so the stage it measures is the same size either way, and expanding
and collapsing around each read would re-render the panel immediately before a
sample. Returning to the Demo view mounts a fresh panel, so the scenarios that
change view open them again afterwards.

## Pinning the media path

The workbench opens on Mediabunny, so a run that does not say otherwise measures
the library's own reader, not the engine. On that path `throttle` presents no
frames, `blanking` prepares none, `drag` and `cadence` return
`invalid-environment`, and `latency` and `backscrub` miss their limits by an
order of magnitude, so the numbers are unusable as an engine baseline.

Name the path in the URL:

```
node tools/demo-eval/run.mjs --url 'http://localhost:5173/?mediaPath=engine'
```

Every report records the path it ran on as `mediaPath`, so a run that forgot the
flag can be told from one that did not.

## The baseline

A threshold catches a fall off a cliff. It does not catch a number walking from
40ms to 190ms one commit at a time while a 250ms limit keeps reporting pass,
which is how most of these numbers got slow the first time. So a run can also
compare itself against a baseline: the numbers one machine measured on a day
somebody was willing to defend them.

The repository ships no baseline, because a baseline recorded on one processor
is somebody else's numbers. Record your own:

```bash
npm run eval:demo -- --repeat 3 --update-baseline   # record a baseline
npm run eval:demo -- --repeat 3                     # measure and compare
npm run eval:demo -- --scenario drag,playhead       # one gesture, quickly
```

A run that finds no file at `--baseline` says so, compares nothing, and lets the
scenario verdicts alone decide the exit code.

The comparison reports each metric as a percentage of what it was, and the run
exits 1 on a regression as well as on a threshold breach. A metric only counts
as regressed when it moves the wrong way by more than the tolerance **and** by
more than its own noise floor, which is the absolute change one machine
produces run to run with nothing changed. Both live next to the metric in
`baseline.mjs`; the noise floor is what keeps a number whose baseline is 0 or
0.4 from crying on every run. A metric whose right answer is a fixed value
rather than a budget carries no tolerance at all, so only its noise floor
stands between it and a regression: one shortcut in four dying is a quarter of
them gone, and no percentage should absorb that.

Each floor is the full spread of one unchanged build's passes, rounded up so
the widest of them sits inside it, because this tool's default is a single pass
and a single pass is what a floor has to survive. Changing how a metric is
measured retires both its floor and its recorded number, and the baseline file
cannot tell: a stale entry compares this week's instrument against last week's
and reports a percentage that means nothing, and a floor left behind from a
looser instrument absorbs every regression the tolerance was meant to catch. So
both are replaced by hand, in the same commit as the instrument, or removed
outright with the metric.

Five entries carry a `Demo-contaminated` line in `baseline.mjs`, and it means
what it says: `drag.staleMeanMs` and `drag.releaseMs` measure library work but
scale it by the demo range input's own `value`; `layers.floor.p95` and
`layers.everythingOn.p95` sample frame time page-wide, so the demo's React
commits land inside the library's frame budget; and `throttle.longTaskMaxMs` is
a whole-main-thread reading that a demo re-render enters as readily as engine
work. Their subject is the library and the contamination is a known limitation
rather than a wrong question, but a number that moved should be checked against
the demo before it is blamed on the engine.

Two metrics are not properties of a build at all. The drag and the backward
scrub inherit whatever the scenarios ahead of them left in the page — a warm
cache, a full prepared window, a cook still working — and their floors are the
gesture measured on its own, so a full run reports those entries moving.

Measure on a quiet machine, and use `--repeat 3` to compare as well as to
record. Roughly one pass in three is disturbed by something else on the machine,
and a single disturbed pass reports regressions that are not there; three
passes and a median drop that pass on the floor. Anything sharing the machine
moves these numbers, a test suite and a second browser tab on the same demo
included.

Recording is deliberate and never automatic. `--update-baseline` refuses while
any scenario is failing or invalid, because freezing a broken number as the new
normal is how a baseline stops meaning anything; `--allow-failing-baseline`
overrides that on purpose and writes the failing verdicts into the file so
nobody later reads those numbers as a target. The file also records the
machine, the commit and dirtiness of the checkout, the clip the scenarios ran
on, the media path that opened that clip and the renderer backend that drew it,
since all of it is part of what every number here measures.

Recording refuses outright, whatever `--allow-failing-baseline` says, when a run
cannot name its clip, its media path or its backend. None of the three can be
recovered once the run is over, and every later run holds its own numbers
against them.

The backend is not a free choice made beside the media path. The video-engine
path hands the renderer a presented-frame channel and gets WebGPU; mediabunny
hands it none and gets WebGL. Changing which reader the demo opens on therefore
changes the renderer under every number in the file.

The report carries the same facts, so a comparison can be checked rather than
assumed. Every run writes its own commit, whether that tree was dirty, and the
clip, media path and backend it measured into `report.json`, and prints them at
the top of the summary. The baseline comparison reads both sides: a percentage
taken against a baseline recorded on a different commit says so before it prints
a single delta, so does one where either tree carried uncommitted changes, so
does one where the two ran on different clips, opened them through different
readers, or drew them with different backends, and so does one recorded on
another machine. None of them changes the exit code, because a warning nobody
can act on is a warning everybody learns to skip. They change what the number
means, and the summary says which of them applies.

Use `--repeat 3` when recording. Each pass is measured whole, the median of
each metric becomes the baseline, and the spread is kept beside it so a quiet
median cannot hide a loud machine. Across passes the worst verdict stands and
every failure carries the pass it came from, while the scenario detail printed
under each name is the last pass's; the medians live in the report's `metrics`
block.

## What each scenario proves

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

**layers** seeks to `t=2s` and samples 240 playback frames under each of six
layer combinations, from masks and focus both off through to everything on. The
budget is not absolute: `masks-off/focus-off` is measured in the same run and
becomes the floor, and every other combination has to hold its frame-time p95
under twice that floor, or the floor plus 4ms if that is higher, and drop no
frame past 34ms. Judging each combination against a floor from the same session
is what keeps the gate about the cost of a layer rather than about how fast the
machine is that day. A combination that misses is measured a second time before
it is called a failure. The scenario also drives the Benchmarks view and back,
and fails if the viewport comes back empty, differently sized, or with
`window.__demoRenderer` no longer answering.

**cadence** plays the basketball fixture through and asks whether the picture
holds its rate in every media second of it, from two clocks that fail
differently.

It is the only scenario that picks a fixture. Every other one measures whatever
the demo happened to load, which is the 70s horse trail, and the only other
scenario that samples playback frame time seeks to `t=2s` and stays there.
Neither reaches the second half of the basketball clip, where the detections
thicken from under four a frame to thirteen and a positional stall lives.

It picks that fixture by button label, because the source controls carry no
identifier, and it tries `CADENCE_FIXTURE_LABELS` in order: `Basketball with
Keypoints` first, then `9s basketball sample`. More than one fixture has carried
this clip, so the scenario takes the first name the demo answers to and reports
every label it was offered when none of them is there. The rate limits are
fractions of whatever source rate the fixture declares, so they follow it.

So it plays two windows, `whole-clip` from 0.3s and `late-start` cold from 4.5s,
and reduces each one three ways:

- **Per media second**, from the engine's own trace: every paint the engine made
  is stamped with the media position it was serving, so the paints are grouped
  by the second they landed in and each group's rate is judged on its own. A
  media second has to present at least 90% of the source rate. This is the gate
  an average cannot replace: a stall over the last fraction of a clip leaves the
  window's average clearing the same floor while the second it happened in reads
  well under half of it.
- **Over the window, from the page**, which counts presented frames against wall
  time on the main thread.
- **Over the window, from the engine**, which counts paints against its own
  playing time in the worker, and books late frames and stalls while it does.
  The two are read together because they do not share a failure mode, and the
  run fails when they land more than 1.5/s apart: a stall only one of them can
  see is a stall in the instrument.

It also asserts its own coverage. Every whole media second the windows span has
to be judged by at least one of them, so windows that creep back towards the
opening report that instead of a pass over less of the clip.

The windows overlap on purpose. A second at the thin edge of one is in the body
of the other, and a bucket holding fewer than eight intervals is reported but
not judged, because one interval quotes a whole second's cadence from a single
frame period.

**throttle** is the slow-machine floor. It sets a 2x CPU slowdown through
`Emulation.setCPUThrottlingRate`, plays six seconds from `t=5s`, and asserts
three things a player has to hold to still be worth watching: the picture
presents at least 90% of the source frame rate, at least 97% of sampled frames
carry a detection, and no main-thread task runs past 200ms.

2x is the hardest slowdown the demo survives whole today, which is why the floor
is asserted there: through 2x the picture holds its rate with every sampled
frame carrying a detection, and at 4x the rate falls to around 0.8 of the source
with main-thread tasks reaching 179ms. It is the knob to raise once the mask
cook stops flooding the main thread; the gate is written so raising
`THROTTLE_RATE` is the only edit.

The report also carries the prepared window's depth and the cook backlog.
Neither is asserted here; `blanking` asserts the depth.

### The per-defect guards

Five scenarios exist because the thing each measures shipped broken once, and a
person watching the player found it. Each drives the page the way a hand does.

**blanking** plays ten seconds and watches the annotations rather than the
picture: how many frames the mask cook is ahead of the playhead, what share of
sampled frames drew no detection at all, and what share were on screen before
their masks were cooked. The defect: detections went missing every ten seconds
or so, because the detection buffer only reloaded once the playhead had already
left the window it was drawing from, and the PNG round trip in the mask cook
never let it get ahead.

**drag** presses the timeline at 15%, drags to 85% over a paced 1200ms, and lets
go. Four defects lived in that one gesture, so it reports four numbers: how old
the picture reaching the canvas was, the longest the screen held a single frame
while the thumb kept moving, how many frames a second actually reached the
screen, and how long the release took to land. It then presses play and checks
the clock moves: the release that never reached the producer left the engine
mechanically paused for good while the chip still read Playing, and only trying
to play afterwards finds that.

The age number comes from the engine's own trace, armed around the gesture and
freed after it. Nothing on the main thread knows which frame is on the canvas:
`currentTime` is written the moment a scrub is commanded, so a lag measured
against it times the command travelling and calls it the picture arriving, which
cannot fail on the defect this number exists for.

What the trace gives is a distance in media seconds, and a drag covering 41
media seconds a wall second turns a small age into a large distance: one picture
age reads as seconds of content near the start of a clip and as a fraction of
one near the end. So the distance is divided by the rate the thumb was
travelling before it is reported. The statistic is the mean rather than a
percentile, because a paint can only be a whole number of scrub commands behind,
and a percentile over the forty-odd a drag lands on is an order statistic on a
0.56s grid: it sits on one of a handful of rungs and nothing between.

Read the three drag numbers together, because none of them sees what the others
do. A screen that paints steadily but always from two seconds ago is only in the
age number; a screen frozen on one frame paints nothing, so it has no age to
report and the hold and frame-rate gates are what fail. Repeating the same drag
without reloading takes the age from 26ms to zero as the cache warms, so a run's
number describes the cache it was measured against as much as the code.

**playhead** pauses, seeks, holds for four seconds and asks the transport what
time it thinks it is, forty-two times. A stopped transport whose clock keeps
advancing is the defect, and the limit is zero: `currentTime` on a stopped
transport is a stored number rather than a computed one, so it does not jitter
and every clean pass reads exactly 0.0000. A hold in which the transport reports
Playing fails too. Whether the clocks agree is a separate question and is gated
where the library answers it, by `sync.worstDetectionOffsetMs` holding
`currentTime` against the detection being drawn and by
`cadence.clockDisagreementFps` holding the engine's ledger against the page's
presented-frame counter.

**backscrub** walks five stops forwards, then the same five backwards, and
compares the coloured ink on the canvas at each. Masks that arrive on the way
forward and not on the way back is the defect, and comparing the two passes is
what makes it visible without anyone deciding in advance how much ink a frame
owes. A healthy pass measures exactly 1.000 at every stop; the same frames with
masks off carry 0.50 to 0.75 of their ink, so the floor sits between the two.

**focus** photographs one paused frame with the overlay off and again with it
on, and reduces the pair to two numbers: how much dark the overlay added, and
how much of the picture it left bright. An overlay that vanishes adds no dark;
an overlay that loses its cutout leaves nothing bright. The first is what
shipped.

**battery** opens the FrameSampler story, injects the gesture stress harness and
runs `battery(1)`: sixteen scripted scrub, fling, jitter and play-pause-spam
scenarios, each followed by a check that the frame pump is still alive. It
reports pass/fail per scenario, so a gesture that wedges the engine names
itself. It needs the two servers under Prerequisites, and skips itself here.

Three more guards for the same defects are unit tests rather than scenarios,
because what they check has no browser in it. `guards.test.ts` feeds each
scenario's verdict both healthy numbers and the signature of the defect it
exists for, so no gate here can quietly become one that cannot fail; its
`judgeCadence` cases include a single media second at 20/s whose two window
clocks both still clear the floor and whose frames are never held past the
budget, which is the case the per-media-second reading exists for.
`baseline.test.ts` covers the comparison arithmetic. `source-contracts.test.ts`
reads the invariants that live inside React hooks this repo has no DOM
environment to render.

## The decoder starvation trap

A playing measurement window can look perfectly healthy in a trace while
measuring nothing at all. When another tab holds the hardware decoder sessions,
this page keeps reporting `playbackState: "playing"`, the compositor keeps
committing, and the trace fills with events, but the media clock does not move
and no frames are presented. Counts gathered over that window describe an idle
page wearing a playing page's costume, and every rate derived from them is
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
mid-trace and a hot patch re-renders the whole app into the window.

A retry reloads the page first. The discarded attempt still drove the player: it
decoded the frames the next attempt is about to ask for and cooked the masks it
is about to sample, so a second attempt on a page left as it was measures a
cache the first one filled and reports numbers no cold run reaches. The reload
costs about 0.6 seconds and only a disturbed attempt pays it. `cadence` is the
one scenario that keeps its page, because it selects the basketball fixture
itself and a reload would drop the demo back onto its default clip while every
number it reported still named the other one.
