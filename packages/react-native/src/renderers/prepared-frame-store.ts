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
  private readonly releasedPackets = new WeakSet<object>();

  constructor(
    private readonly disposePacket: (packet: TPacket) => void | Promise<void>,
  ) {
    "worklet";
  }

  get active() {
    "worklet";
    return this.activePacket;
  }

  /** Captures store ownership so a paused worklet can resume safely. */
  snapshot() {
    "worklet";

    return { active: this.activePacket, retired: this.retiredPacket };
  }

  /** Restores a snapshot into a newly created single-writer worklet store. */
  restore(snapshot: {
    readonly active: TPacket | null;
    readonly retired: TPacket | null;
  }) {
    "worklet";

    this.activePacket = snapshot.active;
    this.retiredPacket = snapshot.retired;
  }

  /**
   * Promotes a packet only after the renderer has presented it successfully.
   * The store is the single lifecycle writer: callers must not retain or
   * dispose packets once they pass them here.
   */
  async present(packet: TPacket) {
    await this.release(this.promote(packet));
  }

  /** Synchronous worklet variant for native render-handle disposal. */
  presentNow(packet: TPacket) {
    "worklet";

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
  async dispose() {
    const activePacket = this.activePacket;
    const retiredPacket = this.retiredPacket;

    this.activePacket = null;
    this.retiredPacket = null;

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
  }

  /** Synchronously releases all packets owned by a worklet store. */
  disposeNow() {
    "worklet";

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
