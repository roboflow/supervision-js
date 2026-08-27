#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import {
  applyFrameStamp,
  drawSyntheticFrame,
  isStampable,
  MAX_STAMPED_FRAME_INDEX,
  readFrameStamp,
  stampGeometry,
} from "./stamp.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TOOL_DIR, "../..");
const MATRIX_FILE = path.join(TOOL_DIR, "matrix.json");
const DIGESTS_FILE = path.join(TOOL_DIR, "clip-digests.json");
const DEFAULT_OUTPUT_DIR = path.join(TOOL_DIR, "output");
const DEFAULT_SOURCE_DIR =
  process.env.MEDIA_MATRIX_SOURCE_DIR ?? "/Users/caio/Downloads/aaa/as/Raw";
const DEFAULT_VERIFY_FRAMES = 12;
const SELECT_TERM_LIMIT = 48;
/* Matroska stamps a random segment UID and a wall-clock date into every file it
 * writes, so without this a WebM rebuilt from identical input has a different
 * digest and the pin can never mean anything. */
const BITEXACT_ARGS = ["-fflags", "+bitexact", "-flags:v", "+bitexact"];
const MANIFEST_SCHEMA = "supervision-js.tools.media-matrix.manifest";
const DIGESTS_SCHEMA = "supervision-js.tools.media-matrix.digests";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

await main();

async function main() {
  const matrix = JSON.parse(await readFile(MATRIX_FILE, "utf8"));
  const toolchain = await readToolchain();
  const selected = selectClips(matrix.clips, options);

  if (selected.length === 0) {
    throw new Error("No clip in the matrix matched the selection.");
  }

  const clipDir = path.join(options.outputDir, "clips");

  await mkdir(clipDir, { recursive: true });

  const sources = new Map(
    matrix.sources.map((source) => [
      source.id,
      { ...source, path: path.join(options.sourceDir, source.file) },
    ]),
  );
  const results = new Map();

  for (const level of buildLevels(selected)) {
    await runPool(level, options.jobs, async (clip) => {
      const started = Date.now();

      try {
        const result = await buildClip(clip, {
          clipDir,
          results,
          sources,
          toolchain,
        });

        results.set(clip.id, {
          ...result,
          elapsedMs: Date.now() - started,
        });
        console.log(formatProgress(clip, results.get(clip.id)));
      } catch (error) {
        results.set(clip.id, {
          axis: clip.axis,
          elapsedMs: Date.now() - started,
          error: String(error.message ?? error),
          id: clip.id,
          status: "failed",
          tier: clip.tier,
        });
        console.log(`FAILED  ${clip.id}: ${error.message ?? error}`);
      }
    });
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    version: 1,
    toolchain,
    selection: {
      axes: options.axes,
      ids: options.ids,
      jobs: options.jobs,
      skipHeavy: options.skipHeavy,
      skipXl: options.skipXl,
      tags: options.tags,
      threads: options.threads,
      tiers: options.tiers,
      verifyFrames: options.verifyFrames,
    },
    sourceDir: options.sourceDir,
    stamp: {
      bitBlockCount: 16,
      bitOrder: "bit 0 leftmost",
      maxStampedFrameIndex: MAX_STAMPED_FRAME_INDEX,
    },
    clips: selected.map((clip) => results.get(clip.id)).filter(Boolean),
  };

  await writeJson(path.join(options.outputDir, "manifest.json"), manifest);
  await reconcileDigests(manifest, toolchain);

  printSummary(manifest);

  if (manifest.clips.some((clip) => clip.status === "failed")) {
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ build */

async function buildClip(clip, context) {
  if (clip.source.kind === "reference") {
    return buildReference(clip, context);
  }

  const outputPath = path.join(context.clipDir, `${clip.id}.${clip.extension}`);

  await rm(outputPath, { force: true });

  const missingEncoder =
    clip.encoder && !context.toolchain.encoders.includes(clip.encoder);

  if (missingEncoder) {
    return {
      axis: clip.axis,
      id: clip.id,
      reason: `${clip.encoder} is not built into this ffmpeg`,
      status: "unavailable",
      tier: clip.tier,
      varies: clip.varies,
    };
  }

  const built = await produce(clip, outputPath, context);

  return finishClip(clip, outputPath, { ...context, ...built });
}

async function produce(clip, outputPath, context) {
  switch (clip.source.kind) {
    case "encode":
      return encodeClip(clip, outputPath, context);
    case "remux":
      return remuxClip(clip, outputPath, context);
    case "rename":
      return renameClip(clip, outputPath, context);
    default:
      throw new Error(`Unknown source kind ${clip.source.kind}.`);
  }
}

async function encodeClip(clip, outputPath, context) {
  const { width, height } = clip.video;

  if (!isStampable({ height, width })) {
    throw new Error(
      `${width}x${height} is too small to carry a frame stamp, so it cannot be in the matrix.`,
    );
  }

  const encoder = spawnFfmpeg([
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    clip.video.frameRate,
    "-i",
    "-",
    ...threadArgs(),
    ...BITEXACT_ARGS,
    /* Input and output rates are the same number on purpose: any conversion
     * here would duplicate or drop frames, and the stamp would stop naming the
     * position the frame ends up at. */
    "-fps_mode",
    "passthrough",
    "-an",
    ...clip.outputArgs,
    outputPath,
  ]);

  let frameCount = 0;

  try {
    if (clip.source.from === "synthetic") {
      for (let index = 0; index < clip.source.frames; index += 1) {
        /* A fresh buffer a frame. A stream write keeps the buffer it was handed
         * until the pipe drains, so drawing the next frame into a reused one
         * rewrites bytes that have not been sent yet, and the encoder receives a
         * frame spliced from two. It reads back as a valid stamp, because the
         * stamp is a small part of the picture, which is exactly why nothing
         * downstream would catch it. */
        const frame = Buffer.alloc(width * height * 3);

        drawSyntheticFrame(frame, { frameIndex: index, height, width });
        await writeFrame(encoder.child.stdin, frame);
        frameCount += 1;
      }
    } else {
      frameCount = await pipeStampedSource(clip, encoder, context);
    }
  } finally {
    encoder.child.stdin.end();
  }

  await encoder.done;

  return { frameCount };
}

async function pipeStampedSource(clip, encoder, context) {
  const source = context.sources.get(clip.source.from);

  if (!source) {
    throw new Error(`Unknown source ${clip.source.from}.`);
  }

  const { width, height } = clip.video;
  const decoder = spawnFfmpeg([
    "-noautorotate",
    ...(clip.source.startSeconds
      ? ["-ss", String(clip.source.startSeconds)]
      : []),
    "-i",
    source.path,
    ...threadArgs(),
    "-frames:v",
    String(clip.source.frames),
    "-vf",
    `scale=${width}:${height}:flags=bicubic`,
    "-fps_mode",
    "passthrough",
    "-an",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);

  let frameCount = 0;

  for await (const frame of readFrames(
    decoder.child.stdout,
    width * height * 3,
  )) {
    applyFrameStamp(frame, { frameIndex: frameCount, height, width });
    await writeFrame(encoder.child.stdin, frame);
    frameCount += 1;
  }

  await decoder.done;

  if (frameCount === 0) {
    throw new Error(`Decoding ${source.file} produced no frames.`);
  }

  return frameCount;
}

async function remuxClip(clip, outputPath, context) {
  const from = context.results.get(clip.source.from);

  if (!from?.file) {
    throw new Error(
      `${clip.id} remuxes ${clip.source.from}, which was not built.`,
    );
  }

  await runFfmpeg([
    ...(clip.inputArgs ?? []),
    "-i",
    path.join(context.clipDir, path.basename(from.file)),
    ...BITEXACT_ARGS,
    ...clip.outputArgs,
    outputPath,
  ]);

  return { frameCount: from.probed?.frameCount ?? null };
}

async function renameClip(clip, outputPath, context) {
  const from = context.results.get(clip.source.from);

  if (!from?.file) {
    throw new Error(
      `${clip.id} renames ${clip.source.from}, which was not built.`,
    );
  }

  await copyFile(
    path.join(context.clipDir, path.basename(from.file)),
    outputPath,
  );

  return { frameCount: from.probed?.frameCount ?? null };
}

async function buildReference(clip, context) {
  const source = context.sources.get(clip.source.from);

  if (!source) {
    throw new Error(`Unknown source ${clip.source.from}.`);
  }

  const probed = await probe(source.path);

  await assertDecodable(source.path, probed);

  return {
    axis: clip.axis,
    browserSupport: clip.browserSupport,
    bytes: (await stat(source.path)).size,
    file: null,
    id: clip.id,
    path: source.path,
    probed,
    sha256: await sha256File(source.path),
    stamp: null,
    status: "ok",
    tier: clip.tier,
    varies: clip.varies,
  };
}

async function finishClip(clip, outputPath, context) {
  const probed = await probe(outputPath);

  await assertDecodable(outputPath, probed);

  const stampable =
    clip.source.kind !== "reference" &&
    probed.width &&
    isStampable({ height: probed.height, width: probed.width });

  return {
    axis: clip.axis,
    browserSupport: clip.browserSupport,
    bytes: (await stat(outputPath)).size,
    file: path.relative(options.outputDir, outputPath),
    ffmpeg: {
      inputArgs: clip.inputArgs ?? [],
      outputArgs: clip.outputArgs ?? [],
      requestedFrames: clip.source.frames ?? null,
      source: clip.source.from,
      startSeconds: clip.source.startSeconds ?? null,
      writtenFrames: context.frameCount ?? null,
    },
    id: clip.id,
    probed,
    reproducible: clip.reproducible !== false,
    roundTrip: stampable
      ? await roundTrip(outputPath, probed, clip)
      : { checked: false, reason: "not stampable" },
    sha256: await sha256File(outputPath),
    stamp: stampable
      ? stampGeometry({ height: probed.height, width: probed.width })
      : null,
    status: "ok",
    tier: clip.tier,
    varies: clip.varies,
  };
}

/* ------------------------------------------------------------------ probe */

/**
 * Packet level, so nothing is decoded. Packet sizes are where bytes-per-GOP and
 * bytes-per-keyframe come from, and those are the numbers a seek actually pays.
 */
async function probe(filePath) {
  const stream = parseKeyValues(
    await runFfprobe([
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,codec_tag_string,profile,level,width,height,pix_fmt," +
        "has_b_frames,r_frame_rate,avg_frame_rate,time_base,start_pts,start_time," +
        "nb_frames,bit_rate,duration,field_order,color_primaries,color_transfer," +
        "color_space,mime_codec_string",
      "-of",
      "default=noprint_wrappers=1",
      filePath,
    ]),
  )[0];

  if (!stream) {
    throw new Error("ffprobe found no video stream.");
  }

  const rotation = await probeRotation(filePath);
  const packets = parseKeyValues(
    await runFfprobe([
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts,dts,size,flags",
      "-of",
      "default=noprint_wrappers=1",
      filePath,
    ]),
  );

  return { ...describeStream(stream), ...summarisePackets(packets), rotation };
}

function describeStream(stream) {
  const width = Number(stream.width);
  const height = Number(stream.height);
  const megapixelsPerFrame = (width * height) / 1e6;
  const actualFrameRate = parseRational(stream.avg_frame_rate);

  return {
    frameBudgetMs: actualFrameRate ? round(1000 / actualFrameRate, 2) : null,
    megapixelsPerSecond: actualFrameRate
      ? round(megapixelsPerFrame * actualFrameRate, 2)
      : null,
    avgFrameRate: stream.avg_frame_rate,
    bitRate: numberOrNull(stream.bit_rate),
    codecName: stream.codec_name,
    codecTag: stream.codec_tag_string,
    colorPrimaries: nullable(stream.color_primaries),
    colorSpace: nullable(stream.color_space),
    colorTransfer: nullable(stream.color_transfer),
    declaredFrameRate: stream.r_frame_rate,
    duration: numberOrNull(stream.duration),
    fieldOrder: nullable(stream.field_order),
    hasBFramesDeclared: Number(stream.has_b_frames) > 0,
    height,
    level: numberOrNull(stream.level),
    megapixelsPerFrame: round(megapixelsPerFrame, 3),
    mimeCodec: nullable(stream.mime_codec_string),
    pixFmt: stream.pix_fmt,
    profile: nullable(stream.profile),
    startPts: numberOrNull(stream.start_pts),
    startTime: numberOrNull(stream.start_time),
    timeBase: stream.time_base,
    width,
  };
}

function summarisePackets(packets) {
  const usable = packets.filter((packet) => packet.size !== undefined);

  if (usable.length === 0) {
    return { frameCount: null };
  }

  const decodeOrder = usable.map((packet) => ({
    dts: numberOrNull(packet.dts),
    key: String(packet.flags ?? "").startsWith("K"),
    pts: numberOrNull(packet.pts),
    size: Number(packet.size),
  }));
  const reordered = decodeOrder.some(
    (packet) =>
      packet.pts !== null && packet.dts !== null && packet.pts !== packet.dts,
  );
  const presentationOrder = [...decodeOrder].sort(
    (left, right) => (left.pts ?? 0) - (right.pts ?? 0),
  );
  const keyFrameIndexes = presentationOrder.flatMap((packet, index) =>
    packet.key ? [index] : [],
  );
  const gopBytes = keyFrameIndexes.map((start, position) => {
    const end = keyFrameIndexes[position + 1] ?? presentationOrder.length;

    return presentationOrder
      .slice(start, end)
      .reduce((total, packet) => total + packet.size, 0);
  });
  const keyframeBytes = keyFrameIndexes.map(
    (index) => presentationOrder[index].size,
  );
  const totalBytes = decodeOrder.reduce(
    (total, packet) => total + packet.size,
    0,
  );

  return {
    bytesPerFrameMean: Math.round(totalBytes / decodeOrder.length),
    firstPts: presentationOrder[0].pts,
    frameCount: decodeOrder.length,
    gopBytes: distribution(gopBytes),
    gopFrames: distribution(
      keyFrameIndexes.map(
        (start, position) =>
          (keyFrameIndexes[position + 1] ?? presentationOrder.length) - start,
      ),
    ),
    keyFrameCount: keyFrameIndexes.length,
    keyFrameIndexes:
      keyFrameIndexes.length <= 64
        ? keyFrameIndexes
        : keyFrameIndexes.slice(0, 64),
    keyFrameIndexesTruncated: keyFrameIndexes.length > 64,
    keyframeBytes: distribution(keyframeBytes),
    packetBytesTotal: totalBytes,
    reorderedPackets: reordered,
  };
}

async function probeRotation(filePath) {
  const output = await runFfprobe([
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream_side_data=rotation",
    "-of",
    "default=noprint_wrappers=1",
    filePath,
  ]);
  const match = /rotation=(-?\d+)/.exec(output);

  return match ? Number(match[1]) : 0;
}

/**
 * The matrix's inclusion rule made mechanical: a clip our own toolchain cannot
 * get a frame out of is not a real video and does not belong.
 */
async function assertDecodable(filePath, probed) {
  const expected = probed.width * probed.height * 3;
  const raw = await runFfmpegBinary([
    "-noautorotate",
    "-i",
    filePath,
    ...threadArgs(),
    "-frames:v",
    "1",
    "-fps_mode",
    "passthrough",
    "-an",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);

  if (raw.length !== expected) {
    throw new Error(
      `ffmpeg decoded ${raw.length} bytes for the first frame, expected ${expected}.`,
    );
  }
}

/* ------------------------------------------------------------- round trip */

async function roundTrip(filePath, probed, clip) {
  const frameCount = probed.frameCount ?? 0;

  if (frameCount === 0) {
    return { checked: false, reason: "no packets to sample" };
  }

  const indexes = sampleIndexes(frameCount, options.verifyFrames);
  const { height, width } = probed;
  /* A select expression naming every wanted frame overruns ffmpeg's expression
   * parser past a few dozen terms, so a dense sample decodes the whole clip and
   * picks its frames out of the stream instead. */
  const wanted = new Set(indexes);
  const useSelect = indexes.length <= SELECT_TERM_LIMIT;
  /* -noautorotate so a rotated clip reports the stamp as stored rather than as a
   * player would turn it; rotation is recorded separately. */
  const decoder = spawnFfmpeg([
    "-noautorotate",
    "-i",
    filePath,
    ...threadArgs(),
    ...(useSelect
      ? [
          "-vf",
          `select='${indexes.map((index) => `eq(n\\,${index})`).join("+")}'`,
        ]
      : []),
    "-fps_mode",
    "passthrough",
    "-an",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);

  const reads = [];
  let decoded = -1;

  for await (const frame of readFrames(
    decoder.child.stdout,
    width * height * 3,
  )) {
    decoded += 1;

    const expected = useSelect ? indexes[reads.length] : decoded;

    if (expected === undefined) {
      break;
    }

    if (!useSelect && !wanted.has(decoded)) {
      continue;
    }

    const stamp = readFrameStamp(frame, { height, width });

    reads.push({
      expected: clip.stampWraps
        ? expected % (MAX_STAMPED_FRAME_INDEX + 1)
        : expected,
      markerLuma: round(stamp.markerLuma, 1),
      read: stamp.frameIndex,
      requested: expected,
      ...(stamp.reason ? { reason: stamp.reason } : {}),
    });
  }

  await decoder.done;

  const mismatches = reads.filter((read) => read.read !== read.expected);
  const exercisedBits = new Set();

  for (const read of reads) {
    for (let bit = 0; bit < 16; bit += 1) {
      if (((read.expected >> bit) & 1) === 1) {
        exercisedBits.add(bit);
      }
    }
  }

  return {
    checked: true,
    exercisedBits: [...exercisedBits].sort((left, right) => left - right),
    missingFrames: indexes.length - reads.length,
    mismatches,
    reads,
    sampled: indexes,
  };
}

function sampleIndexes(frameCount, count) {
  const wanted = Math.min(count, frameCount);
  const indexes = new Set([0, frameCount - 1]);

  for (let step = 1; step < wanted; step += 1) {
    indexes.add(Math.round((step * (frameCount - 1)) / (wanted - 1 || 1)));
  }

  return [...indexes].sort((left, right) => left - right).slice(0, wanted);
}

/* ------------------------------------------------------------- ffmpeg glue */

function threadArgs() {
  return options.threads === 0 ? [] : ["-threads", String(options.threads)];
}

function spawnFfmpeg(args) {
  const child = spawn(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr = [];

  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.on("error", () => {});

  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `ffmpeg exited with ${code}: ${Buffer.concat(stderr).toString().trim().slice(0, 600)}`,
            ),
          ),
    );
  });

  return { child, done };
}

async function runFfmpeg(args) {
  const { child, done } = spawnFfmpeg(args);

  child.stdin.end();
  child.stdout.resume();
  await done;
}

function runFfmpegBinary(args) {
  const { child, done } = spawnFfmpeg(args);
  const chunks = [];

  child.stdin.end();
  child.stdout.on("data", (chunk) => chunks.push(chunk));

  return done.then(() => Buffer.concat(chunks));
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8"))
        : reject(
            new Error(
              `ffprobe exited with ${code}: ${Buffer.concat(stderr).toString().trim().slice(0, 400)}`,
            ),
          ),
    );
  });
}

async function* readFrames(stream, frameBytes) {
  let held = Buffer.alloc(0);

  for await (const chunk of stream) {
    held = held.length === 0 ? chunk : Buffer.concat([held, chunk]);

    while (held.length >= frameBytes) {
      yield held.subarray(0, frameBytes);
      held = held.subarray(frameBytes);
    }
  }
}

function writeFrame(stream, frame) {
  return stream.write(frame)
    ? Promise.resolve()
    : new Promise((resolve) => stream.once("drain", resolve));
}

async function readToolchain() {
  const [version, encoderList] = await Promise.all([
    runFfmpegBinary(["-version"]).then((buffer) => buffer.toString("utf8")),
    runFfmpegBinary(["-encoders"]).then((buffer) => buffer.toString("utf8")),
  ]);

  return {
    encoders: [...encoderList.matchAll(/^\s[VAS.][\w.]{5}\s+(\S+)/gm)].map(
      (match) => match[1],
    ),
    ffmpeg: /ffmpeg version (\S+)/.exec(version)?.[1] ?? "unknown",
    platform: `${os.platform()} ${os.arch()}`,
  };
}

/* ----------------------------------------------------------------- digests */

async function reconcileDigests(manifest, toolchain) {
  const previous = await readJsonOrNull(DIGESTS_FILE);
  const built = manifest.clips.filter((clip) => clip.status === "ok");
  /* x264 and x265 split work across frames, so the same source and the same
   * arguments produce different bytes at a different thread count. A digest is
   * only a regression signal when both match. */
  const sameToolchain =
    previous?.toolchain?.ffmpeg === toolchain.ffmpeg &&
    previous?.toolchain?.threads === options.threads;
  const drifted = [];

  for (const clip of built) {
    const pinned = previous?.clips?.[clip.id];

    if (pinned && pinned.sha256 !== clip.sha256) {
      drifted.push({ ...clip, pinned: pinned.sha256 });
    }
  }

  if (drifted.length > 0) {
    const detail = drifted
      .map(
        (clip) => `  ${clip.id}: pinned ${clip.pinned}, built ${clip.sha256}`,
      )
      .join("\n");
    /* A clip the matrix marks as not reproducible drifts by its own encoder's
     * nature, so failing on it would fail every run. */
    const unexpected = drifted.filter((clip) => clip.reproducible !== false);

    if (sameToolchain && unexpected.length > 0 && !options.updateDigests) {
      throw new Error(
        `Rebuilding on the pinned ffmpeg at the pinned thread count produced different bytes:\n${detail}\nPass --update-digests once you know why.`,
      );
    }

    console.log(
      `note: ${drifted.length} clip digest(s) differ from the pin, built on ffmpeg ${toolchain.ffmpeg} at ${options.threads} thread(s) against ffmpeg ${previous?.toolchain?.ffmpeg} at ${previous?.toolchain?.threads}:\n${detail}`,
    );
  }

  if (!options.updateDigests) {
    return;
  }

  const clips = { ...(previous?.clips ?? {}) };

  for (const clip of built) {
    if (clip.sha256) {
      clips[clip.id] = { bytes: clip.bytes, sha256: clip.sha256 };
    }
  }

  await writeJson(DIGESTS_FILE, {
    schema: DIGESTS_SCHEMA,
    version: 1,
    toolchain: {
      ffmpeg: toolchain.ffmpeg,
      platform: toolchain.platform,
      threads: options.threads,
    },
    clips: Object.fromEntries(
      Object.entries(clips).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
  console.log(`wrote ${path.relative(ROOT_DIR, DIGESTS_FILE)}`);
}

/* ------------------------------------------------------------- scheduling */

/**
 * Renames and remuxes read a clip the matrix built earlier, so each level only
 * starts once everything it reads has finished.
 */
function buildLevels(clips) {
  const remaining = new Map(clips.map((clip) => [clip.id, clip]));
  const done = new Set();
  const levels = [];

  while (remaining.size > 0) {
    const level = [...remaining.values()].filter((clip) => {
      const dependency = ["remux", "rename"].includes(clip.source.kind)
        ? clip.source.from
        : null;

      return (
        dependency === null ||
        done.has(dependency) ||
        !remaining.has(dependency)
      );
    });

    if (level.length === 0) {
      throw new Error(
        `Cyclic or unbuildable dependencies: ${[...remaining.keys()].join(", ")}`,
      );
    }

    for (const clip of level) {
      remaining.delete(clip.id);
    }

    for (const clip of level) {
      done.add(clip.id);
    }

    levels.push(level);
  }

  return levels;
}

async function runPool(items, jobs, worker) {
  const queue = [...items];
  const runners = Array.from(
    { length: Math.min(jobs, queue.length) },
    async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await worker(item);
      }
    },
  );

  await Promise.all(runners);
}

function selectClips(clips, selection) {
  return clips.filter((clip) => {
    const tags = clip.tags ?? [];

    if (selection.skipHeavy && tags.includes("heavy")) {
      return false;
    }

    if ((selection.skipXl || selection.skipHeavy) && tags.includes("xl")) {
      return false;
    }

    if (selection.ids.length > 0 && !selection.ids.includes(clip.id)) {
      return false;
    }

    if (selection.tiers.length > 0 && !selection.tiers.includes(clip.tier)) {
      return false;
    }

    if (selection.axes.length > 0 && !selection.axes.includes(clip.axis)) {
      return false;
    }

    if (
      selection.tags.length > 0 &&
      !selection.tags.some((tag) => tags.includes(tag))
    ) {
      return false;
    }

    return true;
  });
}

/* ---------------------------------------------------------------- reporting */

function formatProgress(clip, result) {
  const seconds = (result.elapsedMs / 1000).toFixed(1);

  if (result.status === "unavailable") {
    return `skipped ${clip.id}: ${result.reason}`;
  }

  if (result.status === "failed") {
    return `FAILED  ${clip.id}: ${result.error}`;
  }

  const trip = result.roundTrip?.checked
    ? result.roundTrip.mismatches.length === 0
      ? `stamp ok (${result.roundTrip.reads.length} frames)`
      : `STAMP MISMATCH x${result.roundTrip.mismatches.length}`
    : "no stamp";

  return `built   ${clip.id} ${formatBytes(result.bytes)} ${result.probed.codecName}/${result.probed.pixFmt} ${result.probed.frameCount}f ${result.probed.megapixelsPerSecond}MP/s ${formatBytes(result.probed.gopBytes?.max ?? 0)}/gop ${trip} ${seconds}s`;
}

function printSummary(manifest) {
  const counts = manifest.clips.reduce((totals, clip) => {
    totals[clip.status] = (totals[clip.status] ?? 0) + 1;

    return totals;
  }, {});
  const mismatched = manifest.clips.filter(
    (clip) => clip.roundTrip?.checked && clip.roundTrip.mismatches.length > 0,
  );

  console.log(
    `\n${manifest.clips.length} clip(s): ${Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ")}`,
  );

  if (mismatched.length > 0) {
    console.log(
      `stamp mismatches: ${mismatched.map((clip) => clip.id).join(", ")}`,
    );
  }

  console.log(
    `manifest: ${path.relative(ROOT_DIR, path.join(options.outputDir, "manifest.json"))}`,
  );
}

/* ------------------------------------------------------------------ helpers */

function parseKeyValues(text) {
  const records = [];
  let current = null;

  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator);

    if (current === null || key in current) {
      current = {};
      records.push(current);
    }

    current[key] = line.slice(separator + 1);
  }

  return records;
}

function distribution(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);

  return {
    count: sorted.length,
    max: sorted[sorted.length - 1],
    mean: Math.round(
      sorted.reduce((total, value) => total + value, 0) / sorted.length,
    ),
    min: sorted[0],
    p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
  };
}

function parseRational(value) {
  const [numerator, denominator] = String(value ?? "")
    .split("/")
    .map(Number);

  return Number.isFinite(numerator) && denominator > 0
    ? numerator / denominator
    : null;
}

function round(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function nullable(value) {
  return value === undefined || value === "unknown" || value === "N/A"
    ? null
    : value;
}

function numberOrNull(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function formatBytes(bytes) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)}MB`
    : `${Math.round(bytes / 1024)}KB`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    await prettier.format(JSON.stringify(value), { parser: "json" }),
  );
}

function parseArgs(args) {
  const parsed = {
    axes: [],
    help: false,
    ids: [],
    jobs: 1,
    outputDir: DEFAULT_OUTPUT_DIR,
    skipHeavy: false,
    skipXl: false,
    sourceDir: DEFAULT_SOURCE_DIR,
    tags: [],
    threads: 2,
    tiers: [],
    updateDigests: false,
    verifyFrames: DEFAULT_VERIFY_FRAMES,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--select":
        parsed.ids.push(readFlagValue(args, (index += 1), arg));
        break;
      case "--axis":
        parsed.axes.push(readFlagValue(args, (index += 1), arg));
        break;
      case "--tier":
        parsed.tiers.push(readFlagValue(args, (index += 1), arg));
        break;
      case "--tag":
        parsed.tags.push(readFlagValue(args, (index += 1), arg));
        break;
      case "--smoke":
        parsed.tags.push("smoke");
        break;
      case "--skip-heavy":
        parsed.skipHeavy = true;
        break;
      case "--skip-xl":
        parsed.skipXl = true;
        break;
      case "--out":
        parsed.outputDir = path.resolve(readFlagValue(args, (index += 1), arg));
        break;
      case "--source-dir":
        parsed.sourceDir = path.resolve(readFlagValue(args, (index += 1), arg));
        break;
      case "--jobs":
        parsed.jobs = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--threads":
        parsed.threads = parseNonNegativeInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--verify-frames":
        parsed.verifyFrames = parsePositiveInteger(
          readFlagValue(args, (index += 1), arg),
          arg,
        );
        break;
      case "--update-digests":
        parsed.updateDigests = true;
        break;
      default:
        throw new Error(`Unknown argument ${arg}.`);
    }
  }

  return parsed;
}

function readFlagValue(args, index, flag) {
  const value = args[index];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
npm run matrix:media -- --smoke
npm run matrix:media -- --skip-heavy --jobs 4
npm run matrix:media -- --select baseline --select rotation-90

Builds the media compatibility matrix defined in tools/media-matrix/matrix.json
into a git-ignored output directory, then probes and verifies every clip it
built. Nothing generated is committed; clip-digests.json pins the bytes.

Options:
  --select <clipId>          can be repeated; default: every clip
  --axis <axis>              can be repeated
  --tier <tier>              reference | baseline | variation | combination | awkward
  --tag <tag>                can be repeated
  --smoke                    shorthand for --tag smoke
  --skip-heavy               drop the heavy and xl clips
  --skip-xl                  drop the xl clips
  --jobs <count>             clips built at once; default: 1
  --threads <count>          ffmpeg threads per clip, 0 for auto; default: 2
  --verify-frames <count>    frames read back per clip; default: ${DEFAULT_VERIFY_FRAMES}
  --out <dir>                default: ${path.relative(ROOT_DIR, DEFAULT_OUTPUT_DIR)}
  --source-dir <dir>         where the two originals live; default:
                             $MEDIA_MATRIX_SOURCE_DIR or ${DEFAULT_SOURCE_DIR}
  --update-digests           rewrite clip-digests.json from this run`);
}
