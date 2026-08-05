import type {
  DetectionPickOptions,
  DetectionPickResult,
  MediaRendererPresentation,
  MediaSessionLifecycleState,
  MediaSessionStateListener as CoreMediaSessionStateListener,
  MediaSessionStateUnsubscribe as CoreMediaSessionStateUnsubscribe,
  MediaTimelineMetadata,
} from "supervision-js-core";

import type { MediaFrameProcessor } from "./frame-processor";
import type {
  MediaFrameSource,
  MediaSessionCapabilities,
} from "./frame-source";
import type {
  MediaRendererAdapter,
  MediaSessionRendererState,
  MediaSessionRenderPreparationState,
} from "./renderer";

export type MediaSessionErrorCode =
  | "destroyed"
  | "processor-failed"
  | "renderer-failed"
  | "source-failed"
  | "source-open-failed"
  | "unsupported-operation";

/** Stable error shape for host UI, logs, and tests. */
export class MediaSessionError extends Error {
  readonly code: MediaSessionErrorCode;

  constructor(
    code: MediaSessionErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "MediaSessionError";
    this.code = code;
  }
}

export interface MediaSessionMediaState {
  readonly capabilities: MediaSessionCapabilities;
  readonly opened: boolean;
  readonly timeline: MediaTimelineMetadata;
}

export type MediaSessionState = MediaSessionLifecycleState<
  MediaSessionMediaState,
  MediaSessionRendererState,
  null,
  MediaSessionRenderPreparationState
>;

export type MediaSessionStateListener =
  CoreMediaSessionStateListener<MediaSessionState>;
export type MediaSessionStateUnsubscribe = CoreMediaSessionStateUnsubscribe;

export interface MediaSessionOptions<TPayload, TPacket extends object> {
  readonly onState?: MediaSessionStateListener;
  readonly presentation?: MediaRendererPresentation;
  readonly processor: MediaFrameProcessor<TPayload>;
  readonly renderer: MediaRendererAdapter<TPayload, TPacket>;
  readonly source: MediaFrameSource<TPayload>;
}

/**
 * One mobile media item. The session owns source-to-renderer orchestration;
 * the host owns application UI, model selection, persistence, and undo.
 */
export interface MediaSession {
  readonly capabilities: MediaSessionCapabilities;
  readonly timeline: MediaTimelineMetadata;
  getState(): MediaSessionState;
  pause(): void;
  pick(
    point: { readonly x: number; readonly y: number },
    options?: DetectionPickOptions,
  ): DetectionPickResult | null;
  play(): Promise<void>;
  seek(mediaTime: number): Promise<void>;
  setPresentation(presentation: MediaRendererPresentation): void;
  stop(): void;
  subscribe(listener: MediaSessionStateListener): MediaSessionStateUnsubscribe;
  destroy(): Promise<void>;
}
