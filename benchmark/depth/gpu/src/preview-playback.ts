import type { DepthMap, DepthPreviewLevels } from "supervision-js-core";
import {
  chooseDepthPreviewDecoding,
  probeDepthPreviewDecoder,
  resolveDepthPreviewDecoding,
  type DepthPreviewDecoderVerdict,
} from "../../../../packages/web/src/media/depth-preview-probe";
import {
  openDepthPreviewTrack,
  type DepthPreviewTrackReader,
} from "../../../../packages/web/src/media/depth-preview-track";
import { createDepthPreviewLumaCopier } from "../../../../packages/web/src/render-preparation/depth-preview-luma-copier";
import type { DepthPreviewLumaCopier } from "../../../../packages/web/src/render-preparation/depth-preview-luma";
import { createDepthPreviewWindow } from "../../../../packages/web/src/render-preparation/depth-preview-window";
import { resolveDepthClipOptions } from "../../../../packages/web/src/render-preparation/depth-source";
import { createDepthDraw, createLut } from "./depth-draw";
import type { BenchBackend } from "./pixi-backend";
import { summarize, type TimingSummary } from "./timing";

/** A preview clip to decode: the Spring fixture's, or a resize of it. */
export interface PreviewClip {
  readonly label: string;
  readonly url: string;
}

/** The levels the Spring fixture's preview, and its resizes, are written in. */
export const FIXTURE_PREVIEW_LEVELS: DepthPreviewLevels = "tv";
/** The fixture preview's reserved band. */
const FIXTURE_RESERVED_MAX = 31;

/** What the page's decoders do to preview codes at one level (plan risk R2). */
export interface PreviewCodesCase {
  readonly levels: DepthPreviewLevels;
  readonly chosen: string;
  readonly residualError: number | null;
  readonly correction: boolean;
  readonly verdicts: readonly {
    readonly hardwareAcceleration: string;
    readonly supported: boolean;
    readonly exact: boolean | null;
    readonly judgedCodes: number | null;
    readonly mismatchedCodes: number | null;
    readonly maxError: number | null;
    /** The largest error left once the probe's table corrects the codes. */
    readonly correctedError: number | null;
    readonly lumaPath: string | null;
    /** The lowest and highest judged codes: 0 and 255, or 16 and 235. */
    readonly lowCode: number;
    readonly lowReadsAs: number | null;
    readonly highCode: number;
    readonly highReadsAs: number | null;
    readonly error?: string;
  }[];
}

/**
 * The Spring preview's first frames through one decoder, against the luma
 * ffmpeg decodes from the same file: the decoder's own error on real depth,
 * with the codec's error taken out.
 */
export interface PreviewClipCodesCase {
  readonly levels: DepthPreviewLevels;
  readonly decoder: string;
  readonly corrected: boolean;
  readonly frames: number;
  readonly pixels: number;
  /**
   * Pixels ffmpeg decodes outside TV range, below 16 or above 235, as the
   * codec's error leaves some next to holes and edges. A decoder that
   * converts to RGB returns them as 16 and 235, which decode to the same
   * depth, so the errors below compare both sides clamped to TV range.
   */
  readonly outsideRangePixels: number;
  /** Pixels whose code differs from ffmpeg's. */
  readonly mismatchedPixels: number;
  readonly maxError: number;
  readonly meanError: number;
  readonly lumaPath: string | null;
  readonly error?: string;
}

/** Case 4: decoding a whole preview as fast as it goes. */
export interface PreviewDecodeCase {
  readonly clip: string;
  readonly width: number;
  readonly height: number;
  readonly decoder: string;
  /** Where frames' luma was copied: the page, or the render-preparation worker. */
  readonly copy: "page" | "worker";
  readonly frames: number;
  readonly framesPerSecond: number;
  /** Main-thread time handing one frame over and copying its luma out. */
  readonly copyMs: TimingSummary;
  /** Longest stretch the main thread was busy while decoding, in ms. */
  readonly longestBlockMs: number;
  readonly lumaPath: string | null;
}

/** Case 6: playback at a rate, held by the preview window's gate. */
export interface PreviewPlaybackCase {
  readonly clip: string;
  readonly copy: "page" | "worker";
  readonly rate: number;
  readonly uploadAhead: boolean;
  readonly budgetMiB: number;
  readonly budgetLeadSeconds: number;
  readonly wallSeconds: number;
  readonly presents: number;
  /** Presents whose frame had no decoded preview: drawn without depth. */
  readonly presentsWithoutDepth: number;
  readonly gateHolds: number;
  /** Holds that ran out the gate's two-second bound. */
  readonly gateAbandoned: number;
  readonly heldMs: number;
  /** The present: bind or upload, draw, render. Not waited on. */
  readonly presentMs: TimingSummary;
  /** Uploads that landed in a present rather than ahead of it. */
  readonly uploadsInPresent: number;
  readonly framesDecoded: number;
  readonly copyMsPerDecodedFrame: number;
  readonly longestBlockMs: number;
  /** First depth after a seek to the middle of the clip, at rest. */
  readonly seekToPreviewMs: number | null;
}

const MAX_WAIT_SECONDS = 2;
const RESUME_MARGIN_WALL_SECONDS = 0.2;
const STOP_BELOW_WALL_SECONDS = 0.1;
const REQUIRED_AHEAD_SECONDS = 1;
const MAX_STOP_SHARE_OF_RESUME = 0.5;
const MAX_PLAYBACK_WALL_SECONDS = 4;

/**
 * The session's copier: the library's render-preparation worker, built by
 * Vite from source here, where the package embeds its own build.
 */
function createWorkerCopier(): DepthPreviewLumaCopier {
  return createDepthPreviewLumaCopier({
    workerFactory: {
      createWorker: () =>
        new Worker(
          new URL(
            "../../../../packages/web/src/render-preparation/mask-preparation.worker.ts",
            import.meta.url,
          ),
          { type: "module" },
        ),
    },
  });
}

const PREFERENCES = [
  "prefer-hardware",
  "prefer-software",
  "no-preference",
] as const;

/**
 * Probes the page's decoders the way a session does before a preview at
 * `levels` opens, then every decoder the browser offers, so the report shows
 * what the session's choice avoided.
 */
export async function runPreviewCodesProbe(
  levels: DepthPreviewLevels,
): Promise<PreviewCodesCase> {
  const decoding = await chooseDepthPreviewDecoding(levels);
  const verdicts: DepthPreviewDecoderVerdict[] = [];

  for (const preference of PREFERENCES) {
    verdicts.push(await probeDepthPreviewDecoder(preference, levels));
  }

  return {
    chosen: decoding.hardwareAcceleration,
    correction: decoding.correction !== null,
    levels,
    residualError: Number.isFinite(decoding.residualError)
      ? decoding.residualError
      : null,
    verdicts: verdicts.map((verdict) => describeVerdict(verdict, levels)),
  };
}

function describeVerdict(
  verdict: DepthPreviewDecoderVerdict,
  levels: DepthPreviewLevels,
) {
  const [lowCode, highCode] = levels === "tv" ? [16, 235] : [0, 255];
  const corrected = verdict.probe
    ? resolveDepthPreviewDecoding([verdict], levels).residualError
    : null;

  return {
    correctedError: corrected,
    error: verdict.error,
    exact: verdict.probe?.exact ?? null,
    hardwareAcceleration: verdict.hardwareAcceleration,
    highCode,
    highReadsAs: verdict.probe?.decoded[highCode] ?? null,
    judgedCodes: verdict.probe?.judgedCodes ?? null,
    lowCode,
    lowReadsAs: verdict.probe?.decoded[lowCode] ?? null,
    lumaPath: verdict.probe?.lumaPath ?? null,
    maxError: verdict.probe?.maxError ?? null,
    mismatchedCodes: verdict.probe?.mismatchedCodes ?? null,
    supported: verdict.supported,
  };
}

const clampTv = (code: number) => Math.min(235, Math.max(16, code));

/**
 * Decodes the first `frames` frames of `clip` through each decoder the
 * browser offers, each with the table its own probe gives, and compares
 * every code with `reference`, ffmpeg's luma of the same frames.
 */
export async function runPreviewClipCodes(
  clip: PreviewClip,
  reference: Uint8Array,
  frames: number,
): Promise<PreviewClipCodesCase[]> {
  const levels = FIXTURE_PREVIEW_LEVELS;
  const rows: PreviewClipCodesCase[] = [];

  for (const preference of PREFERENCES) {
    const verdict = await probeDepthPreviewDecoder(preference, levels);

    if (!verdict.supported) continue;

    const { correction } = resolveDepthPreviewDecoding([verdict], levels);
    const row = {
      corrected: correction !== null,
      decoder: preference,
      levels,
    };

    try {
      const reader = await openDepthPreviewTrack(clip.url, {
        correction,
        hardwareAcceleration: preference,
      });

      try {
        const run = reader.decode(0);
        let mismatchedPixels = 0;
        let outsideRangePixels = 0;
        let maxError = 0;
        let sum = 0;
        let pixels = 0;
        let decoded = 0;

        for (
          let frame = await run.next();
          frame && decoded < frames;
          frame = await run.next()
        ) {
          const offset = decoded * frame.luma.length;

          for (let index = 0; index < frame.luma.length; index += 1) {
            const written = reference[offset + index];
            const error = Math.abs(
              clampTv(frame.luma[index]) - clampTv(written),
            );

            if (written < 16 || written > 235) outsideRangePixels += 1;
            if (error > 0) mismatchedPixels += 1;
            if (error > maxError) maxError = error;
            sum += error;
          }
          pixels += frame.luma.length;
          decoded += 1;
        }
        run.cancel();
        rows.push({
          ...row,
          frames: decoded,
          lumaPath: reader.getStats().lumaPath,
          maxError,
          meanError: pixels ? sum / pixels : 0,
          mismatchedPixels,
          outsideRangePixels,
          pixels,
        });
      } finally {
        reader.dispose();
      }
    } catch (error) {
      rows.push({
        ...row,
        error: String(error),
        frames: 0,
        lumaPath: null,
        maxError: Number.NaN,
        meanError: Number.NaN,
        mismatchedPixels: 0,
        outsideRangePixels: 0,
        pixels: 0,
      });
    }
  }

  return rows;
}

/**
 * Decodes every frame of a clip through the library's reader, back to back,
 * and times what lands on the main thread: the hand-over and luma copy of
 * each frame, and the longest the thread was busy at a stretch.
 */
export async function runPreviewDecode(
  clip: PreviewClip,
  hardwareAcceleration: HardwareAcceleration,
  copy: "page" | "worker",
): Promise<PreviewDecodeCase> {
  const decoding = await chooseDepthPreviewDecoding(FIXTURE_PREVIEW_LEVELS);
  const copier = copy === "worker" ? createWorkerCopier() : undefined;
  const reader = await openDepthPreviewTrack(clip.url, {
    copier,
    correction:
      hardwareAcceleration === decoding.hardwareAcceleration
        ? decoding.correction
        : null,
    hardwareAcceleration,
  });
  const heartbeat = startHeartbeat();

  try {
    const run = reader.decode(0);
    const copies: number[] = [];
    let previous = 0;
    const started = performance.now();
    let frames = 0;

    for (let frame = await run.next(); frame; frame = await run.next()) {
      const copied = reader.getStats().copyMainThreadMs;

      copies.push(copied - previous);
      previous = copied;
      frames += 1;
    }

    const seconds = (performance.now() - started) / 1000;

    if (copier && !copier.offMainThread) {
      throw new Error("The worker copier fell back to the page.");
    }

    return {
      clip: clip.label,
      copy,
      copyMs: summarize(copies),
      decoder: hardwareAcceleration,
      frames,
      framesPerSecond: frames / seconds,
      height: reader.height,
      longestBlockMs: heartbeat.longestGapMs(),
      lumaPath: reader.getStats().lumaPath,
      width: reader.width,
    };
  } finally {
    heartbeat.stop();
    reader.dispose();
    copier?.destroy();
  }
}

/**
 * Plays a clip at `rate` against the library's preview window with the
 * session's default gate: the playhead advances with the wall clock while
 * the window leads it, and holds, as a session holds its producer, while the
 * window's lead is short, for up to two seconds. Each animation frame is a
 * present: it draws the frame's preview through the library's texture ring
 * and depth shader, or nothing when the frame was not decoded.
 */
export async function runPreviewPlayback(
  backend: BenchBackend,
  clip: PreviewClip,
  rate: number,
  uploadAhead: boolean,
): Promise<PreviewPlaybackCase> {
  const decoding = await chooseDepthPreviewDecoding(FIXTURE_PREVIEW_LEVELS);
  const copier = createWorkerCopier();
  const reader = await openDepthPreviewTrack(clip.url, {
    copier,
    correction: decoding.correction,
    hardwareAcceleration: decoding.hardwareAcceleration,
  });
  const frameDuration = reader.times[1] - reader.times[0];
  const frameRate = 1 / frameDuration;
  const frameBytes = reader.width * reader.height;
  const budgets = resolveDepthClipOptions({
    exactFrameBytes: frameBytes * 2,
    frameRate,
    previewFrameBytes: frameBytes,
  });
  const timeAt = (index: number) => reader.times[index];
  const endAt = (index: number) => reader.times[index] + frameDuration;
  const window = createDepthPreviewWindow({
    createMap: (frame) =>
      ({
        height: frame.height,
        kind: "disparity_px",
        samples: {
          encoding: "preview8",
          levels: FIXTURE_PREVIEW_LEVELS,
          range: { max: 40, min: 0 },
          reservedMax: FIXTURE_RESERVED_MAX,
          values: frame.luma,
        },
        width: frame.width,
      }) satisfies DepthMap,
    endAt,
    frameBytes,
    frames: reader,
    maxBytes: budgets.preview.maxCacheBytes,
    prefetchSeconds: budgets.preview.prefetchSeconds,
    retainSeconds: budgets.preview.retainSeconds,
    timeAt,
  });
  const draw = createDepthDraw(backend, {
    height: reader.height,
    width: reader.width,
  });
  const lut = createLut((index) => [index, 255 - index, 128]);
  const resumeAtSeconds = Math.min(
    REQUIRED_AHEAD_SECONDS,
    (STOP_BELOW_WALL_SECONDS + RESUME_MARGIN_WALL_SECONDS) * rate,
  );
  const thresholds = {
    enabled: true,
    resumeAtSeconds,
    stopBelowSeconds: Math.min(
      STOP_BELOW_WALL_SECONDS * rate,
      resumeAtSeconds * MAX_STOP_SHARE_OF_RESUME,
    ),
  };
  const indexAt = (time: number) =>
    Math.min(
      reader.frameCount - 1,
      Math.max(0, Math.floor(time / frameDuration + 1e-6)),
    );
  const presents: number[] = [];
  const heartbeat = startHeartbeat();
  let uploadsInPresent = 0;
  let presentsWithoutDepth = 0;
  let gateHolds = 0;
  let gateAbandoned = 0;
  let heldMs = 0;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPresented: number | null = null;
  const recentSteps: number[] = [];
  /** The frame the next upload-ahead starts from: the latest presented. */
  let uploadFrom = 0;

  try {
    // Opening a session waits for the first frame's depth, as play does.
    await window.waitForReady(0, thresholds);

    let mediaTime = 0;
    let last = performance.now();
    const started = last;
    const end = endAt(reader.frameCount - 1);

    while (
      mediaTime < end - frameDuration &&
      performance.now() - started < MAX_PLAYBACK_WALL_SECONDS * 1000
    ) {
      const now = await nextAnimationFrame();

      mediaTime = Math.min(
        end - frameDuration / 2,
        mediaTime + ((now - last) / 1000) * rate,
      );
      last = now;

      const index = indexAt(mediaTime);

      window.setPlayhead(index);
      if (window.needsPlaybackGateWait(index, thresholds)) {
        gateHolds += 1;

        const holdStarted = performance.now();
        const abandoned = await Promise.race([
          window.waitForReady(index, thresholds).then(() => false),
          sleep(MAX_WAIT_SECONDS * 1000).then(() => true),
        ]);

        if (abandoned) gateAbandoned += 1;
        heldMs += performance.now() - holdStarted;
        last = performance.now();
      }

      const entry = window.getEntry(index);

      if (!entry) {
        presentsWithoutDepth += 1;
        continue;
      }

      // How far the next present moves, as the depth layer guesses it: the
      // whole part of the last few presents' pace, or one more.
      if (
        lastPresented !== null &&
        index > lastPresented &&
        index - lastPresented <= 8
      ) {
        recentSteps.push(index - lastPresented);
        if (recentSteps.length > 4) recentSteps.shift();
      }
      lastPresented = index;

      const presentStarted = performance.now();

      if (!draw.ring.has(entry.map)) uploadsInPresent += 1;
      draw.draw(entry.map, lut, { range: { max: 40, min: 0 } });
      presents.push(performance.now() - presentStarted);

      uploadFrom = index;
      if (uploadAhead && uploadTimer === undefined) {
        // As the scene does: one task after the presents, from the latest.
        uploadTimer = setTimeout(() => {
          uploadTimer = undefined;
          const pace =
            recentSteps.reduce((sum, step) => sum + step, 0) /
            Math.max(1, recentSteps.length);
          const upcoming = window.upcoming(
            uploadFrom,
            2,
            Math.max(1, Math.floor(pace)),
          );
          const keep = new Set(upcoming.map(({ map }) => map));
          const current = window.getEntry(uploadFrom);

          if (current) keep.add(current.map);
          for (const next of upcoming) {
            if (!draw.ring.has(next.map)) draw.ring.acquire(next.map, keep);
          }
        }, 0);
      }
    }

    const wallSeconds = (performance.now() - started) / 1000;
    const stats = reader.getStats();

    // Seek: the middle of the clip, at rest, until its preview lands.
    const target = Math.floor(reader.frameCount / 2);
    const seekStarted = performance.now();
    let seekToPreviewMs: number | null = null;

    window.setPlayhead(target);
    while (performance.now() - seekStarted < 5000) {
      if (window.getEntry(target)) {
        seekToPreviewMs = performance.now() - seekStarted;
        break;
      }
      await sleep(2);
    }

    return {
      budgetLeadSeconds:
        Math.floor(budgets.preview.maxCacheBytes / frameBytes) / frameRate -
        budgets.preview.retainSeconds,
      budgetMiB: budgets.preview.maxCacheBytes / (1024 * 1024),
      clip: clip.label,
      copy: copier.offMainThread ? "worker" : "page",
      copyMsPerDecodedFrame:
        stats.framesCopied > 0
          ? stats.copyMainThreadMs / stats.framesCopied
          : 0,
      framesDecoded: stats.framesDecoded,
      gateAbandoned,
      gateHolds,
      heldMs,
      longestBlockMs: heartbeat.longestGapMs(),
      presentMs: summarize(presents.length > 0 ? presents : [0]),
      presents: presents.length + presentsWithoutDepth,
      presentsWithoutDepth,
      rate,
      seekToPreviewMs,
      uploadAhead,
      uploadsInPresent,
      wallSeconds,
    };
  } finally {
    clearTimeout(uploadTimer);
    heartbeat.stop();
    window.destroy();
    reader.dispose();
    copier.destroy();
    draw.destroy();
    lut.destroy();
  }
}

/** Width and height of a clip without decoding it. */
export async function readClipSize(
  clip: PreviewClip,
): Promise<{ width: number; height: number } | null> {
  let reader: DepthPreviewTrackReader | null = null;

  try {
    reader = await openDepthPreviewTrack(clip.url);
    return { height: reader.height, width: reader.width };
  } catch {
    return null;
  } finally {
    reader?.dispose();
  }
}

/**
 * Pings itself through a message channel, as fast as the event loop lets it,
 * and keeps the longest gap between two pings: the longest the main thread
 * was busy with something else.
 */
function startHeartbeat() {
  const channel = new MessageChannel();
  let last = performance.now();
  let longest = 0;
  let running = true;

  channel.port1.onmessage = () => {
    const now = performance.now();

    longest = Math.max(longest, now - last);
    last = now;
    if (running) channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);

  return {
    longestGapMs: () => longest,
    stop() {
      running = false;
      channel.port1.close();
    },
  };
}

function nextAnimationFrame() {
  return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
