---
title: Breaking Changes
summary: Every removal and behavior change an application has to answer for when moving to 0.2.0.
---

# Breaking Changes

This covers the browser package `supervision` at `0.2.0`, against the release
before it.

The list is derived rather than remembered. The public surface is pinned as
TypeScript facades under `docs/public/api/`, and the documentation gate holds
those facades equal to what the package entry points actually export. Diffing
the facades and the entry points between the two releases produces the
removals below. A name that is not in that surface is not public, so an
internal type losing a field is not listed here.

## No Export Was Removed

The pinned surface went from 401 exported names to 416: fifteen added, none
removed. Every import that resolved against the previous release still
resolves.

## Removed Type Members

| Type                                 | Removed                                                                                        | Replacement                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `BaseInteractionStyleOptions`        | `shape`, `cornerRadius`, `stroke`, `fill`                                                      | `hovered.boxStyle` and `selected.boxStyle`                                |
| `BaseInteractionStyle`               | `resolveBoxInstruction`, `resolveShape`, `resolveCornerRadius`, `resolveStroke`, `resolveFill` | none; the default highlight is no longer assembled from overridable parts |
| `MediaSessionDetectionSourceOptions` | `requiredForPlayback`                                                                          | `requiredForCoverage`                                                     |
| `CompositeDetectionFrameSourceEntry` | `requiredForPlayback`                                                                          | `requiredForCoverage`                                                     |

### One Way To Style A Highlight

A hover or selection highlight had two ways to be styled that shadowed each
other. Four fields on `BaseInteractionStyleOptions` set the highlight rectangle
directly, while `hovered.boxStyle` and `selected.boxStyle` did the same job
through the ordinary style path. Configuring one state switched the four fields
off for that state and left them running for the other, which compiles and
draws two different highlights.

The four fields are gone. Move a highlight to `hovered.boxStyle` and
`selected.boxStyle`, which have full parity: the renderer forwards hover and
selection into the style context, so one box style handed to both states can
still tell them apart. They also reach mask, label, keypoint, polygon, and
polyline highlights, which the removed fields never did. A highlight left
unconfigured looks the same as before.

TypeScript reports this as a compile error. A plain JavaScript consumer passing
the removed fields gets no error and reverts to the built-in highlight.

### The Five Protected Methods

`BaseInteractionStyle` resolved the removed fields through five `protected`
methods, and those are gone with them. They are absent from the generated API
reference, which excludes protected members, so a subclass overriding them is
the one case where the break does not appear in the published docs. The class
now composes its default highlight in one place and exposes no hook into it.

### requiredForPlayback Is requiredForCoverage

The flag never had anything to do with playback. It picks which detection
sources a composite source waits for when it reports a range as covered, which
is what `waitForRange` on `MediaSession.detectionSource` answers.

Rename the property. The boolean keeps its polarity and its default of `true`,
and the behavior is unchanged. It appears on two public types, and both were
renamed together: `MediaSessionDetectionSourceOptions` in
`packages/web/src/types/media-session.ts` and
`CompositeDetectionFrameSourceEntry` in
`packages/core/src/types/detection-timeline.ts`.

TypeScript reports this as a compile error. A plain JavaScript consumer who had
set the old name to `false` starts waiting on that source again, and with the
playback gate on that means playback waits too.

## Behavior Changes

These break no types. An application that compiles unchanged can still behave
differently.

### Playback Waits For Annotations By Default

`MediaSessionOptions.playbackGate` is new and defaults to on. A session holds
the picture until the frame it is about to show has both its detections and the
prepared artifacts that draw them, so a preview opens annotated instead of
opening bare and filling in.

Pass `playbackGate: false` to start playback at once and draw annotations as
they land. The switch answers for `detections.playbackGate` and
`renderer.renderPreparation.playbackGate` together; set either one's `enabled`
to answer for that gate alone. The detection half applies only to a session
with appendable detections, since a source that is complete before playback
starts has nothing to wait for.

What the gate holds depends on who owns the playhead. A source the renderer
pulls decoded samples from is held frame by frame for as long as playback runs.
A source that presents its own frames, which is what
`createVideoEngineMediaRendererSource` returns, is held at the start of
playback only.

### A File Session Rebuilds Its Detection Window Less Often

The default `refreshIntervalSeconds` for a file session went from 0.5 to 2.5.
A file's detections do not change under the window, so the old interval spent
15 rebuilds a second at 8x playback, each re-deriving a window that overlapped
the one it replaced by 95%. Stream sessions keep the short interval, because
there the source really does gain data. Read the resolved numbers with
`resolveMediaSessionDefaults` rather than restating them.

### setPlaybackRate Refuses A Rate Nothing Can Deliver

`setPlaybackRate` used to accept any positive finite rate and update the state
readout whether or not a playback path existed to honor it. It now throws when
no path is up and the rate is not 1, and a source that presents its own frames
throws on a rate its producer cannot play, reverse included. A caller no longer
reads back a rate it never got.

### Nearest-Index Selection Measures The Grid Instead Of Trusting frameRate

In `DetectionFrameSelectionMode.NearestFrameIndex`, the width of a detection
frame's grid step is measured from the media times the buffered frames carry.
`frameRate` is now the fallback used when fewer than two indexed frames are
buffered, rather than the number the grid is built from.

A caller whose `frameRate` matched the clip sees no change. A caller that passed
a nominal rate the clip does not really run at was previously walked off the grid
by the accumulating difference, and now is not.

`DetectionFrameSelectionOptions.frameIndexOriginTime` is deprecated alongside
this and nothing reads it. Each buffered frame carries the media time its index
sits at, which states the same thing without an origin to extrapolate from.

### muted Is Deprecated

`MediaSessionRendererOptions.muted` is still accepted and nothing reads it. The
renderer is video-only and audio playback is deferred, so setting it changes
nothing either way.

### The Video Engine Is An Optional Peer Dependency

`supervision` declares `supervision-js-web-video-engine` as an optional peer and
reaches it through a dynamic import. Installing `supervision` does not install
it. An application that opens a video-engine media source installs it as well,
and `supervision` names the missing package if that import fails at runtime.

## Reproducing This List

```sh
git diff 50f447a9068912d68d64ad2c40032453bbdcfb73..HEAD -- docs/public/api
npm run docs:check
```

The first prints the public surface diff the list above is derived from. The
second is the gate that keeps those facades equal to the package's own
exports, which is what makes the first one trustworthy.

For what the release adds, see [Release Notes](./release-notes.md).
