# Media Compatibility Matrix

A record of what the video engine does with what inputs. Not a pass/fail suite:
its job is to make behaviour visible, clip by clip, and to stay re-runnable as
the engine changes.

Today the engine is exercised by two clips. Every claim about codec coverage,
GOP handling, timebase arithmetic and frame identity rests on those two, which is
why a bug that only appeared on one Android phone took three attempts to not fix.

## The inclusion rule

**Every clip in the matrix is a real video that VLC or QuickTime plays without
complaint.** A zero-byte file or a JPEG renamed `.mp4` is not in here: nothing on
earth plays those, so "we reject it too" is not a finding.

The case worth documenting is the opposite one. Somebody exports from Final Cut,
pulls a clip off a camera, or finds a file from an old phone; it opens in
QuickTime and fails in our workbench. That gap is the product risk, and when it
happens the viewer's file was fine and we are the ones saying no. What the person
is told in that moment is the product.

The rule is enforced mechanically rather than by judgement: after producing a
clip the generator decodes a frame back out of it with ffmpeg, and a clip it
cannot get a frame from fails the build.

## The two real sources

Everything is re-encoded from short excerpts of two files a real person really
has, so content is held constant and only the encoding varies. Neither is copied
into the repository; both are recorded by digest.

|                    |         `P-26030421-0014-2.mp4` |                   `large.mp4` |
| ------------------ | ------------------------------: | ----------------------------: |
| size               |                          206 MB |                       2058 MB |
| frame              |              2840x2840, 8.07 MP |            2560x1410, 3.61 MP |
| pixel throughput   |                     120.98 MP/s |               **203.52 MP/s** |
| frame budget       |                        66.67 ms |                      17.74 ms |
| bytes per GOP      | **10.28 MB mean, 11.30 MB max** | 0.49 MB mean, **9.97 MB max** |
| frames per GOP     |                              28 |                            56 |
| bytes per keyframe |                     430 KB mean |       372 KB mean, 960 KB max |
| frames             |                  564 over 37.6s |        **233,059** over 4133s |
| codec              |      H.264 Constrained Baseline |                    H.264 Main |
| declared rate      |                          15 fps |                   **600 fps** |
| actual rate        |                          15 fps |                  **56.4 fps** |

They are pathological in opposite directions, and between them they bracket the
axes that hurt.

The square one is the file the engine exists because of: every seek fetches ten
megabytes before it can decode anything, and every frame is eight megapixels to
decode and upload, at 15 fps, in Constrained Baseline, which has no CABAC and so
burns far more bits than a High-profile encode of the same content would.

The long one is 23% of the engine's one-million-frame ceiling, and its declared
frame rate is a lie by a factor of ten, which is what a variable-rate screen
recording looks like. It also asks for _more_ pixels per second than the square
one, at a quarter of the frame budget.

**And its mean GOP lies.** Half a megabyte on the mean, 9.97 MB at worst, which
is within 3% of the square clip's _mean_. A seek landing in that GOP pays what
the square clip pays every time. The manifest records min, mean, p99 and max for
every clip, and the number to design against is the max.

## Running it

```sh
npm run matrix:media -- --smoke          # a handful of tiny clips, about 10s
npm run matrix:media -- --skip-heavy     # everything cheap
npm run matrix:media -- --help
```

Clips land in `tools/media-matrix/output/clips/`, which git ignores. Nothing
generated is ever committed.

`--threads` defaults to 2 and `--jobs` to 1, so a run does not saturate a machine
somebody else is measuring on. Generation parallelises freely, so a full build on
an idle machine should raise both.

### The full matrix

```sh
npm run matrix:media -- --jobs 8 --threads 0 --update-digests
```

Run this on an **idle** machine. Encoding is CPU-saturating and would ruin any
measurement taken beside it.

**Budget 15 to 25 minutes and about 700 MB.** Extrapolated from measured builds
at `--threads 4 --jobs 1`: 77 cheap clips at roughly 0.5s each, the 2840x2840
clip at 41.6s and 14.1 MB, the 65,536-frame clip at 16.4s and 9.7 MB (about
4,000 synthetic frames a second, 155 bytes a frame). The four `xl` clips are
most of both totals; `--skip-xl` drops them and leaves a build of a couple of
minutes.

| group   | clips | time at `--jobs 1` |         disk |
| ------- | ----: | -----------------: | -----------: |
| cheap   |    77 |          about 40s | about 110 MB |
| `heavy` |    14 |      about 3.5 min | about 215 MB |
| `xl`    |     4 |       about 12 min | about 370 MB |

## What comes back

`output/manifest.json` describes **the run that wrote it**, not everything the
clips directory happens to hold, so a benchmark can state exactly which clips and
which bytes it measured. `clip-digests.json` is the accumulating record: it
merges, so a partial run does not drop what it did not build.

For every clip in the run it records:

- **What was asked for**: the source, the excerpt, and the exact ffmpeg argument
  list.
- **What ffprobe says it actually is**: codec, profile, tag, pixel format,
  timebase, declared and average frame rate, first PTS, rotation, field order,
  colour metadata, real frame count, keyframe positions, whether packets are
  reordered, and the byte distributions for GOPs and keyframes. **What ffmpeg was
  asked for and what it produced are not always the same**, and the probed truth
  is what a test should assert against.
- **Whether the pixels agree**: the frame stamp read back off decoded frames.

Probing is packet level, so nothing is decoded to get it. Packet sizes are where
bytes-per-GOP and bytes-per-keyframe come from, and those are the numbers a seek
actually pays.

## Frame stamping

**Every encoded clip carries its own ground truth in its pixels.** That turns
frame identity from something nobody could measure into a one-line assertion:

```text
read the blocks off the frame on screen  ->  the index the encoder wrote
compare against round(mediaTime * frameRate)  ->  the index the engine believes
```

A disagreement is exact, attributable, and reproducible. It works on a phone,
because it needs nothing but a screenshot.

Each frame gets three marks:

- **Sixteen blocks along the top edge.** Block `i` is white when bit `i` of the
  zero-based frame index is set and black when it is clear, **bit 0 leftmost**.
  Each is `width / 16` wide and `max(8, height / 20)` tall, rounded to an even
  height so the row never straddles a chroma pair.
- **The index in decimal** below the blocks, for a human reading a screenshot.
- **A white marker square** in the bottom-right corner, the same size as a block.

Blocks survive lossy compression because they are large flat areas of maximum
contrast, and they survive scaling because the sample point sits in the middle of
each block. On the validation run a white block read back as exactly `255`
through H.264, HEVC, VP9 and AV1, and `253` through ProRes 4:2:2 10-bit.

### Reading the blocks

`manifest.json` gives every clip its sample points as **fractions of width and
height**, so a consumer multiplies by whatever dimensions it actually has and
does not re-derive the geometry:

```json
"samplePoints": {
  "bits": [{ "bit": 0, "x": 0.03125, "y": 0.0255 }, ...],
  "marker": { "x": 0.9859, "y": 0.9744 }
}
```

Sample the pixel at each point. **The marker is the white reference**: threshold
each block at half the marker's luma rather than at a fixed level, so a squashed
or shifted range cannot silently invert a bit. A frame whose marker is not bright
was never stamped, or was cropped, rotated or letterboxed on the way in, and
saying so is more useful than returning an index derived from whatever happened
to be at those coordinates.

A rotated clip's marker is not in the bottom-right of the _displayed_ picture,
because the display matrix turns it. The generator reads stamps with
`-noautorotate` and records `rotation` separately.

### The ceiling

Sixteen blocks address 65,536 frames. A longer clip wraps, and the matrix marks
those with `stampWraps`, which makes their identity checks modulo 65,536. That is
still useful, because a drift of a few frames is exactly what it catches, but it
is a real limit, and it is why `frame-count-233k` and `frame-count-million` cannot
name an absolute frame.

## The load axes are derived quantities, not encoder knobs

A frame-rate sweep moves pixel throughput, frame budget and frames-per-GOP
together and cannot say which one bit. 15 fps at 8 MP and 120 fps at 1 MP demand
almost the same throughput and give an eight-fold different budget to meet it in,
and that pair says something a sweep cannot. So the load axes are the quantities
the engine actually pays:

| what it costs                                       | axis                |
| --------------------------------------------------- | ------------------- |
| opening walks every packet to build the frame table | `frameCount`        |
| a seek fetches from the keyframe                    | `gopBytes`          |
| decoding after a seek walks to the target           | `framesPerGop`      |
| presenting uploads a texture per frame              | `pixelThroughput`   |
| showing anything at all needs the first fetch       | `keyframeBytes`     |
| a profile change lands straight on seek cost        | `profileEfficiency` |

`codec`, `container`, `timebase`, `startTimestamp`, `rotation`, `chroma`,
`colour` and `shape` stay as themselves. They are correctness axes rather than
load ones, and each needs one clip, not a sweep.

## The matrix definition

`matrix.json` lists every clip: an id, its tier and axis, what it varies in
prose, whether a browser is expected to decode it, and the exact ffmpeg arguments
that produce it. It is plain data; there is no second source of truth.

It is **not a cross product**. The axes multiply out to millions of combinations
which would take weeks to encode and answer nothing new, because a codec bug does
not hide behind a timebase. It is a spine of one-axis-at-a-time variations off a
single baseline, plus a handful of combinations named as such, which is where
interactions actually live.

Tiers are `reference` (the two originals, probed in place), `baseline`,
`variation`, `combination`, and `awkward`, the last being legitimate files a
desktop player opens and a browser may well not: ProRes, DNxHR, MPEG-2, DivX in AVI, WMV, FLV,
3GP, Matroska carrying perfectly ordinary H.264, interlaced content, DV, 4:4:4,
`moov` at the end, and right-content-wrong-extension.

### Adding an axis

1. Add it to `axes` in `matrix.json` with a one-line description of what it
   costs. `matrix.test.mjs` fails if an axis has no clip or a clip has no axis.
2. Copy the entry nearest to what you want, change its `id` and its `outputArgs`,
   and write `varies` for a reader who has only the manifest in front of them.
3. Change **one** thing. Everything else stays at the baseline's value, or the
   comparison means nothing.
4. Build it: `npm run matrix:media -- --select your-new-id`.
5. **Read the probed block, not the arguments you wrote.** Several entries in the
   first pass were accepted by ffmpeg and silently did nothing:
   `-x264-params interlaced=tff` left `field_order=progressive`, and a `setpts`
   expression rounded its own jitter away because the filter timebase was one
   tick per frame. If the probe does not show the thing you varied, the entry is
   not testing it.

Derived clips (`remux`, `rename`) must appear after the clip they read.

## Digests

`clip-digests.json` pins the sha256 of every clip that has been built, so a
benchmark run can state which bytes it measured. Rebuilding on the pinned ffmpeg
**at the pinned thread count** must reproduce them, and the generator fails if it
does not. On a different ffmpeg or thread count a difference is reported rather
than failed, because x264 and x265 split work across frames.

Two things had to be true for that to mean anything, and neither was free:

- Matroska stamps a random segment UID and a wall-clock date into every file, so
  every WebM and MKV rebuilt to a new digest. Every encode and remux now passes
  `-fflags +bitexact -flags:v +bitexact`.
- x264's rate control does not settle to the same bytes twice under `-b:v`, even
  at one thread with a single lookahead thread. The bytes-per-GOP sweep declares
  `"reproducible": false`, which exempts it from the hard failure and gets it
  reported instead. Everything else reproduces exactly.

`--update-digests` rewrites the pin from a run. It merges, so a partial run does
not drop the clips it did not build.

## Verification

```sh
node --test tools/media-matrix/*.test.mjs
```

`stamp.test.mjs` covers the encoding itself over the full 16-bit range, which no
clip short of 65,536 frames reaches in pixels. `matrix.test.mjs` covers the data:
unique ids, resolvable sources, documented axes, derived clips defined after what
they read, and every encoded clip large enough to carry a stamp.
