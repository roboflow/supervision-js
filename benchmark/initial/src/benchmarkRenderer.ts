import {
  Application,
  CanvasSource,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import {
  Input,
  MATROSKA,
  MP4,
  QTFF,
  UrlSource,
  VideoSampleSink,
  WEBM,
} from "mediabunny";

export type BenchmarkFit = "contain" | "cover";

export type BenchmarkUpdateStrategy =
  | "static"
  | "static-cached"
  | "redraw-each-frame";

export type BenchmarkRenderStrategy = "graphics" | "particle-edges";

export type BenchmarkPlaybackState =
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "error"
  | "destroyed";

export type BenchmarkSourceProbeStatus =
  | "loading"
  | "ready"
  | "error"
  | "destroyed";

export interface BenchmarkOptions {
  readonly enabled?: boolean;
  readonly shapeCount?: number;
  readonly renderStrategy?: BenchmarkRenderStrategy;
  readonly updateStrategy?: BenchmarkUpdateStrategy;
}

export interface BenchmarkState {
  readonly enabled: boolean;
  readonly shapeCount: number;
  readonly renderStrategy: BenchmarkRenderStrategy;
  readonly renderedElementCount: number;
  readonly updateStrategy: BenchmarkUpdateStrategy;
  readonly textEnabled: false;
  readonly lastUpdateCostMs: number;
  readonly frameDeltaMs: number | null;
  readonly frameDeltaMinMs: number | null;
  readonly frameDeltaMaxMs: number | null;
  readonly frameDeltaP95Ms: number | null;
  readonly frameDeltaP99Ms: number | null;
  readonly fps: number | null;
  readonly measurementSampleCount: number;
  readonly measurementWindowSize: number;
  readonly backendPreference: "webgl";
  readonly cacheApplied: boolean;
  readonly cacheEnabled: boolean;
  readonly redrawCount: number;
  readonly lastSampleRequestCostMs: number | null;
  readonly lastMediaDrawCostMs: number | null;
  readonly lastTextureUploadCostMs: number | null;
  readonly lastPresentUpdateCostMs: number | null;
}

export interface BenchmarkFrameDiagnostics {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly expectedDisplayTime: null;
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
  readonly benchmark: BenchmarkState;
}

export interface BenchmarkSourceProbeState {
  readonly status: BenchmarkSourceProbeStatus;
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

export interface BenchmarkRendererState {
  readonly playbackState: BenchmarkPlaybackState;
  readonly fit: BenchmarkFit;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly presentedFrames: number;
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
  readonly benchmark: BenchmarkState;
  readonly source: BenchmarkSourceProbeState;
}

export interface BenchmarkOverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor?: number;
  readonly strokeAlpha?: number;
  readonly strokeWidth?: number;
}

export interface BenchmarkOverlayFrame {
  readonly mediaTime: number;
  readonly rects: readonly BenchmarkOverlayRect[];
}

export interface InitialBenchmarkRendererOptions {
  readonly container: HTMLElement;
  readonly src: string;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly fit?: BenchmarkFit;
  readonly overlayFrames?: readonly BenchmarkOverlayFrame[];
  readonly benchmark?: BenchmarkOptions;
  readonly onFrame?: (diagnostics: BenchmarkFrameDiagnostics) => void;
  readonly onSource?: (state: BenchmarkSourceProbeState) => void;
}

export interface InitialBenchmarkRenderer {
  play(): Promise<void>;
  pause(): void;
  getState(): BenchmarkRendererState;
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

type BenchmarkTickerLike = {
  readonly elapsedMS?: number;
};

type BenchmarkRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor: number;
  readonly strokeAlpha: number;
  readonly strokeWidth: number;
};

const ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS = 1e-6;
const DEFAULT_OVERLAY_STROKE_ALPHA = 1;
const DEFAULT_OVERLAY_STROKE_COLOR = 0x00ff66;
const DEFAULT_OVERLAY_STROKE_WIDTH = 2;
const DEFAULT_BENCHMARK_COUNT = 1500;
const BENCHMARK_FRAME_WINDOW_SIZE = 60;
const BENCHMARK_STROKE_COLORS = [
  0x00ff66, 0x38bdf8, 0xfacc15, 0xfb7185,
] as const;
const RENDER_ENGINE_PREFERENCE = "webgl";

function copySortedOverlayFrames(
  overlayFrames: readonly BenchmarkOverlayFrame[] | undefined,
): BenchmarkOverlayFrame[] {
  return (overlayFrames ?? [])
    .map((frame) => ({
      mediaTime: frame.mediaTime,
      rects: frame.rects.map((rect) => ({ ...rect })),
    }))
    .sort((left, right) => left.mediaTime - right.mediaTime);
}

function normalizeBenchmarkOptions(
  options: InitialBenchmarkRendererOptions,
): BenchmarkState {
  const enabled =
    options.benchmark === undefined
      ? false
      : (options.benchmark.enabled ?? true);
  const requestedShapeCount =
    options.benchmark?.shapeCount ?? DEFAULT_BENCHMARK_COUNT;
  const shapeCount = enabled ? Math.max(0, Math.floor(requestedShapeCount)) : 0;
  const requestedUpdateStrategy = options.benchmark?.updateStrategy;
  const updateStrategy =
    requestedUpdateStrategy === "redraw-each-frame" ||
    requestedUpdateStrategy === "static-cached"
      ? requestedUpdateStrategy
      : "static";
  const renderStrategy =
    options.benchmark?.renderStrategy === "particle-edges"
      ? "particle-edges"
      : "graphics";

  return {
    backendPreference: RENDER_ENGINE_PREFERENCE,
    cacheApplied: false,
    cacheEnabled:
      enabled &&
      renderStrategy === "graphics" &&
      updateStrategy === "static-cached",
    enabled,
    fps: null,
    frameDeltaMaxMs: null,
    frameDeltaMinMs: null,
    frameDeltaMs: null,
    frameDeltaP95Ms: null,
    frameDeltaP99Ms: null,
    lastMediaDrawCostMs: null,
    lastPresentUpdateCostMs: null,
    lastSampleRequestCostMs: null,
    lastTextureUploadCostMs: null,
    lastUpdateCostMs: 0,
    measurementSampleCount: 0,
    measurementWindowSize: BENCHMARK_FRAME_WINDOW_SIZE,
    redrawCount: 0,
    renderedElementCount: 0,
    renderStrategy,
    shapeCount,
    textEnabled: false,
    updateStrategy,
  };
}

function copyBenchmarkState(state: BenchmarkState): BenchmarkState {
  return { ...state };
}

function calculatePercentile(
  sortedValues: readonly number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );

  return sortedValues[index];
}

function calculateMeasuredCost(startedAt: number, endedAt: number) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return null;
  }

  return Math.max(0, endedAt - startedAt);
}

function createBenchmarkRects(
  shapeCount: number,
  mediaWidth: number,
  mediaHeight: number,
): BenchmarkRect[] {
  const rects: BenchmarkRect[] = [];
  const safeMediaWidth = Math.max(mediaWidth, 1);
  const safeMediaHeight = Math.max(mediaHeight, 1);
  const minimumWidth = safeMediaWidth * 0.015;
  const minimumHeight = safeMediaHeight * 0.015;
  const widthStep = safeMediaWidth * 0.0336;
  const heightStep = safeMediaHeight * 0.0296;

  for (let index = 0; index < shapeCount; index += 1) {
    const width = minimumWidth + (((index * 37) % 100) / 37) * widthStep;
    const height = minimumHeight + (((index * 37) % 100) / 37) * heightStep;
    const maxX = Math.max(safeMediaWidth - width, 0);
    const maxY = Math.max(safeMediaHeight - height, 0);
    const x = (((index * 73) % 997) / 997) * maxX;
    const y = (((index * 521) % 991) / 991) * maxY;

    rects.push({
      height,
      strokeAlpha: 0.72,
      strokeColor:
        BENCHMARK_STROKE_COLORS[index % BENCHMARK_STROKE_COLORS.length],
      strokeWidth: index % 3 === 0 ? 1.5 : 1,
      width,
      x,
      y,
    });
  }

  return rects;
}

export async function createInitialBenchmarkRenderer(
  options: InitialBenchmarkRendererOptions,
): Promise<InitialBenchmarkRenderer> {
  const fit = options.fit ?? "contain";
  const overlayFrames = copySortedOverlayFrames(options.overlayFrames);
  let benchmarkState = normalizeBenchmarkOptions(options);
  const benchmarkFrameDeltas: number[] = [];
  let shouldSkipInitialBenchmarkFrameDelta = true;
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

  let playbackState: BenchmarkPlaybackState = "loading";
  let sourceState: BenchmarkSourceProbeState = {
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
  let mediaScene: Container | undefined;
  let overlayGraphics: Graphics | undefined;
  let lastDrawnOverlayFrame: BenchmarkOverlayFrame | undefined;
  let hasDrawnOverlayFrame = false;
  let benchmarkGraphics: Graphics | undefined;
  let benchmarkParticleContainer: ParticleContainer | undefined;
  let benchmarkRects: BenchmarkRect[] = [];
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;

  const emitSourceState = () => {
    options.onSource?.({ ...sourceState });
  };

  const setSourceState = (patch: Partial<BenchmarkSourceProbeState>) => {
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

  const updateBenchmarkFrameDiagnostics = (
    ticker: BenchmarkTickerLike | undefined,
  ) => {
    const elapsedMS = ticker?.elapsedMS;

    if (typeof elapsedMS !== "number" || !Number.isFinite(elapsedMS)) {
      return;
    }

    if (shouldSkipInitialBenchmarkFrameDelta) {
      shouldSkipInitialBenchmarkFrameDelta = false;
      return;
    }

    benchmarkFrameDeltas.push(elapsedMS);

    if (benchmarkFrameDeltas.length > BENCHMARK_FRAME_WINDOW_SIZE) {
      benchmarkFrameDeltas.shift();
    }

    const frameDeltaMs =
      benchmarkFrameDeltas.reduce((total, value) => total + value, 0) /
      benchmarkFrameDeltas.length;
    const sortedFrameDeltas = [...benchmarkFrameDeltas].sort(
      (left, right) => left - right,
    );

    benchmarkState = {
      ...benchmarkState,
      fps: frameDeltaMs > 0 ? 1000 / frameDeltaMs : null,
      frameDeltaMaxMs: sortedFrameDeltas[sortedFrameDeltas.length - 1],
      frameDeltaMinMs: sortedFrameDeltas[0],
      frameDeltaMs,
      frameDeltaP95Ms: calculatePercentile(sortedFrameDeltas, 95),
      frameDeltaP99Ms: calculatePercentile(sortedFrameDeltas, 99),
      measurementSampleCount: benchmarkFrameDeltas.length,
    };
  };

  const updateRenderDiagnostics = (ticker?: BenchmarkTickerLike) => {
    updateMediaSceneFit();
    updateBenchmarkFrameDiagnostics(ticker);
  };

  const selectOverlayFrame = (mediaTime: number) => {
    let selectedFrame: BenchmarkOverlayFrame | undefined;
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

    if (hasDrawnOverlayFrame && overlayFrame === lastDrawnOverlayFrame) {
      return;
    }

    hasDrawnOverlayFrame = true;
    lastDrawnOverlayFrame = overlayFrame;
    overlayGraphics?.clear();

    for (const rect of overlayFrame?.rects ?? []) {
      overlayGraphics?.rect(rect.x, rect.y, rect.width, rect.height).stroke({
        alpha: rect.strokeAlpha ?? DEFAULT_OVERLAY_STROKE_ALPHA,
        color: rect.strokeColor ?? DEFAULT_OVERLAY_STROKE_COLOR,
        width: rect.strokeWidth ?? DEFAULT_OVERLAY_STROKE_WIDTH,
      });
    }
  };

  const updateBenchmarkCache = (enabled: boolean) => {
    if (!benchmarkGraphics || !benchmarkState.cacheEnabled) {
      return;
    }

    benchmarkGraphics.cacheAsTexture(enabled);

    if (enabled) {
      benchmarkGraphics.updateCacheTexture();
    }

    benchmarkState = {
      ...benchmarkState,
      cacheApplied: enabled,
    };
  };

  const createParticleEdge = (
    x: number,
    y: number,
    width: number,
    height: number,
    rect: BenchmarkRect,
  ) =>
    new Particle({
      alpha: rect.strokeAlpha,
      scaleX: Math.max(width, 0),
      scaleY: Math.max(height, 0),
      texture: Texture.WHITE,
      tint: rect.strokeColor,
      x,
      y,
    });

  const populateBenchmarkParticleEdges = () => {
    if (!benchmarkParticleContainer) {
      return 0;
    }

    const particles = benchmarkParticleContainer.particleChildren;
    particles.length = 0;

    for (const rect of benchmarkRects) {
      const strokeWidth = Math.max(rect.strokeWidth, 0);
      const rightX = rect.x + Math.max(rect.width - strokeWidth, 0);
      const bottomY = rect.y + Math.max(rect.height - strokeWidth, 0);

      particles.push(
        createParticleEdge(rect.x, rect.y, rect.width, strokeWidth, rect),
        createParticleEdge(rect.x, bottomY, rect.width, strokeWidth, rect),
        createParticleEdge(rect.x, rect.y, strokeWidth, rect.height, rect),
        createParticleEdge(rightX, rect.y, strokeWidth, rect.height, rect),
      );
    }

    benchmarkParticleContainer.update();

    return particles.length;
  };

  const drawBenchmark = () => {
    if (!benchmarkState.enabled) {
      return;
    }

    const startedAt = performance.now();
    let renderedElementCount = 0;

    if (benchmarkState.renderStrategy === "particle-edges") {
      renderedElementCount = populateBenchmarkParticleEdges();
    } else if (benchmarkGraphics) {
      benchmarkGraphics.clear();

      for (const rect of benchmarkRects) {
        benchmarkGraphics.rect(rect.x, rect.y, rect.width, rect.height).stroke({
          alpha: rect.strokeAlpha,
          color: rect.strokeColor,
          width: rect.strokeWidth,
        });
      }

      renderedElementCount = benchmarkRects.length;
    }

    const endedAt = performance.now();
    benchmarkState = {
      ...benchmarkState,
      lastUpdateCostMs: calculateMeasuredCost(startedAt, endedAt) ?? 0,
      redrawCount: benchmarkState.redrawCount + 1,
      renderedElementCount,
    };

    if (benchmarkState.cacheEnabled) {
      updateBenchmarkCache(true);
    }
  };

  const emitFrameDiagnostics = (sample: DecodedVideoSample) => {
    options.onFrame?.({
      activeOverlayFrameTime,
      activeOverlayRectCount,
      benchmark: copyBenchmarkState(benchmarkState),
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
    const presentStartedAt = performance.now();

    try {
      sample.draw(context, 0, 0, mediaWidth, mediaHeight);
      const mediaDrawEndedAt = performance.now();
      stagingTextureSource?.update();
      stagingTexture?.update();
      const textureUploadEndedAt = performance.now();
      drawOverlayFrame(sample.timestamp);
      if (benchmarkState.updateStrategy === "redraw-each-frame") {
        drawBenchmark();
      }
      currentTime = sample.timestamp;
      presentedFrames += 1;
      updateMediaSceneFit();
      const presentEndedAt = performance.now();
      benchmarkState = {
        ...benchmarkState,
        lastMediaDrawCostMs: calculateMeasuredCost(
          presentStartedAt,
          mediaDrawEndedAt,
        ),
        lastPresentUpdateCostMs: calculateMeasuredCost(
          presentStartedAt,
          presentEndedAt,
        ),
        lastTextureUploadCostMs: calculateMeasuredCost(
          mediaDrawEndedAt,
          textureUploadEndedAt,
        ),
      };
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
      const sampleRequestStartedAt = performance.now();
      const sample = await sampleSink.getSample(requestedMediaTime, {
        skipLiveWait: true,
      });
      const sampleRequestEndedAt = performance.now();

      if (!isPlaybackRunActive(runId)) {
        sample?.close();
        return;
      }

      benchmarkState = {
        ...benchmarkState,
        lastSampleRequestCostMs: calculateMeasuredCost(
          sampleRequestStartedAt,
          sampleRequestEndedAt,
        ),
      };

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

  const renderer: InitialBenchmarkRenderer = {
    async play() {
      if (destroyed) {
        throw new Error("Initial benchmark renderer has been destroyed.");
      }

      if (playbackState === "error") {
        throw new Error(
          sourceState.errorMessage ?? "Benchmark renderer is in error state.",
        );
      }

      if (!sampleSink) {
        throw new Error("Initial benchmark renderer is not ready.");
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
        activeOverlayFrameTime,
        activeOverlayRectCount,
        benchmark: copyBenchmarkState(benchmarkState),
        currentTime,
        duration,
        fit,
        mediaHeight,
        mediaWidth,
        playbackState,
        presentedFrames,
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
      updateBenchmarkCache(false);
      mediaInput?.dispose();
      mediaInput = undefined;
      setSourceState({ status: "destroyed" });
      app.ticker.remove(updateRenderDiagnostics);
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

  app.ticker.add(updateRenderDiagnostics);
  emitSourceState();

  try {
    const input = new Input({
      formats: [MP4, QTFF, WEBM, MATROSKA],
      source: new UrlSource(options.src),
    });

    mediaInput = input;

    if (destroyed) {
      input.dispose();
      return renderer;
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
    const benchmark =
      benchmarkState.enabled && benchmarkState.renderStrategy === "graphics"
        ? new Graphics()
        : undefined;
    const benchmarkParticles =
      benchmarkState.enabled &&
      benchmarkState.renderStrategy === "particle-edges"
        ? new ParticleContainer({
            boundsArea: new Rectangle(0, 0, mediaWidth, mediaHeight),
            dynamicProperties: {
              color: false,
              position: false,
              rotation: false,
              uvs: false,
              vertex: false,
            },
            texture: Texture.WHITE,
          })
        : undefined;
    const benchmarkLayer = benchmark ?? benchmarkParticles;

    mediaSprite.width = mediaWidth;
    mediaSprite.height = mediaHeight;
    scene.addChild(
      mediaSprite,
      overlays,
      ...(benchmarkLayer ? [benchmarkLayer] : []),
    );
    app.stage.addChild(scene);
    mediaScene = scene;
    overlayGraphics = overlays;
    benchmarkGraphics = benchmark;
    benchmarkParticleContainer = benchmarkParticles;
    benchmarkRects = benchmarkState.enabled
      ? createBenchmarkRects(benchmarkState.shapeCount, mediaWidth, mediaHeight)
      : [];
    stagingTextureSource = canvasSource;
    stagingTexture = texture;
    sampleSink = new VideoSampleSink(primaryVideoTrack);

    if (
      benchmarkState.updateStrategy === "static" ||
      benchmarkState.updateStrategy === "static-cached"
    ) {
      drawBenchmark();
    }

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
    const firstSampleRequestStartedAt = performance.now();
    const firstSampleResult = await firstSampleIterator.next();
    const firstSampleRequestEndedAt = performance.now();
    benchmarkState = {
      ...benchmarkState,
      lastSampleRequestCostMs: calculateMeasuredCost(
        firstSampleRequestStartedAt,
        firstSampleRequestEndedAt,
      ),
    };
    await firstSampleIterator.return?.();
    activeSampleIterator = undefined;

    if (firstSampleResult.done) {
      throw new Error("No decoded video samples were produced.");
    }

    drawSample(firstSampleResult.value, stagingContext);
    playbackState = "ready";

    if (options.autoPlay ?? true) {
      await renderer.play();
    }
  } catch (error) {
    if (!destroyed) {
      setRenderError(error);
    }
  }

  return renderer;
}
