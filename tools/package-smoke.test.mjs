import assert from "node:assert/strict";
import test from "node:test";

test("built package entrypoint exposes the public runtime API", async () => {
  const entrypoint = await import("../dist/index.js");

  assert.equal(typeof entrypoint.createMediaSession, "function");
  assert.equal(typeof entrypoint.createMediaRenderer, "function");
  assert.equal(typeof entrypoint.probeMedia, "function");
  assert.equal(typeof entrypoint.prepareMedia, "function");
  assert.equal(typeof entrypoint.prepareMediaProgressively, "function");
  assert.equal(typeof entrypoint.BaseBoxStyle, "function");
  assert.equal(typeof entrypoint.BaseMaskStyle, "function");
  assert.equal(typeof entrypoint.BaseLabelStyle, "function");
  assert.equal(entrypoint.MediaSessionStatus.Ready, "ready");
  assert.equal(entrypoint.MediaRendererFit.Contain, "contain");
});

test("built style classes can be constructed by package consumers", async () => {
  const entrypoint = await import("../dist/index.js");

  const boxStyle = new entrypoint.RoundedBoxStyle({
    cornerRadius: 8,
    stroke: { alpha: 1, color: 0x38bdf8, width: 3 },
  });
  const maskStyle = new entrypoint.BaseMaskStyle({
    alpha: 0.7,
    color: 0x22c55e,
  });
  const labelStyle = new entrypoint.BaseLabelStyle({
    includeConfidence: true,
  });

  assert.equal(typeof boxStyle.resolve, "function");
  assert.equal(typeof maskStyle.resolve, "function");
  assert.equal(typeof labelStyle.resolve, "function");
});
