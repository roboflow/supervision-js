/**
 * Owns prepared packets after their renderer has acquired native resources.
 *
 * A newly presented packet replaces `active`; the old active packet becomes
 * `retired` and is released only after one further successful presentation.
 * That one-packet grace period prevents Skia from drawing an image that was
 * disposed while its UI render still references the previous shared value.
 */
export class PreparedFrameStore<TPacket extends object> {
  __workletClass = true;
  private activePacket: TPacket | null = null;
  private retiredPacket: TPacket | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly releasedPackets = new WeakSet<object>();
  private readonly disposePacket: (packet: TPacket) => void | Promise<void>;

  constructor(disposePacket: (packet: TPacket) => void | Promise<void>) {
    "worklet";

    this.disposePacket = disposePacket;
  }

  get active() {
    "worklet";
    return this.activePacket;
  }

  /**
   * Transfers packet ownership to a fresh store, such as the next worklet
   * invocation. The source store is sealed without disposing those packets:
   * the returned snapshot is now their sole owner until `restore()` claims it.
   */
  snapshot() {
    "worklet";

    const snapshot = {
      active: this.activePacket,
      retired: this.retiredPacket,
    };

    this.activePacket = null;
    this.retiredPacket = null;
    this.disposed = true;

    return snapshot;
  }

  /** Restores a snapshot into a newly created single-writer worklet store. */
  restore(snapshot: {
    readonly active: TPacket | null;
    readonly retired: TPacket | null;
  }) {
    "worklet";

    if (this.disposed) {
      throw new Error("Cannot restore a disposed PreparedFrameStore.");
    }
    if (this.activePacket || this.retiredPacket) {
      throw new Error("Cannot restore over owned PreparedFrameStore packets.");
    }

    this.activePacket = snapshot.active;
    this.retiredPacket = snapshot.retired;
  }

  /**
   * Promotes a packet only after the renderer has presented it successfully.
   * The store is the single lifecycle writer: callers must not retain or
   * dispose packets once they pass them here.
   */
  async present(packet: TPacket) {
    if (this.disposed) {
      await this.release(packet);
      return;
    }

    await this.release(this.promote(packet));
  }

  /** Synchronous worklet variant for native render-handle disposal. */
  presentNow(packet: TPacket) {
    "worklet";

    if (this.disposed) {
      this.releaseNow(packet);
      return;
    }

    this.releaseNow(this.promote(packet));
  }

  /** Releases a prepared packet that never reached presentation. */
  async discard(packet: TPacket) {
    if (this.activePacket === packet || this.retiredPacket === packet) {
      return;
    }

    await this.release(packet);
  }

  /** Synchronous worklet variant for a packet that never reached the screen. */
  discardNow(packet: TPacket) {
    "worklet";

    if (this.activePacket !== packet && this.retiredPacket !== packet) {
      this.releaseNow(packet);
    }
  }

  /** Idempotently releases every packet still owned by the store. */
  dispose() {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    const activePacket = this.activePacket;
    const retiredPacket = this.retiredPacket;

    this.activePacket = null;
    this.retiredPacket = null;

    this.disposePromise = (async () => {
      const errors: unknown[] = [];

      for (const packet of [activePacket, retiredPacket]) {
        try {
          await this.release(packet);
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length > 0) {
        throw errors[0];
      }
    })();

    return this.disposePromise;
  }

  /** Synchronously releases all packets owned by a worklet store. */
  disposeNow() {
    "worklet";

    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const activePacket = this.activePacket;
    const retiredPacket = this.retiredPacket;

    this.activePacket = null;
    this.retiredPacket = null;
    let firstError: unknown = null;

    for (const packet of [activePacket, retiredPacket]) {
      try {
        this.releaseNow(packet);
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) {
      throw firstError;
    }
  }

  private promote(packet: TPacket) {
    const packetToDispose = this.retiredPacket;

    this.retiredPacket = this.activePacket;
    this.activePacket = packet;
    return packetToDispose;
  }

  private async release(packet: TPacket | null) {
    if (packet && !this.releasedPackets.has(packet)) {
      // Mark before calling into a native adapter: a disposal error cannot make
      // it safe to call a possibly destructive native release twice.
      this.releasedPackets.add(packet);
      await this.disposePacket(packet);
    }
  }

  private releaseNow(packet: TPacket | null) {
    if (!packet || this.releasedPackets.has(packet)) {
      return;
    }

    this.releasedPackets.add(packet);
    const result = this.disposePacket(packet);

    if (result && typeof (result as PromiseLike<void>).then === "function") {
      throw new Error(
        "PreparedFrameStore synchronous disposal received an async disposer.",
      );
    }
  }
}
