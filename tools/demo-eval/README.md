# demo-eval

Measures the library through the running demo the way a reviewer would: does
the picture hold its rate in every second of a clip, do the boxes land on the
frame they belong to, how long does a seek take, and does the engine survive
being scrubbed by an impatient thumb. Everything is
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
to the report path. Both that file and `baseline.json` are written by the tool, so
`.prettierignore` excludes them from the format check; unlike the report, the
baseline belongs in the repository, because a baseline nobody else has is not
a baseline. Each verdict is `pass`, `fail`,
`invalid-environment` or `skipped`; the process exits 1 when any verdict is
`fail`, and also when a metric regressed against the baseline. An
`invalid-environment` verdict means the tool refused to turn a disturbed window
into a number, and the summary says what disturbed it.

## How it finds the controls

Every control this tool drives carries a `data-eval` id. The demo declares the
set in `demo/src/eval-hooks.ts`, this tool declares the same set in
`hooks.mjs`, and `source-contracts.test.ts` fails when the two disagree.

That indirection is not decoration. The tool used to find controls by class
name and by the text on them, and an upstream redesign of the style panel
renamed both: `layers` and `focus` went from `pass` to
`invalid-environment` and stayed there for a whole merge, because an abstention
is not a failure and nothing in the summary says a gate has stopped running.
So a run now resolves every declared id against the live page before it
measures anything, and reports `contract fail` — which exits 1 — naming the ids
that have gone missing.

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

Every floor was measured against one unchanged build. A hundred and fifty-five
passes ran and a hundred and twenty-three came back with numbers, the rest dying
with the browser dropping the debugging socket mid-pass. Each floor is the full
spread of the passes that were measurements, rounded up so the widest of them
sits inside it, because this tool's default is a single pass and a single pass
is what a floor has to survive. Four passes put their extremes on several
unrelated metrics at once, which is the machine rather than the build, and each
entry that leaves one out says what else moved in the same pass. Two of these
numbers are not properties of a build at all: the drag and the backward scrub
inherit whatever the scenarios ahead of them left in the page, and the size of
that is under **drag** below.

Twenty-one floors came down, six went up and three were already right. The ones
that came down were entries that could not fail: the drag's longest hold could
triple, and the backward scrub could lose a tenth of its ink. The ones that went up were entries firing
on their own instrument: the step p95 spreads 30.2ms across thirty-six passes
against a floor of 12ms, and the drag release lands inside 7ms on seventeen
passes in twenty-two and takes 40 to 93ms on the other five.

Five entries carry a `Demo-contaminated` line in `baseline.mjs`, and it means
what it says: `drag.staleMeanMs` and `drag.releaseMs` measure library work but
scale it by the demo range input's own `value`; `layers.floor.p95` and
`layers.everythingOn.p95` sample frame time page-wide, so the demo's React
commits land inside the library's frame budget; and `throttle.longTaskMaxMs` is
a whole-main-thread reading that a demo re-render enters as readily as engine
work. Their subject is the library and the contamination is a known limitation
rather than a wrong question, but a number that moved should be checked against
the demo before it is blamed on the engine.

A later sweep checked those floors the way the tool runs by default,
`--scenario all` and a single pass, hashing the engine checkout and both `dist`
trees before and after every pass so a rebuild could not split a sample.
Thirty-six passes ran across sixteen build states, because the engine was being
edited while they ran, and the two largest groups sharing one build hold eight
passes and seven. Every entry carrying a floor of 0 that a run measures sat on
one number in all thirty-four to thirty-six passes that read it, across sixteen
builds. In the later group every metric but the drag's came in at or under its
floor; in the earlier one the backward-scrub settle came in over as well,
spreading 54ms against a floor of 22, and the later group put it at 16ms with
the engine changed in between. The drag came in over in both: 10.9ms of stale
mean against a floor of 10, and 21 to 22 frames a second against a floor of 20,
which is the starting state the gesture inherits rather than the gesture.

Three entries said nothing at all when they were fed the value their own
scenario fails at. Two of those were a tolerance rather than a floor: a quarter
off the throttled present fraction is 0.742 and a quarter off the backward-scrub
ink is 0.75, both under the 0.9 their scenarios fail at, so both carry no
tolerance and their floors are the whole gate. The third is the step p95, whose
31ms floor is the honest spread of its instrument and sits 2.6ms past the 80ms
threshold; six steps a pass is too few to gate for drift, and no floor changes
that.

One floor was wrong rather than wide. The throttled window's longest main-thread
task read 51 to 58ms on thirty-two of thirty-five full-run passes and never the
0 its 65ms floor was built to tolerate, so it came down to 7 and the entry
reports at 65ms against a 200ms ceiling. Which end that number lands on depends
on what ran ahead of it, the same dependency the drag and the backward scrub
carry: the same window with only `layers` in front of it reads 0. Replaying all
thirty-six passes against the recorded baseline with those three changes in
place adds one regression report, on the pass whose throttled picture fell to
0.575 of the source rate and failed its scenario outright.

Measure on a quiet machine, and use `--repeat 3` to compare as well as to
record. Roughly one pass in three on this machine is disturbed by something
else on it, and a single disturbed pass reports regressions that are not
there: one run taken while other work was going on came back with five
regressed and twenty-five steady, and every one of the five was the machine.
Three passes and a median drop that pass on the floor. Recording a baseline
while a test suite ran beside it put the throttled picture at 0.80 of the source
rate against 0.99 with nothing else running, and a second browser tab on the same
demo loses a release outright about one pass in five.

Changing how a metric is measured retires its recorded number, and the file
cannot tell: a stale entry compares this week's instrument against last week's
and reports a percentage that means nothing. So the entry is replaced by hand,
in the same commit, or removed outright when the metric is. The drag's picture
lag was retired twice this way. It first moved off `currentTime` and onto the
engine's trace, which fixed where it read from; `drag.lagP95Seconds` then went
too, because a percentile in media seconds could not describe the player. A
paint's distance from its target can only be a whole number of scrub commands,
so a percentile over the forty-odd paints one drag lands is an order statistic
on a 0.56s grid: it reads 2.27s, 2.83s or 3.40s and nothing between, and
resampling one unchanged drag's own paints moves it across all three. Its
replacement `drag.staleMeanMs` is the mean of the same distances divided by the
rate the thumb was travelling, which is a wall-clock age. The floors in
`baseline.mjs` are the other half of a rebuilt metric: a floor is the spread of
the instrument that produced it, and one left behind from a looser instrument
absorbs every regression the tolerance was meant to catch.

Recording is deliberate and never automatic. `--update-baseline` refuses while
any scenario is failing or invalid, because freezing a broken number as the new
normal is how a baseline stops meaning anything; `--allow-failing-baseline`
overrides that on purpose and writes the failing verdicts into the file so
nobody later reads those numbers as a target. The file also records the
machine, the commit and dirtiness of the checkout, the clip the scenarios ran
on, the media path that opened that clip and the renderer backend that drew it,
since all of it is part of what every number here measures. A baseline recorded
on another processor is somebody else's numbers, and the summary says so rather
than printing deltas between two machines.

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
a single delta, so does one where either tree carried uncommitted changes, and
so does one where the two ran on different clips, opened them through different
readers, or drew them with different backends. None of them changes the exit
code, because this repository's own baseline was recorded from a dirty tree and
a warning nobody can act on is a warning everybody learns to skip. They change
what the number means, and the summary says which of them applies.

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

**cadence** plays the basketball fixture through and asks whether the picture
holds its rate in every media second of it, from two clocks that fail
differently.

It is the only scenario that picks a fixture. Every other one measures whatever
the demo happened to load, which is the 70s horse trail, and the only other
scenario that samples playback frame time seeks to `t=2s` and stays there. Both
of those are where a stall on the basketball fixture lived: 33ms a frame up to
media 4.0 and 101 to 123ms past it, positional and not cumulative, so starting
playback cold at 4.5s reproduced it at about 8fps straight away. That
fixture's detections thicken from 3.8 a frame at the opening to a plateau of
12.9 to 13.1 from media 4 onwards, which is the half of the clip nothing was
watching.

It picks that fixture by button label, because the source controls carry no
identifier, and it tries `CADENCE_FIXTURE_LABELS` in order: `Basketball with
Keypoints` first, then `9s basketball sample`. More than one fixture has carried
this clip, so the scenario takes the first name the demo answers to and reports
every label it was offered when none of them is there. The rate limits are
fractions of whatever source rate the fixture declares, so they follow it, but
they were calibrated on a 30fps clip; the basketball source MP4 runs at 25fps,
and the numbers quoted below are from the 30fps one.

So it plays two windows, `whole-clip` from 0.3s and `late-start` cold from 4.5s,
and reduces each one three ways:

- **Per media second**, from the engine's own trace: every paint the engine made
  is stamped with the media position it was serving, so the paints are grouped
  by the second they landed in and each group's rate is judged on its own. A
  media second has to present at least 90% of the source rate. This is the gate
  an average cannot replace: an injected stall over the last 0.3s of the clip
  left the window averaging 27.44/s, which clears the same floor, while the
  second it happened in read 12.31/s.
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

Forty passes of one unchanged build put the slowest judged media second between
29.53/s and 29.99/s against a 30.00/s source, the late-start window between
29.65/s and 30.24/s, the longest single frame hold between 35.1ms and 43.5ms,
the two clocks 0.03/s to 0.58/s apart, and zero held frames and zero stalls
every time. Two passes in forty booked a single late frame over the late-start
window's 106 paints. Those numbers set the noise floors in `baseline.mjs`, and
setting them was worth doing carefully: thirty-one of the forty sat within
0.08/s of each other on the worst media second, and a floor cut to fit those
alone calls the other nine a regression. Each floor is the full spread of all
forty, rounded up. Four of the seven metrics carry no tolerance at all, so the
registry moves on anything past half a frame a second off the worst media
second while the scenario's own floor sits 2.5/s lower and catches the cliff.

No baseline has been recorded for these seven yet, so they print as new until
somebody runs `--update-baseline` from a clean tree. The medians to expect on an
M3 Max: worst media second 29.95/s, late-start present rate 29.93/s, frames held
past budget 0, late frames 0, stalls 0, clocks apart 0.24/s. The longest frame
hold has no single median to quote: nineteen of the forty read 35.1 to 35.5ms
and seventeen read 40.5 to 43.5ms.

Its gates have been watched to fail. Re-timing the exported engine trace to the
stall's own cadence, with the page presenting normally underneath, failed 19 of
them and named media seconds 4 through 8 while 0 through 3 passed. Freezing the
page's presented-frame counter at a third of its rate, with the engine painting
normally, failed the consumer floor and the disagreement gate on their own.
Feeding the judge the stall's recorded frame times, 33ms then 101ms and again
33ms then 123ms, failed 17 gates against 0 for the numbers this machine measures
today. Neither CPU throttling to 20x nor blocking the main thread for 90ms a
frame moves any of these numbers, which is worth knowing on its own: the engine
decodes and paints off the main thread, so nothing done to the main thread
starves the picture.

`judgeCadence` carries the same demonstration as a unit test in
`guards.test.ts`. Fed the rates forty healthy passes produced it returns
nothing; fed 112ms holds from media 4 onwards it names media seconds 4 through 8
and leaves 0 through 3 alone. Its third case is the one the per-media-second
reading exists for: a single media second at 20/s whose two window clocks both
still clear the floor and whose frames are never held past the budget. Deleting
the per-media-second gate takes that case from one failure to none, which is how
the case was checked to be gated on that reading and nothing else.

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
Neither is asserted here. On one unchanged build the window came out bimodal
across sessions: some runs sat 150 to 211 frames ahead of the playhead, others
spent their whole life at zero ahead with about 200 of the same 211 frames
uncooked, at every throttle level including 1x. Sixty-one windows on the build
measured since, thirty-one through this scenario and thirty through blanking,
read 208 frames ahead every one of them, never fell below 147 and never carried
a backlog past 64, so that coin did not come up once. `blanking` does assert the
depth, and its noise floor is 0 on the strength of those sixty-one readings.

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
against it times the command travelling and calls it the picture arriving. Read
that way it could not fail on the defect it exists for, and it did not behave
like a measurement either: five passes on one unchanged build gave 1.642, 0.032,
1.148, 0.032 and 1.677 seconds, a 52x spread, while its three neighbours on the
same passes moved by 1.2x to 1.3x. The spread was the metric, not the machine.

What the trace gives is a distance in media seconds, and a drag covering 41
media seconds a wall second turns a small age into a large distance. The same
gesture started at 5% of the clip reports 2.6s of content and started at 75%
reports 0.23s, across a picture that was 27.9ms and 17.1ms old. So the distance
is divided by the rate the thumb was travelling before it is reported, and the
statistic is the mean rather than a percentile: a paint can only be a whole
number of scrub commands behind, and a percentile over forty-odd of them lands
on one of a handful of rungs 0.56s apart. Twenty-nine cold drags on one
unchanged build spread 22.4ms to 34.9ms as an age, against 1.7s to 3.37s in
three clusters as a distance; three consecutive passes of the scenario gave
28.4ms, 30.4ms and 29.3ms.

Which scenarios ran first is part of the cache it met. Measured on its own, on a
page that has done nothing else, twenty-seven passes of the drag put 47.17 to
66.47 frames a second on the screen, held a frame 47.8 to 74.1ms at p95 and drew
a picture 24.4 to 35.0ms out of date. The same gesture at the end of a full run,
on the same build inside the same hour, managed 18.46 to 52.68 frames a second,
held 50.3 to 234.7ms and reached 70.6ms of age; it failed its own gates in eight
passes of twenty-one, against one of twenty-eight measured alone. The ten
scenarios ahead of it leave a warm cache, a full prepared window and a cook
still working, and the drag inherits all of it. Backward-scrub settle carries
the same dependency, 144 to 165ms in a six-scenario run against 155 to 459ms at
the end of a full one. The floors in `baseline.mjs` are the measured gesture, so
a full run reports these entries moving until the scenarios are given a starting
state of their own.

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
and every clean pass read exactly 0.0000. A hold in which the transport reports
Playing fails too.

It used to read the demo playhead `<span>`'s `translateX` percentage and fit a
line through five of them, with a drift limit of 0.2% of the track. That
measured how the demo draws the answer, and 0.2% was that component's
half-pixel quantum rather than anything the library decides. The line fit went
with it: whether the clocks agree is a library question, and it is gated where
the library answers it, by `sync.worstDetectionOffsetMs` holding `currentTime`
against the detection being drawn and by `cadence.clockDisagreementFps` holding
the engine's ledger against the page's presented-frame counter.

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

Three more guards for the same defects are unit tests rather than scenarios,
because what they check has no browser in it. `guards.test.ts` feeds each
scenario's verdict both healthy numbers and the signature of the defect it
exists for, so no gate here can quietly become one that cannot fail.
`baseline.test.ts` covers the comparison arithmetic. `source-contracts.test.ts`
reads the invariants that live inside React hooks this repo has no DOM
environment to render.

A **hotkeys** scenario used to sit here, pressing Space, `.` and ArrowRight
after a layer checkbox had taken focus. It is gone, along with the source
contract that read `PlayerHotkeys.tsx`. The handler it exercised is
`demo/src/components/PlayerHotkeys.tsx`, its skip distance was a harness
constant duplicating the demo's own, and no library code sat anywhere on the
path: it gated this repository on the demo application's keyboard handling.

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
is about to sample, so a second attempt on the same page is measuring a cache
the first one filled. Taken that way the drag reported the picture 4.7 to 6.9ms
out of date and 104.67 to 108.68 frames a second, against 27.0 to 28.6ms and
55.62 to 60.61 on the first attempt of the same passes: four times fresher and
nearly twice the frame rate, on the same build, in the same minute. Reloading
between attempts puts the retry back where the first attempt stood, at 25.9 to
28.5ms and 56.26 to 62.42 frames a second across four more passes. How much a
scenario gains from a warm page is its own business: the backward scrub's settle
sits on a fixed poll rather than on the cache, and it read 125 to 156ms on both
attempts with the reload and without it. The reload costs about 0.6 seconds,
timed at 613 to 620ms across four consecutive calls, and only a disturbed
attempt pays it. Roughly 100ms of that is the navigation; the rest is waiting
for the renderer and reopening the control sections. `cadence` is the
one scenario that keeps its page, because it selects the basketball fixture
itself and a reload would drop the demo back onto its default clip while every
number it reported still named the other one.
