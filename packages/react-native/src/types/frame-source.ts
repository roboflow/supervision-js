import type {
  MediaSessionMode,
  MediaTimelineMetadata,
  PlatformMediaFrame,
} from "supervision-js-core";

/**
 * Operations a source can support. Hosts must consult these values instead of
 * inferring support from iOS/Android or from the source's implementation.
 */
export interface MediaSessionCapabilities {
  readonly live: boolean;
  readonly pausable: boolean;
  readonly seekable: boolean;
  readonly stoppable: boolean;
}

/** Callback surface a source uses to deliver frames and lifecycle changes. */
export interface MediaFrameSourceConsumer<TPayload> {
  onEnd(): void;
  onError(error: unknown): void;
  onFrame(frame: PlatformMediaFrame<TPayload>): void | Promise<void>;
}

/**
 * Platform adapter for a static frame, pull-driven file, or push-driven live
 * source. Implementations own vendor APIs; the session owns processing,
 * preparation, presentation, state, and teardown.
 */
export interface MediaFrameSource<TPayload> {
  readonly capabilities: MediaSessionCapabilities;
  readonly mode: MediaSessionMode;
  readonly timeline: MediaTimelineMetadata;
  open?(): void | Promise<void>;
  start(consumer: MediaFrameSourceConsumer<TPayload>): void | Promise<void>;
  pause?(): void;
  resume?(): void | Promise<void>;
  seek?(mediaTime: number): void | Promise<void>;
  stop?(): void;
  destroy?(): void | Promise<void>;
}
