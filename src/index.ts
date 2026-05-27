export type MediaRendererProofFit = "contain" | "cover";

export type MediaRendererProofPlaybackState =
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "error"
  | "destroyed";

export type MediaSourceProbeStatus =
  | "loading"
  | "ready"
  | "error"
  | "destroyed";

type RenderEnginePreference = "webgl";

export interface MediaFrameDiagnostics {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly expectedDisplayTime: null;
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
}

export interface MediaSourceProbeState {
  readonly status: MediaSourceProbeStatus;
  readonly canRead: boolean | null;
  readonly formatName: string | null;
  readonly formatMimeType: string | null;
  readonly mimeType: string | null;
  readonly duration: number | null;
  readonly trackCount: number | null;
  readonly videoTrackCount: number | null;
  readonly audioTrackCount: number | null;
  readonly primaryVideoWidth: number | null;
  readonly primaryVideoHeight: number | null;
  readonly errorMessage: string | null;
}

export interface MediaRendererProofState {
  readonly playbackState: MediaRendererProofPlaybackState;
  readonly fit: MediaRendererProofFit;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly presentedFrames: number;
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
  readonly source: MediaSourceProbeState;
}

export interface MediaRendererProofOverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor?: number;
  readonly strokeAlpha?: number;
  readonly strokeWidth?: number;
}

export interface MediaRendererProofOverlayFrame {
  readonly mediaTime: number;
  readonly rects: readonly MediaRendererProofOverlayRect[];
}

export interface MediaRendererProofOptions {
  readonly container: HTMLElement;
  readonly src: string;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  /**
   * No-op in the current video-only Mediabunny proof. Audio playback is deferred.
   */
  readonly muted?: boolean;
  readonly fit?: MediaRendererProofFit;
  readonly overlayFrames?: readonly MediaRendererProofOverlayFrame[];
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceProbeState) => void;
}

export interface MediaRendererProof {
  play(): Promise<void>;
  pause(): void;
  getState(): MediaRendererProofState;
  destroy(): void;
}

type DecodedVideoSample = {
  readonly timestamp: number;
  readonly duration: number;
  draw(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void;
  close(): void;
};

type DecodedVideoSampleSink = {
  getSample(
    timestamp: number,
    options?: { skipLiveWait?: boolean },
  ): Promise<DecodedVideoSample | null>;
  samples(
    startTimestamp?: number,
    endTimestamp?: number,
    options?: { skipLiveWait?: boolean },
  ): AsyncGenerator<DecodedVideoSample, void, unknown>;
};

type DisposableMediaInput = {
  dispose(): void;
};

type TextureUploadSource = {
  update(): void;
};

type TextureUpload = {
  update(): void;
};

const ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS = 1e-6;
const DEFAULT_OVERLAY_STROKE_ALPHA = 1;
const DEFAULT_OVERLAY_STROKE_COLOR = 0x00ff66;
const DEFAULT_OVERLAY_STROKE_WIDTH = 2;
const RENDER_ENGINE_PREFERENCE: RenderEnginePreference = "webgl";

function copySortedOverlayFrames(
  overlayFrames: readonly MediaRendererProofOverlayFrame[] | undefined,
): MediaRendererProofOverlayFrame[] {
  return (overlayFrames ?? [])
    .map((frame) => ({
      mediaTime: frame.mediaTime,
      rects: frame.rects.map((rect) => ({ ...rect })),
    }))
    .sort((left, right) => left.mediaTime - right.mediaTime);
}

/**
 * Experimental proof-only media renderer. Mediabunny owns media reading and
 * video decode; Pixi owns the visible renderer canvas and scene composition.
 * The internal staging canvas is only a texture upload surface and is never
 * appended to the DOM.
 */
export async function createMediaRendererProof(
  options: MediaRendererProofOptions,
): Promise<MediaRendererProof> {
  const fit = options.fit ?? "contain";
  const overlayFrames = copySortedOverlayFrames(options.overlayFrames);
  const { Application, CanvasSource, Container, Graphics, Sprite, Texture } =
    await import("pixi.js");
  const app = new Application();

  await app.init({
    autoDensity: true,
    backgroundColor: 0x111111,
    preference: RENDER_ENGINE_PREFERENCE,
    resizeTo: options.container,
    resolution: window.devicePixelRatio || 1,
  });

  const rendererCanvas = app.canvas;
  rendererCanvas.style.display = "block";
  rendererCanvas.style.height = "100%";
  rendererCanvas.style.width = "100%";
  options.container.appendChild(rendererCanvas);

  let playbackState: MediaRendererProofPlaybackState = "loading";
  let sourceState: MediaSourceProbeState = {
    audioTrackCount: null,
    canRead: null,
    duration: null,
    errorMessage: null,
    formatMimeType: null,
    formatName: null,
    mimeType: null,
    primaryVideoHeight: null,
    primaryVideoWidth: null,
    status: "loading",
    trackCount: null,
    videoTrackCount: null,
  };
  let currentTime = 0;
  let duration: number | null = null;
  let firstTimestamp = 0;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let presentedFrames = 0;
  let activeOverlayFrameTime: number | null = null;
  let activeOverlayRectCount = 0;
  let destroyed = false;
  let playbackRunId = 0;
  let playbackOriginMediaTime = 0;
  let playbackOriginNow = 0;
  let animationFrameHandle: number | undefined;
  let activeSampleIterator:
    | AsyncGenerator<DecodedVideoSample, void, unknown>
    | undefined;
  let mediaInput: DisposableMediaInput | undefined;
  let sampleSink: DecodedVideoSampleSink | undefined;
  let mediaScene: InstanceType<typeof Container> | undefined;
  let overlayGraphics: InstanceType<typeof Graphics> | undefined;
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;

  const emitSourceState = () => {
    options.onSource?.({ ...sourceState });
  };

  const setSourceState = (patch: Partial<MediaSourceProbeState>) => {
    sourceState = {
      ...sourceState,
      ...patch,
    };
    emitSourceState();
  };

  const setRenderError = (error: unknown) => {
    playbackState = "error";
    setSourceState({
      errorMessage:
        error instanceof Error ? error.message : "Media decode failed.",
      status: "error",
    });
  };

  const updateMediaSceneFit = () => {
    if (!mediaScene || mediaWidth <= 0 || mediaHeight <= 0) {
      return;
    }

    const screenWidth = app.screen.width || options.container.clientWidth;
    const screenHeight = app.screen.height || options.container.clientHeight;

    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const scale =
      fit === "cover"
        ? Math.max(screenWidth / mediaWidth, screenHeight / mediaHeight)
        : Math.min(screenWidth / mediaWidth, screenHeight / mediaHeight);

    mediaScene.scale.set(scale);
    mediaScene.position.set(
      (screenWidth - mediaWidth * scale) / 2,
      (screenHeight - mediaHeight * scale) / 2,
    );
  };

  const selectOverlayFrame = (mediaTime: number) => {
    let selectedFrame: MediaRendererProofOverlayFrame | undefined;
    let low = 0;
    let high = overlayFrames.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const frame = overlayFrames[middle];

      if (frame.mediaTime <= mediaTime) {
        selectedFrame = frame;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return selectedFrame;
  };

  const drawOverlayFrame = (mediaTime: number) => {
    const overlayFrame = selectOverlayFrame(mediaTime);

    activeOverlayFrameTime = overlayFrame?.mediaTime ?? null;
    activeOverlayRectCount = overlayFrame?.rects.length ?? 0;
    overlayGraphics?.clear();

    for (const rect of overlayFrame?.rects ?? []) {
      overlayGraphics?.rect(rect.x, rect.y, rect.width, rect.height).stroke({
        alpha: rect.strokeAlpha ?? DEFAULT_OVERLAY_STROKE_ALPHA,
        color: rect.strokeColor ?? DEFAULT_OVERLAY_STROKE_COLOR,
        width: rect.strokeWidth ?? DEFAULT_OVERLAY_STROKE_WIDTH,
      });
    }
  };

  const emitFrameDiagnostics = (sample: DecodedVideoSample) => {
    options.onFrame?.({
      activeOverlayFrameTime,
      activeOverlayRectCount,
      currentTime,
      duration,
      expectedDisplayTime: null,
      mediaHeight,
      mediaTime: sample.timestamp,
      mediaWidth,
      presentedFrames,
    });
  };

  const drawSample = (
    sample: DecodedVideoSample,
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) => {
    try {
      sample.draw(context, 0, 0, mediaWidth, mediaHeight);
      stagingTextureSource?.update();
      stagingTexture?.update();
      drawOverlayFrame(sample.timestamp);
      currentTime = sample.timestamp;
      presentedFrames += 1;
      updateMediaSceneFit();
      emitFrameDiagnostics(sample);
    } finally {
      sample.close();
    }
  };

  const cancelScheduledFrame = () => {
    if (animationFrameHandle !== undefined) {
      window.cancelAnimationFrame(animationFrameHandle);
      animationFrameHandle = undefined;
    }
  };

  const stopActiveIterator = () => {
    void activeSampleIterator?.return?.();
    activeSampleIterator = undefined;
  };

  const stagingCanvas = document.createElement("canvas");
  const stagingContext = stagingCanvas.getContext("2d");

  if (!stagingContext) {
    throw new Error("Unable to create staging canvas context.");
  }

  const isPlaybackRunActive = (runId: number) =>
    !destroyed && playbackRunId === runId && playbackState === "playing";

  const schedulePlaybackFrame = (runId: number) => {
    if (!isPlaybackRunActive(runId) || animationFrameHandle !== undefined) {
      return;
    }

    animationFrameHandle = window.requestAnimationFrame((now) => {
      animationFrameHandle = undefined;
      void decodePlaybackFrame(runId, now);
    });
  };

  const decodePlaybackFrame = async (runId: number, now: number) => {
    if (!sampleSink) {
      return;
    }

    if (!isPlaybackRunActive(runId)) {
      return;
    }

    let requestedMediaTime =
      playbackOriginMediaTime + (now - playbackOriginNow) / 1000;
    const playableEnd =
      duration === null ? null : firstTimestamp + Math.max(duration, 0);
    let shouldPresentLoopStartSample = false;

    if (playableEnd !== null && requestedMediaTime >= playableEnd) {
      if (options.loop === false) {
        playbackState = "paused";
        return;
      }

      currentTime = firstTimestamp;
      playbackOriginMediaTime = firstTimestamp;
      playbackOriginNow = now;
      requestedMediaTime = firstTimestamp;
      shouldPresentLoopStartSample = true;
    }

    try {
      const sample = await sampleSink.getSample(requestedMediaTime, {
        skipLiveWait: true,
      });

      if (!isPlaybackRunActive(runId)) {
        sample?.close();
        return;
      }

      if (
        sample &&
        (sample.timestamp >
          currentTime + ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS ||
          (shouldPresentLoopStartSample &&
            Math.abs(sample.timestamp - firstTimestamp) <=
              ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS))
      ) {
        drawSample(sample, stagingContext);
      } else {
        sample?.close();
      }
    } catch (error) {
      if (!destroyed && playbackRunId === runId) {
        setRenderError(error);
      }
      return;
    }

    schedulePlaybackFrame(runId);
  };

  const proof: MediaRendererProof = {
    async play() {
      if (destroyed) {
        throw new Error("Media renderer proof has been destroyed.");
      }

      if (playbackState === "error") {
        throw new Error(
          sourceState.errorMessage ?? "Media renderer is in error state.",
        );
      }

      if (!sampleSink) {
        throw new Error("Media renderer proof is not ready.");
      }

      if (playbackState === "playing") {
        return;
      }

      playbackState = "playing";
      playbackRunId += 1;
      playbackOriginMediaTime = currentTime;
      playbackOriginNow = performance.now();
      schedulePlaybackFrame(playbackRunId);
    },

    pause() {
      if (destroyed || playbackState !== "playing") {
        return;
      }

      playbackState = "paused";
      playbackRunId += 1;
      cancelScheduledFrame();
    },

    getState() {
      return {
        currentTime,
        duration,
        fit,
        mediaHeight,
        mediaWidth,
        playbackState,
        presentedFrames,
        activeOverlayFrameTime,
        activeOverlayRectCount,
        source: { ...sourceState },
      };
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      playbackState = "destroyed";
      playbackRunId += 1;
      cancelScheduledFrame();
      stopActiveIterator();
      mediaInput?.dispose();
      mediaInput = undefined;
      setSourceState({ status: "destroyed" });
      app.ticker.remove(updateMediaSceneFit);
      app.destroy(
        { removeView: true },
        {
          children: true,
          texture: true,
          textureSource: true,
        },
      );
    },
  };

  app.ticker.add(updateMediaSceneFit);
  emitSourceState();

  try {
    const { Input, MATROSKA, MP4, QTFF, UrlSource, VideoSampleSink, WEBM } =
      await import("mediabunny");
    const input = new Input({
      formats: [MP4, QTFF, WEBM, MATROSKA],
      source: new UrlSource(options.src),
    });

    mediaInput = input;

    if (destroyed) {
      input.dispose();
      return proof;
    }

    const canRead = await input.canRead();

    if (!canRead) {
      throw new Error("Mediabunny cannot read this media source.");
    }

    const [
      format,
      mimeType,
      metadataDuration,
      tracks,
      videoTracks,
      audioTracks,
    ] = await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
      input.getTracks(),
      input.getVideoTracks(),
      input.getAudioTracks(),
    ]);
    const primaryVideoTrack = await input.getPrimaryVideoTrack();

    if (!primaryVideoTrack) {
      throw new Error("No video track found in media source.");
    }

    const [displayWidth, displayHeight, trackFirstTimestamp] =
      await Promise.all([
        primaryVideoTrack.getDisplayWidth(),
        primaryVideoTrack.getDisplayHeight(),
        primaryVideoTrack.getFirstTimestamp(),
      ]);

    mediaWidth = displayWidth;
    mediaHeight = displayHeight;
    duration = metadataDuration;
    firstTimestamp = trackFirstTimestamp;
    stagingCanvas.width = mediaWidth;
    stagingCanvas.height = mediaHeight;

    const canvasSource = new CanvasSource({
      dynamic: true,
      height: mediaHeight,
      resource: stagingCanvas,
      width: mediaWidth,
    });
    const texture = new Texture({
      dynamic: true,
      source: canvasSource,
    });
    const scene = new Container();
    const mediaSprite = new Sprite({ texture });
    const overlays = new Graphics();

    mediaSprite.width = mediaWidth;
    mediaSprite.height = mediaHeight;
    scene.addChild(mediaSprite, overlays);
    app.stage.addChild(scene);
    mediaScene = scene;
    overlayGraphics = overlays;
    stagingTextureSource = canvasSource;
    stagingTexture = texture;
    sampleSink = new VideoSampleSink(primaryVideoTrack);

    setSourceState({
      audioTrackCount: audioTracks.length,
      canRead,
      duration,
      errorMessage: null,
      formatMimeType: format.mimeType,
      formatName: format.name,
      mimeType,
      primaryVideoHeight: mediaHeight,
      primaryVideoWidth: mediaWidth,
      status: "ready",
      trackCount: tracks.length,
      videoTrackCount: videoTracks.length,
    });

    const firstSampleIterator = sampleSink.samples(firstTimestamp, undefined, {
      skipLiveWait: true,
    });
    activeSampleIterator = firstSampleIterator;
    const firstSampleResult = await firstSampleIterator.next();
    await firstSampleIterator.return?.();
    activeSampleIterator = undefined;

    if (firstSampleResult.done) {
      throw new Error("No decoded video samples were produced.");
    }

    drawSample(firstSampleResult.value, stagingContext);
    playbackState = "ready";

    if (options.autoPlay ?? true) {
      await proof.play();
    }
  } catch (error) {
    if (!destroyed) {
      setRenderError(error);
    }
  }

  return proof;
}
