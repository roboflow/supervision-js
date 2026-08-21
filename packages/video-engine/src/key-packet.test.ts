import { describe, expect, it } from "vitest";

import {
  KeyPacketRequirement,
  nalPrefixWidth,
  openingKeyPacket,
} from "./key-packet";

/** The recovery-point SEI NAL itself, without any length prefix. */
const SEI_NAL = [0x06, 0x06, 0x01, 0xc2, 0x80];

/** Two AVCC-framed NALs: an SPS and a non-IDR slice, standing in for a packet. */
const PACKET = Uint8Array.of(
  0x00,
  0x00,
  0x00,
  0x04,
  0x67,
  0x42,
  0x40,
  0x33,
  0x00,
  0x00,
  0x00,
  0x03,
  0x41,
  0x9a,
  0x02,
);

/** One NAL of each type the opening chunk is assembled from, first byte naming
 *  the type in its low five bits. */
const AUD_NAL = [0x09, 0x30];
const SPS_NAL = [0x67, 0x42, 0x40, 0x33];
const SLICE_NAL = [0x41, 0x9a, 0x02];
/** A scalable-extension NAL (type 20). */
const EXTENSION_NAL = [0x14, 0x80, 0x00];

/** NALs framed at the four-byte AVCC width, as a packet carries them. */
function framed4(units: number[][]): Uint8Array {
  const out: number[] = [];
  for (const unit of units) out.push(0x00, 0x00, 0x00, unit.length, ...unit);
  return Uint8Array.from(out);
}

/**
 * The first five bytes of an avcC record: version, profile, compatibility,
 * level, then the byte whose low two bits carry lengthSizeMinusOne behind six
 * reserved set bits.
 */
function avcc(lengthSizeMinusOne: number): Uint8Array {
  return Uint8Array.of(1, 0x42, 0x40, 0x33, 0b1111_1100 | lengthSizeMinusOne);
}

function bytes(source: Uint8Array): number[] {
  return Array.from(source);
}

describe("nalPrefixWidth", () => {
  it("reads each width the avcC record can name", () => {
    expect(nalPrefixWidth(avcc(0))).toBe(1);
    expect(nalPrefixWidth(avcc(1))).toBe(2);
    expect(nalPrefixWidth(avcc(3))).toBe(4);
  });

  it("rejects the reserved lengthSizeMinusOne encoding", () => {
    expect(nalPrefixWidth(avcc(2))).toBeNull();
  });

  it("rejects a description too short to hold the width byte", () => {
    expect(nalPrefixWidth(Uint8Array.of(1, 0x42, 0x40, 0x33))).toBeNull();
  });

  it("rejects a missing description", () => {
    expect(nalPrefixWidth(undefined)).toBeNull();
  });

  it("reads a record handed over as a raw ArrayBuffer", () => {
    const record = avcc(1);
    expect(nalPrefixWidth(record.buffer.slice(0, record.length))).toBe(2);
  });

  it("reads a record viewed at a non-zero byte offset", () => {
    const padded = Uint8Array.of(0xff, 0xff, ...avcc(0));
    expect(nalPrefixWidth(padded.subarray(2))).toBe(1);
  });
});

describe("openingKeyPacket", () => {
  it("frames the SEI at a two-byte width byte for byte", () => {
    const framed = openingKeyPacket(PACKET, 2);
    expect(bytes(framed)).toEqual([0x00, 0x05, ...SEI_NAL, ...bytes(PACKET)]);
    expect(framed.length).toBe(2 + SEI_NAL.length + PACKET.length);
  });

  it("frames the SEI at a one-byte width byte for byte", () => {
    const framed = openingKeyPacket(PACKET, 1);
    expect(bytes(framed)).toEqual([0x05, ...SEI_NAL, ...bytes(PACKET)]);
    expect(framed.length).toBe(1 + SEI_NAL.length + PACKET.length);
  });

  it("frames the SEI at a four-byte width byte for byte", () => {
    const framed = openingKeyPacket(PACKET, 4);
    expect(bytes(framed)).toEqual([
      0x00,
      0x00,
      0x00,
      0x05,
      ...SEI_NAL,
      ...bytes(PACKET),
    ]);
    expect(framed.length).toBe(4 + SEI_NAL.length + PACKET.length);
  });

  it("writes the length big-endian across every width", () => {
    for (const width of [1, 2, 4]) {
      const framed = openingKeyPacket(PACKET, width);
      const prefix = bytes(framed.subarray(0, width));
      expect(prefix.slice(0, width - 1)).toEqual(new Array(width - 1).fill(0));
      expect(prefix[width - 1]).toBe(SEI_NAL.length);
    }
  });

  it("preserves the packet bytes after the SEI at any width", () => {
    for (const width of [1, 2, 4]) {
      const framed = openingKeyPacket(PACKET, width);
      expect(bytes(framed.subarray(width + SEI_NAL.length))).toEqual(
        bytes(PACKET),
      );
    }
  });

  it("puts the SEI behind an access unit delimiter, which has to come first", () => {
    const packet = framed4([AUD_NAL, SLICE_NAL]);
    expect(bytes(openingKeyPacket(packet, 4))).toEqual(
      bytes(framed4([AUD_NAL, SEI_NAL, SLICE_NAL])),
    );
  });

  it("puts the SEI at the head of an access unit that has no delimiter", () => {
    const packet = framed4([SPS_NAL, SLICE_NAL]);
    expect(bytes(openingKeyPacket(packet, 4))).toEqual(
      bytes(framed4([SEI_NAL, SPS_NAL, SLICE_NAL])),
    );
  });

  it("drops the scalable-extension NALs the base-layer decode cannot read", () => {
    const packet = framed4([AUD_NAL, EXTENSION_NAL, SPS_NAL, SLICE_NAL]);
    expect(bytes(openingKeyPacket(packet, 4))).toEqual(
      bytes(framed4([AUD_NAL, SEI_NAL, SPS_NAL, SLICE_NAL])),
    );
  });

  it("keeps every access unit in a packet that carries more than one", () => {
    const packet = framed4([AUD_NAL, SLICE_NAL, AUD_NAL, SLICE_NAL]);
    expect(bytes(openingKeyPacket(packet, 4))).toEqual(
      bytes(framed4([AUD_NAL, SEI_NAL, SLICE_NAL, AUD_NAL, SLICE_NAL])),
    );
  });

  it("leaves a packet whose framing does not walk out whole byte for byte", () => {
    // Four-byte-framed bytes read at two, which is what a description naming
    // the wrong width would ask for.
    const packet = framed4([SPS_NAL, SLICE_NAL]);
    expect(bytes(openingKeyPacket(packet, 2))).toEqual([
      0x00,
      0x05,
      ...SEI_NAL,
      ...bytes(packet),
    ]);
  });
});

describe("KeyPacketRequirement", () => {
  it("carries the SEI on the packet that opens the session", () => {
    expect(bytes(new KeyPacketRequirement(2).satisfy(PACKET))).toEqual([
      0x00,
      0x05,
      ...SEI_NAL,
      ...bytes(PACKET),
    ]);
  });

  it("frames that SEI at the width it was built with", () => {
    expect(bytes(new KeyPacketRequirement(1).satisfy(PACKET))).toEqual([
      0x05,
      ...SEI_NAL,
      ...bytes(PACKET),
    ]);
    expect(bytes(new KeyPacketRequirement(4).satisfy(PACKET))).toEqual([
      0x00,
      0x00,
      0x00,
      0x05,
      ...SEI_NAL,
      ...bytes(PACKET),
    ]);
  });

  it("passes every later packet through untouched", () => {
    const requirement = new KeyPacketRequirement(2);
    requirement.satisfy(PACKET);
    expect(bytes(requirement.satisfy(PACKET))).toEqual(bytes(PACKET));
    expect(bytes(requirement.satisfy(PACKET))).toEqual(bytes(PACKET));
  });

  it("carries the SEI again once a flush re-arms it", () => {
    const requirement = new KeyPacketRequirement(2);
    requirement.satisfy(PACKET);
    requirement.rearm();
    expect(bytes(requirement.satisfy(PACKET))).toEqual([
      0x00,
      0x05,
      ...SEI_NAL,
      ...bytes(PACKET),
    ]);
  });
});
