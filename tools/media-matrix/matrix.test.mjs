import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isStampable } from "./stamp.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  await readFile(path.join(TOOL_DIR, "matrix.json"), "utf8"),
);
const TIERS = ["reference", "baseline", "variation", "combination", "awkward"];
const SUPPORT = ["expected", "uncertain", "unlikely"];
const clipIds = new Set(matrix.clips.map((clip) => clip.id));
const sourceIds = new Set(matrix.sources.map((source) => source.id));

test("clip ids are unique", () => {
  assert.equal(clipIds.size, matrix.clips.length);
});

test("every clip declares a known tier, axis and browser expectation", () => {
  for (const clip of matrix.clips) {
    assert.ok(TIERS.includes(clip.tier), `${clip.id} tier ${clip.tier}`);
    assert.ok(
      SUPPORT.includes(clip.browserSupport),
      `${clip.id} browserSupport`,
    );
    assert.ok(clip.varies?.length > 0, `${clip.id} varies`);
    assert.ok(clip.extension?.length > 0, `${clip.id} extension`);

    if (clip.tier !== "reference" && clip.tier !== "baseline") {
      assert.ok(
        clip.axis in matrix.axes,
        `${clip.id} axis ${clip.axis} is undocumented`,
      );
    }
  }
});

test("every axis the matrix documents has at least one clip", () => {
  const covered = new Set(matrix.clips.map((clip) => clip.axis));

  for (const axis of Object.keys(matrix.axes)) {
    assert.ok(covered.has(axis), `no clip varies ${axis}`);
  }
});

test("every source reference resolves", () => {
  for (const clip of matrix.clips) {
    const { from, kind } = clip.source;

    if (kind === "encode") {
      assert.ok(
        from === "synthetic" || sourceIds.has(from),
        `${clip.id} encodes from unknown source ${from}`,
      );
    } else if (kind === "reference") {
      assert.ok(
        sourceIds.has(from),
        `${clip.id} references unknown source ${from}`,
      );
    } else {
      assert.ok(clipIds.has(from), `${clip.id} ${kind}es unknown clip ${from}`);
    }
  }
});

test("derived clips read a clip defined before them", () => {
  const seen = new Set();

  for (const clip of matrix.clips) {
    if (["remux", "rename"].includes(clip.source.kind)) {
      assert.ok(
        seen.has(clip.source.from),
        `${clip.id} reads ${clip.source.from}, which is defined later`,
      );
    }

    seen.add(clip.id);
  }
});

test("every encoded clip is large enough to carry a frame stamp", () => {
  for (const clip of matrix.clips) {
    if (clip.source.kind !== "encode") {
      continue;
    }

    assert.ok(clip.video, `${clip.id} has no video block`);
    assert.ok(
      isStampable(clip.video),
      `${clip.id} is ${clip.video.width}x${clip.video.height}, too small to stamp`,
    );
    assert.ok(
      clip.outputArgs?.length > 0,
      `${clip.id} has no ffmpeg arguments`,
    );
    assert.ok(clip.source.frames > 0, `${clip.id} encodes no frames`);
  }
});

test("a clip longer than the stamp's range says so", () => {
  for (const clip of matrix.clips) {
    const frames = clip.source.frames ?? 0;

    if (frames > 65536) {
      assert.equal(clip.stampWraps, true, `${clip.id} is ${frames} frames`);
    }
  }
});

test("the identity oracle is the presentation ordinal, with no frame rate in it", () => {
  assert.match(matrix.notes.identityOracle, /PresentedFrameId\.index/);
  assert.match(matrix.notes.identityOracle, /never asserts/);
  assert.doesNotMatch(
    matrix.notes.identityOracle.replace(/estimatedFrameIndex[\s\S]*$/, ""),
    /round\(/,
    "the oracle itself must not derive an index from a frame rate",
  );
});

test("the byte figures have an unstamped control to be read against", () => {
  const control = matrix.clips.filter((clip) => clip.stamped === false);

  assert.equal(control.length, 1, "exactly one unstamped control");
  assert.equal(control[0].axis, "stampCost");
  assert.ok(
    matrix.clips.some((clip) => clip.id === "baseline"),
    "the control needs the clip it controls for",
  );
  assert.match(matrix.notes.stampAffectsBytes, /baseline-unstamped/);
});

test("clips sit on both sides of the exact cache mode flip", () => {
  const flip = matrix.clips.filter((clip) => clip.axis === "exactCacheMode");

  assert.equal(flip.length, 2, "the flip is bracketed");
  assert.match(matrix.axes.exactCacheMode, /2\.5811/);
});

test("a clip that cannot be rebuilt byte for byte says so", () => {
  for (const clip of matrix.clips) {
    if ("reproducible" in clip) {
      assert.equal(
        typeof clip.reproducible,
        "boolean",
        `${clip.id} reproducible`,
      );
    }
  }

  const declared = matrix.clips.filter((clip) => clip.reproducible === false);

  assert.ok(declared.length > 0, "no clip declares itself non-reproducible");
  assert.ok(
    declared.every((clip) => clip.axis === "gopBytes"),
    "only the rate-controlled sweep should be exempt from the digest pin",
  );
  assert.match(matrix.notes.reproducibility, /reproducible: false/);
});

test("the two real sources and the inclusion rule are recorded", () => {
  assert.deepEqual([...sourceIds].sort(), ["large-screen", "p-square"]);

  for (const source of matrix.sources) {
    assert.ok(source.file?.endsWith(".mp4"), `${source.id} file`);
    assert.ok(source.why?.length > 0, `${source.id} why`);
  }

  assert.match(matrix.notes.inclusionRule, /VLC|QuickTime/);
  assert.match(matrix.notes.notACrossProduct, /cross|combination/i);
});

test("the smoke selection stays small and reaches every source kind", () => {
  const smoke = matrix.clips.filter((clip) =>
    (clip.tags ?? []).includes("smoke"),
  );

  assert.ok(smoke.length <= 16, `${smoke.length} smoke clips is not a handful`);
  assert.deepEqual([...new Set(smoke.map((clip) => clip.source.kind))].sort(), [
    "encode",
    "reference",
    "remux",
    "rename",
  ]);
  assert.ok(
    smoke.some((clip) => clip.source.from === "synthetic"),
    "no smoke clip exercises the generated-content path",
  );
  assert.ok(
    smoke.every(
      (clip) => !(clip.tags ?? []).some((tag) => ["heavy", "xl"].includes(tag)),
    ),
    "a smoke clip is tagged heavy or xl",
  );
});
