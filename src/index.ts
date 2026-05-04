export enum MediaRendererProofFit {
  Contain = "contain",
  Cover = "cover",
}

export enum MediaRendererProofPlaybackState {
  Loading = "loading",
  Ready = "ready",
  Playing = "playing",
  Paused = "paused",
  Error = "error",
  Destroyed = "destroyed",
}

export enum RenderEnginePreference {
  WebGL = "webgl",
}

export interface MediaFrameDiagnostics {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly expectedDisplayTime: null;
}

export interface MediaDemuxProbeState {
  readonly status: MediaRendererProofPlaybackState;
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
  readonly demux: MediaDemuxProbeState;
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
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onDemux?: (state: MediaDemuxProbeState) => void;
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

/**
 * Experimental proof-only media renderer. Mediabunny owns media reading and
 * video decode; Pixi owns the visible renderer canvas and scene composition.
 * The internal staging canvas is only a texture upload surface and is never
 * appended to the DOM.
 */
export async function createMediaRendererProof(
  options: MediaRendererProofOptions,
): Promise<MediaRendererProof> {
  const fit = options.fit ?? MediaRendererProofFit.Contain;
  const { Application, CanvasSource, Sprite, Texture } =
    await import("pixi.js");
  const app = new Application();

  await app.init({
    autoDensity: true,
    backgroundColor: 0x111111,
    preference: RenderEnginePreference.WebGL,
    resizeTo: options.container,
    resolution: window.devicePixelRatio || 1,
  });

  const rendererCanvas = app.canvas;
  rendererCanvas.style.display = "block";
  rendererCanvas.style.height = "100%";
  rendererCanvas.style.width = "100%";
  options.container.appendChild(rendererCanvas);

  let playbackState: MediaRendererProofPlaybackState =
    MediaRendererProofPlaybackState.Loading;
  let demuxState: MediaDemuxProbeState = {
    audioTrackCount: null,
    canRead: null,
    duration: null,
    errorMessage: null,
    formatMimeType: null,
    formatName: null,
    mimeType: null,
    primaryVideoHeight: null,
    primaryVideoWidth: null,
    status: MediaRendererProofPlaybackState.Loading,
    trackCount: null,
    videoTrackCount: null,
  };
  let currentTime = 0;
  let duration: number | null = null;
  let firstTimestamp = 0;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let presentedFrames = 0;
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
  let sprite: InstanceType<typeof Sprite> | undefined;
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;

  const emitDemuxState = () => {
    options.onDemux?.({ ...demuxState });
  };

  const setDemuxState = (patch: Partial<MediaDemuxProbeState>) => {
    demuxState = {
      ...demuxState,
      ...patch,
    };
    emitDemuxState();
  };

  const setRenderError = (error: unknown) => {
    playbackState = MediaRendererProofPlaybackState.Error;
    setDemuxState({
      errorMessage:
        error instanceof Error ? error.message : "Media decode failed.",
      status: MediaRendererProofPlaybackState.Error,
    });
  };

  const updateSpriteFit = () => {
    if (!sprite || mediaWidth <= 0 || mediaHeight <= 0) {
      return;
    }

    const screenWidth = app.screen.width || options.container.clientWidth;
    const screenHeight = app.screen.height || options.container.clientHeight;

    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const scale =
      fit === MediaRendererProofFit.Cover
        ? Math.max(screenWidth / mediaWidth, screenHeight / mediaHeight)
        : Math.min(screenWidth / mediaWidth, screenHeight / mediaHeight);

    sprite.width = mediaWidth * scale;
    sprite.height = mediaHeight * scale;
    sprite.position.set(screenWidth / 2, screenHeight / 2);
  };

  const emitFrameDiagnostics = (sample: DecodedVideoSample) => {
    options.onFrame?.({
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
      currentTime = sample.timestamp;
      presentedFrames += 1;
      updateSpriteFit();
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
    !destroyed &&
    playbackRunId === runId &&
    playbackState === MediaRendererProofPlaybackState.Playing;

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

    if (playableEnd !== null && requestedMediaTime >= playableEnd) {
      if (options.loop === false) {
        playbackState = MediaRendererProofPlaybackState.Paused;
        return;
      }

      currentTime = firstTimestamp;
      playbackOriginMediaTime = firstTimestamp;
      playbackOriginNow = now;
      requestedMediaTime = firstTimestamp;
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
        sample.timestamp >
          currentTime + ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS
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
          demuxState.errorMessage ?? "Media renderer is in error state.",
        );
      }

      if (!sampleSink) {
        throw new Error("Media renderer proof is not ready.");
      }

      if (playbackState === "playing") {
        return;
      }

      playbackState = MediaRendererProofPlaybackState.Playing;
      playbackRunId += 1;
      playbackOriginMediaTime = currentTime;
      playbackOriginNow = performance.now();
      schedulePlaybackFrame(playbackRunId);
    },

    pause() {
      if (destroyed || playbackState !== "playing") {
        return;
      }

      playbackState = MediaRendererProofPlaybackState.Paused;
      playbackRunId += 1;
      cancelScheduledFrame();
    },

    getState() {
      return {
        currentTime,
        demux: { ...demuxState },
        duration,
        fit,
        mediaHeight,
        mediaWidth,
        playbackState,
        presentedFrames,
      };
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      playbackState = MediaRendererProofPlaybackState.Destroyed;
      playbackRunId += 1;
      cancelScheduledFrame();
      stopActiveIterator();
      mediaInput?.dispose();
      mediaInput = undefined;
      setDemuxState({ status: MediaRendererProofPlaybackState.Destroyed });
      app.ticker.remove(updateSpriteFit);
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

  app.ticker.add(updateSpriteFit);
  emitDemuxState();

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
    const mediaSprite = new Sprite({ texture });
    mediaSprite.anchor.set(0.5);
    app.stage.addChild(mediaSprite);
    sprite = mediaSprite;
    stagingTextureSource = canvasSource;
    stagingTexture = texture;
    sampleSink = new VideoSampleSink(primaryVideoTrack);

    setDemuxState({
      audioTrackCount: audioTracks.length,
      canRead,
      duration,
      errorMessage: null,
      formatMimeType: format.mimeType,
      formatName: format.name,
      mimeType,
      primaryVideoHeight: mediaHeight,
      primaryVideoWidth: mediaWidth,
      status: MediaRendererProofPlaybackState.Ready,
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
    playbackState = MediaRendererProofPlaybackState.Ready;

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
