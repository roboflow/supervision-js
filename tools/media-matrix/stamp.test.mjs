import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  applyFrameStamp,
  BIT_BLOCK_COUNT,
  bitsToFrameIndex,
  blockHeightFor,
  drawSyntheticFrame,
  frameIndexToBits,
  isStampable,
  MAX_STAMPED_FRAME_INDEX,
  MIN_STAMP_HEIGHT,
  MIN_STAMP_WIDTH,
  readFrameStamp,
  stampGeometry,
} from "./stamp.mjs";

function frame(width, height, frameIndex) {
  return drawSyntheticFrame(Buffer.alloc(width * height * 3), {
    frameIndex,
    height,
    width,
  });
}

function lumaAtFraction(rgb, { fraction, height, width }) {
  const x = Math.min(width - 1, Math.floor(fraction.x * width));
  const y = Math.min(height - 1, Math.floor(fraction.y * height));
  const offset = (y * width + x) * 3;

  return (
    0.299 * rgb[offset] + 0.587 * rgb[offset + 1] + 0.114 * rgb[offset + 2]
  );
}

test("bit 0 is the leftmost block", () => {
  const geometry = stampGeometry({ height: 240, width: 320 });
  const one = frame(320, 240, 1);
  const two = frame(320, 240, 2);

  const lumas = (rgb) =>
    geometry.samplePoints.bits.map((point) =>
      lumaAtFraction(rgb, { fraction: point, height: 240, width: 320 }),
    );

  assert.ok(lumas(one)[0] > 200, "frame 1 lights the leftmost block");
  assert.ok(lumas(one)[1] < 40, "frame 1 leaves the second block dark");
  assert.ok(lumas(two)[0] < 40, "frame 2 leaves the leftmost block dark");
  assert.ok(lumas(two)[1] > 200, "frame 2 lights the second block");
});

test("every frame index in the addressable range round-trips through pixels", () => {
  for (const frameIndex of [
    0, 1, 2, 7, 127, 128, 255, 256, 4095, 32768, 65534, 65535,
  ]) {
    const rgb = frame(320, 240, frameIndex);

    assert.equal(
      readFrameStamp(rgb, { height: 240, width: 320 }).frameIndex,
      frameIndex,
      `frame ${frameIndex}`,
    );
  }
});

test("the stamp wraps past its 16-bit ceiling", () => {
  assert.equal(MAX_STAMPED_FRAME_INDEX, 65535);

  const rgb = frame(320, 240, MAX_STAMPED_FRAME_INDEX + 6);

  assert.equal(readFrameStamp(rgb, { height: 240, width: 320 }).frameIndex, 5);
});

test("bits and index convert both ways", () => {
  const bits = frameIndexToBits(0b1010_0000_0000_0101);

  assert.equal(bits.length, BIT_BLOCK_COUNT);
  assert.deepEqual(bits.slice(0, 4), [true, false, true, false]);
  assert.equal(bitsToFrameIndex(bits), 0b1010_0000_0000_0101);
});

test("sample points land inside the block they name at every stamped width", () => {
  for (const width of [128, 176, 320, 640, 642, 1918, 2840]) {
    const geometry = stampGeometry({ height: 240, width });

    geometry.samplePoints.bits.forEach((point, bit) => {
      const start = Math.round((bit * width) / BIT_BLOCK_COUNT);
      const end = Math.round(((bit + 1) * width) / BIT_BLOCK_COUNT);
      const sampled = Math.floor(point.x * width);

      assert.ok(
        sampled >= start && sampled < end,
        `width ${width} bit ${bit}: sample ${sampled} outside [${start}, ${end})`,
      );
    });
  }
});

test("the marker calibrates white, so a dimmed frame still reads its index", () => {
  const rgb = frame(320, 240, 1234);

  for (let offset = 0; offset < rgb.length; offset += 1) {
    rgb[offset] = Math.round(rgb[offset] * 0.7);
  }

  const stamp = readFrameStamp(rgb, { height: 240, width: 320 });

  assert.ok(stamp.markerLuma < 200, "the frame really is dimmed");
  assert.equal(stamp.frameIndex, 1234);
});

test("an unstamped frame is reported rather than read", () => {
  const stamp = readFrameStamp(Buffer.alloc(320 * 240 * 3), {
    height: 240,
    width: 320,
  });

  assert.equal(stamp.frameIndex, null);
  assert.match(stamp.reason, /marker luma/);
});

test("block rows are an even number of pixels tall", () => {
  for (const height of [64, 96, 144, 240, 352, 1080, 1410, 2840]) {
    assert.equal(blockHeightFor(height) % 2, 0, `height ${height}`);
  }
});

test("frames too small to stamp are refused", () => {
  assert.equal(
    isStampable({ height: MIN_STAMP_HEIGHT, width: MIN_STAMP_WIDTH }),
    true,
  );
  assert.equal(
    isStampable({ height: MIN_STAMP_HEIGHT - 1, width: 640 }),
    false,
  );
  assert.equal(isStampable({ height: 480, width: MIN_STAMP_WIDTH - 1 }), false);
  assert.throws(() => stampGeometry({ height: 32, width: 64 }), /minimum/);
});

test("stamping leaves the rest of the frame alone", () => {
  const width = 320;
  const height = 240;
  const untouched = frame(width, height, 0);
  const restamped = Buffer.from(untouched);

  applyFrameStamp(restamped, { frameIndex: 0, height, width });

  assert.deepEqual(restamped, untouched);
});
