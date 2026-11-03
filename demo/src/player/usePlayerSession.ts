import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefCallback,
} from "react";
import {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSessionMode,
  createMediaSession,
  createWebVideoEngineMediaRendererSource,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSession,
  type MediaSessionState,
} from "supervision";
import type { FrameTimelineData } from "supervision/web-video-engine";

import {
  createPresentedFrameTap,
  presentedRateWindowMs,
} from "../diagnostics/presented-frame-tap";
import {
  clearLiveReadouts,
  publishLiveRendererState,
} from "../hooks/live-readouts";
import {
  createDemoStage,
  createThrottledPublisher,
} from "../hooks/useDemoRenderer";
import { readDemoDisplayBox } from "../session/decode-resolution";
import type { DemoMediaState } from "../session/demo-session-types";
import { tapFrameTimeline } from "../session/frame-timeline-source";
import { defaultPlaybackRate } from "../session/playback-rate";
import {
  defaultDemoRenderQuality,
  getDemoMaxDevicePixelRatio,
} from "../session/render-quality";
import { toEngineSource, type PlayerSource } from "./player-source";

/** React hears about the renderer at most this often; the timeline and the
 *  timecode read the live readouts, which move every presented frame. */
const READOUT_INTERVAL_MS = 250;

export interface PlayerSessionState {
  readonly canUseRenderer: boolean;
  readonly containerRef: RefCallback<HTMLDivElement>;
  readonly duration: number | null;
  readonly errorMessage: string | null;
  readonly frameTimeline: FrameTimelineData | null;
  readonly mediaState: DemoMediaState;
  readonly playbackRate: number;
  readonly playbackState: MediaRendererPlaybackState | null;
  /** Media seconds the picture covered per wall second, as measured. */
  readonly presentedRate: number | null;
  readonly rendererState: MediaRendererState | null;
  readonly sessionState: MediaSessionState | null;
  readonly onPause: () => void;
  readonly onPlay: () => void;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => Promise<void>;
  readonly onSetPlaybackRate: (rate: number) => void;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
}

/**
 * The workbench's player with nothing drawn over it: the same engine-backed
 * media session, opened with no detections and no presentation, so every frame
 * on screen is the video and every gesture goes straight to the engine.
 */
export function usePlayerSession(source: PlayerSource): PlayerSessionState {
  const [presentedFrameTap] = useState(() => createPresentedFrameTap());
  const [stageAttached, setStageAttached] = useState(false);
  const [stage] = useState(() =>
    createDemoStage(document.createElement("div"), () =>
      setStageAttached(true),
    ),
  );
  const rendererRef = useRef<MediaRenderer | null>(null);
  const seekRunRef = useRef(0);
  const rateChangedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sessionState, setSessionState] = useState<MediaSessionState | null>(
    null,
  );
  const [frameTimeline, setFrameTimeline] = useState<FrameTimelineData | null>(
    null,
  );
  const [presentedRate, setPresentedRate] = useState<number | null>(null);
  const [mediaState, setMediaState] = useState<DemoMediaState>({
    errorMessage: null,
    status: "Opening video",
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // A window straddling a rate change measures neither rate.
  const readSettledPresentedRate = useCallback(
    () =>
      performance.now() - rateChangedAtRef.current >= presentedRateWindowMs
        ? presentedFrameTap.readRate()
        : null,
    [presentedFrameTap],
  );
  const syncRendererState = useCallback(
    (renderer: MediaRenderer) => {
      const state = renderer.getState();

      publishLiveRendererState(state, readSettledPresentedRate());
      setRendererState(state);
    },
    [readSettledPresentedRate],
  );

  useEffect(() => {
    if (!stageAttached) {
      return;
    }

    const container = stage.host;
    let session: MediaSession | undefined;
    let cleanedUp = false;
    let lastPlaybackState: MediaRendererPlaybackState | null = null;
    const isActive = () => !cleanedUp;
    const rendererStatePublisher = createThrottledPublisher(
      (state: MediaRendererState) => {
        setRendererState(state);
        setPresentedRate(readSettledPresentedRate());
      },
      isActive,
      READOUT_INTERVAL_MS,
    );
    const sessionStatePublisher = createThrottledPublisher(
      setSessionState,
      isActive,
      READOUT_INTERVAL_MS,
    );
    // A paused step or seek emits exactly once, so a state change of the
    // transport goes to React at once rather than waiting out the throttle.
    const publishRendererState = (state: MediaRendererState) => {
      if (!isActive()) {
        return;
      }

      publishLiveRendererState(state, readSettledPresentedRate());

      if (state.playbackState !== lastPlaybackState) {
        lastPlaybackState = state.playbackState;
        rendererStatePublisher.publishNow(state);
        return;
      }

      rendererStatePublisher.publish(state);
    };

    container.replaceChildren();
    presentedFrameTap.reset();
    rendererRef.current = null;
    setErrorMessage(null);
    setFrameTimeline(null);
    setMediaState({ errorMessage: null, status: `Opening ${source.label}` });
    setPresentedRate(null);
    setRendererState(null);
    setSessionState(null);

    void (async () => {
      try {
        const opened = await createMediaSession({
          container,
          media: tapFrameTimeline(
            presentedFrameTap.tap(
              createWebVideoEngineMediaRendererSource({
                display: readDemoDisplayBox(
                  container,
                  defaultDemoRenderQuality,
                ),
                source: toEngineSource(source),
              }),
            ),
            setFrameTimeline,
          ),
          mode: MediaSessionMode.File,
          onState: sessionStatePublisher.publish,
          renderer: {
            autoPlay: false,
            fit: MediaRendererFit.Contain,
            loop: true,
            maxDevicePixelRatio: getDemoMaxDevicePixelRatio(
              defaultDemoRenderQuality,
            ),
            onFrame: () => {
              if (session) {
                publishRendererState(session.renderer.getState());
              }
            },
            onState: publishRendererState,
          },
        });

        if (!isActive()) {
          opened.destroy();
          return;
        }

        session = opened;
        rendererRef.current = opened.renderer;
        setMediaState({ errorMessage: null, status: "" });
        syncRendererState(opened.renderer);
        await opened.renderer.play().catch((error: unknown) => {
          if (isActive()) {
            setErrorMessage(readErrorMessage(error, "Unable to play video."));
          }
        });
      } catch (error: unknown) {
        if (!isActive()) {
          return;
        }

        const message = readErrorMessage(error, "Unable to open video.");

        setErrorMessage(message);
        setMediaState({
          errorMessage: message,
          status: "Could not open video",
        });
      }
    })();

    return () => {
      cleanedUp = true;
      rendererStatePublisher.cancel();
      sessionStatePublisher.cancel();
      clearLiveReadouts();
      rendererRef.current = null;
      session?.destroy();
    };
  }, [
    presentedFrameTap,
    readSettledPresentedRate,
    source,
    stage,
    stageAttached,
    syncRendererState,
  ]);

  const onTogglePlayback = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    void renderer
      .togglePlayback()
      .catch((error: unknown) =>
        setErrorMessage(readErrorMessage(error, "Unable to play video.")),
      )
      .finally(() => syncRendererState(renderer));
  }, [syncRendererState]);

  const onPlay = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    void renderer
      .play()
      .catch((error: unknown) =>
        setErrorMessage(readErrorMessage(error, "Unable to play video.")),
      )
      .finally(() => syncRendererState(renderer));
  }, [syncRendererState]);

  const onPause = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    renderer.pause();
    syncRendererState(renderer);
  }, [syncRendererState]);

  const onSeek = useCallback(
    async (time: number) => {
      const renderer = rendererRef.current;

      if (!renderer) {
        return;
      }

      const seekRunId = seekRunRef.current + 1;
      seekRunRef.current = seekRunId;

      try {
        await renderer.seek(time);
      } catch (error: unknown) {
        if (seekRunRef.current === seekRunId) {
          setErrorMessage(readErrorMessage(error, "Unable to seek video."));
        }
      } finally {
        if (seekRunRef.current === seekRunId) {
          syncRendererState(renderer);
        }
      }
    },
    [syncRendererState],
  );

  const onScrub = useCallback((time: number) => {
    rendererRef.current?.scrub(time);
  }, []);

  const onSetPlaybackRate = useCallback(
    (rate: number) => {
      const renderer = rendererRef.current;

      if (!renderer || renderer.getState().playbackRate === rate) {
        return;
      }

      renderer.setPlaybackRate(rate);
      rateChangedAtRef.current = performance.now();
      setPresentedRate(null);
      syncRendererState(renderer);
    },
    [syncRendererState],
  );

  const onStepFrame = useCallback(
    (direction: 1 | -1) => {
      const renderer = rendererRef.current;

      if (!renderer) {
        return;
      }

      const stepped =
        direction === 1 ? renderer.stepForward() : renderer.stepBackward();

      void stepped
        .catch((error: unknown) =>
          setErrorMessage(readErrorMessage(error, "Unable to step video.")),
        )
        .finally(() => syncRendererState(renderer));
    },
    [syncRendererState],
  );

  const playbackState = rendererState?.playbackState ?? null;

  return {
    canUseRenderer:
      rendererRef.current !== null &&
      rendererState !== null &&
      playbackState !== MediaRendererPlaybackState.Destroyed &&
      playbackState !== MediaRendererPlaybackState.Error,
    containerRef: stage.attach,
    duration: rendererState?.duration ?? null,
    errorMessage,
    frameTimeline,
    mediaState,
    onPause,
    onPlay,
    onScrub,
    onSeek,
    onSetPlaybackRate,
    onStepFrame,
    onTogglePlayback,
    playbackRate: rendererState?.playbackRate ?? defaultPlaybackRate,
    playbackState,
    presentedRate,
    rendererState,
    sessionState,
  };
}

function readErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
