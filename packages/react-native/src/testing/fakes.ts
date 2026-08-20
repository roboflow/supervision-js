import {
  MediaSessionMode,
  type DetectionPickResult,
  type MediaRendererPresentation,
  type MediaTimelineMetadata,
  type PlatformMediaFrame,
} from "supervision-js-core";

import type {
  MediaFrameSource,
  MediaFrameSourceConsumer,
  MediaSessionCapabilities,
} from "../types/frame-source";
import type {
  AsyncMediaRendererAdapter,
  MediaRendererPrepareOptions,
  SyncMediaRendererAdapter,
} from "../types/renderer";

export interface FakePreparedPacket {
  readonly id: number;
}

export class FakeMediaFrameSource<
  TPayload,
> implements MediaFrameSource<TPayload> {
  readonly capabilities: MediaSessionCapabilities;
  readonly mode: MediaSessionMode;
  readonly timeline: MediaTimelineMetadata;
  destroyed = false;
  opened = false;
  paused = false;
  resumed = false;
  stopped = false;
  lastSeek: number | null = null;
  private consumer: MediaFrameSourceConsumer<TPayload> | null = null;

  constructor(options?: {
    readonly capabilities?: Partial<MediaSessionCapabilities>;
    readonly mode?: MediaSessionMode;
    readonly timeline?: Partial<MediaTimelineMetadata>;
  }) {
    this.capabilities = {
      live: false,
      pausable: true,
      seekable: true,
      stoppable: true,
      ...options?.capabilities,
    };
    this.mode = options?.mode ?? MediaSessionMode.File;
    this.timeline = {
      duration: 1,
      frameRate: 30,
      height: 100,
      width: 100,
      ...options?.timeline,
    };
  }

  open() {
    this.opened = true;
  }

  start(consumer: MediaFrameSourceConsumer<TPayload>) {
    this.consumer = consumer;
  }

  async emit(frame: PlatformMediaFrame<TPayload>) {
    await this.requireConsumer().onFrame(frame);
  }

  end() {
    this.requireConsumer().onEnd();
  }

  fail(error: unknown) {
    this.requireConsumer().onError(error);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.resumed = true;
  }

  seek(mediaTime: number) {
    this.lastSeek = mediaTime;
  }

  stop() {
    this.stopped = true;
  }

  destroy() {
    this.destroyed = true;
  }

  private requireConsumer() {
    if (!this.consumer) {
      throw new Error("Fake media source has not started.");
    }

    return this.consumer;
  }
}

export class FakeMediaRenderer<TPayload> implements AsyncMediaRendererAdapter<
  TPayload,
  FakePreparedPacket
> {
  readonly backend = "fake";
  destroyed = false;
  disposedPacketIds: number[] = [];
  presentedPacketIds: number[] = [];
  prepared: MediaRendererPrepareOptions<TPayload>[] = [];
  presentation: MediaRendererPresentation | null = null;
  pickResult: DetectionPickResult | null = null;

  prepare(
    options: MediaRendererPrepareOptions<TPayload>,
  ): FakePreparedPacket | Promise<FakePreparedPacket> {
    this.prepared.push(options);
    return { id: options.packetId };
  }

  present(packet: FakePreparedPacket) {
    this.presentedPacketIds.push(packet.id);
  }

  disposePacket(packet: FakePreparedPacket) {
    this.disposedPacketIds.push(packet.id);
  }

  setPresentation(presentation: MediaRendererPresentation) {
    this.presentation = presentation;
  }

  pick() {
    return this.pickResult;
  }

  destroy() {
    this.destroyed = true;
  }
}

/**
 * Worklet-callable renderer fake: every per-frame method returns directly, so
 * a session can drive it without a Promise anywhere on the frame path.
 */
export class FakeSyncMediaRenderer<
  TPayload,
> implements SyncMediaRendererAdapter<TPayload, FakePreparedPacket> {
  readonly sync = true as const;
  readonly backend = "fake-sync";
  destroyed = false;
  disposedPacketIds: number[] = [];
  presentedPacketIds: number[] = [];
  prepared: MediaRendererPrepareOptions<TPayload>[] = [];
  presentation: MediaRendererPresentation | null = null;
  pickResult: DetectionPickResult | null = null;
  onPrepare: (() => void) | null = null;
  onPresent: (() => void) | null = null;

  prepare(options: MediaRendererPrepareOptions<TPayload>): FakePreparedPacket {
    this.onPrepare?.();
    this.prepared.push(options);
    return { id: options.packetId };
  }

  present(packet: FakePreparedPacket): void {
    this.onPresent?.();
    this.presentedPacketIds.push(packet.id);
  }

  disposePacket(packet: FakePreparedPacket): void {
    this.disposedPacketIds.push(packet.id);
  }

  setPresentation(presentation: MediaRendererPresentation) {
    this.presentation = presentation;
  }

  pick() {
    return this.pickResult;
  }

  destroy() {
    this.destroyed = true;
  }
}
