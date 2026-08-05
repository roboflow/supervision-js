import { describe, expect, it, vi } from "vitest";

import {
  createPreparedFramePacket,
  type PreparedFramePacket,
} from "./prepared-frame-packet";
import { PreparedFrameStore } from "./prepared-frame-store";

type RendererPacket = { readonly id: number };
type Packet = PreparedFramePacket<"frame", RendererPacket>;

function packet(id: number): Packet {
  return createPreparedFramePacket(
    id,
    {
      metadata: {
        duration: 1,
        frameIndex: id,
        height: 1,
        mediaTime: id,
        width: 1,
      },
      payload: "frame",
    },
    { detectionFrame: { detections: [], mediaTime: id } },
    { id },
  );
}

describe("PreparedFrameStore", () => {
  it("keeps one retired packet alive before releasing it", async () => {
    const dispose = vi.fn();
    const store = new PreparedFrameStore((next: Packet) =>
      dispose(next.packetId),
    );
    const first = packet(1);
    const second = packet(2);
    const third = packet(3);

    await store.present(first);
    await store.present(second);
    expect(dispose).not.toHaveBeenCalled();

    await store.present(third);
    expect(dispose).toHaveBeenCalledWith(1);
    expect(store.active?.packetId).toBe(3);

    await store.dispose();
    expect(dispose.mock.calls.map(([id]) => id)).toEqual([1, 3, 2]);
  });

  it("discards an unpresented packet without disturbing active ownership", async () => {
    const dispose = vi.fn();
    const store = new PreparedFrameStore((next: Packet) =>
      dispose(next.packetId),
    );
    const active = packet(1);
    const abandoned = packet(2);

    await store.present(active);
    await store.discard(abandoned);
    await store.discard(abandoned);

    expect(store.active).toBe(active);
    expect(dispose.mock.calls.map(([id]) => id)).toEqual([2]);
  });

  it("clears ownership before disposal, so repeated cleanup cannot double-release", async () => {
    const dispose = vi.fn();
    const store = new PreparedFrameStore((next: Packet) =>
      dispose(next.packetId),
    );

    await store.present(packet(1));
    await store.present(packet(2));
    await store.dispose();
    await store.dispose();

    expect(dispose.mock.calls.map(([id]) => id)).toEqual([2, 1]);
  });

  it("continues cleanup after one packet fails to release", async () => {
    const dispose = vi.fn((next: Packet) => {
      if (next.packetId === 2) {
        throw new Error("release failed");
      }
    });
    const store = new PreparedFrameStore(dispose);

    await store.present(packet(1));
    await store.present(packet(2));
    await expect(store.dispose()).rejects.toThrow("release failed");
    expect(dispose.mock.calls.map(([next]) => next.packetId)).toEqual([2, 1]);
  });

  it("restores worklet-owned packets and disposes them synchronously", () => {
    const dispose = vi.fn();
    const initial = new PreparedFrameStore((next: Packet) =>
      dispose(next.packetId),
    );

    initial.presentNow(packet(1));
    initial.presentNow(packet(2));
    const resumed = new PreparedFrameStore((next: Packet) =>
      dispose(next.packetId),
    );

    resumed.restore(initial.snapshot());
    resumed.presentNow(packet(3));
    resumed.disposeNow();

    expect(dispose.mock.calls.map(([id]) => id)).toEqual([1, 3, 2]);
  });
});
