import {
  Application,
  CanvasSource,
  ImageSource,
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
import type { VideoSample } from "mediabunny";

const MEDIA_URL = "/demo/fixtures/basketball_sample/basketball_sample.mp4";
const SAMPLE_COUNT = 90;
const WARMUP_COUNT = 5;

interface StrategyResult {
  readonly averageMs: number;
  readonly medianMs: number;
  readonly name: string;
  readonly p95Ms: number;
  readonly sampleCount: number;
  readonly totalMs: number;
}

interface BenchmarkResult {
  readonly browser: string;
  readonly height: number;
  readonly mediaUrl: string;
  readonly rendererBackend: string;
  readonly results: readonly StrategyResult[];
  readonly sampleCount: number;
  readonly width: number;
}

declare global {
  interface Window {
    __mediaUploadBenchmarkResult?: BenchmarkResult;
    __mediaUploadBenchmarkError?: string;
  }
}

void runBenchmark();

async function runBenchmark() {
  const status = document.querySelector("#status");

  try {
    const metadata = await readVideoMetadata();
    const stage = document.querySelector("#stage");

    if (!(stage instanceof HTMLElement)) {
      throw new Error("Missing benchmark stage element.");
    }

    const app = new Application();
    await app.init({
      autoDensity: true,
      autoStart: false,
      backgroundColor: 0x050505,
      height: metadata.height,
      preference: "webgl",
      resizeTo: undefined,
      width: metadata.width,
    });
    stage.appendChild(app.canvas);

    const results = [
      await benchmarkCanvasSource(app, metadata),
      await benchmarkVideoFrameImageSource(app, metadata),
      await benchmarkImageBitmapImageSource(app, metadata),
    ];
    const result: BenchmarkResult = {
      browser: navigator.userAgent,
      height: metadata.height,
      mediaUrl: MEDIA_URL,
      rendererBackend: String(app.renderer.name ?? "unknown"),
      results,
      sampleCount: SAMPLE_COUNT,
      width: metadata.width,
    };

    window.__mediaUploadBenchmarkResult = result;
    if (status) {
      status.textContent = JSON.stringify(result, null, 2);
    }

    app.destroy({ releaseGlobalResources: true }, { children: true });
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);

    window.__mediaUploadBenchmarkError = message;
    if (status) {
      status.textContent = message;
    }
  }
}

async function readVideoMetadata() {
  const input = await openInput();

  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw new Error("No primary video track.");
    }

    const [width, height, firstTimestamp] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getFirstTimestamp(),
    ]);

    return { firstTimestamp, height, width };
  } finally {
    input.dispose();
  }
}

async function benchmarkCanvasSource(
  app: Application,
  metadata: Awaited<ReturnType<typeof readVideoMetadata>>,
) {
  const canvas = document.createElement("canvas");
  canvas.width = metadata.width;
  canvas.height = metadata.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create canvas benchmark context.");
  }

  const source = new CanvasSource({
    dynamic: true,
    height: metadata.height,
    resource: canvas,
    width: metadata.width,
  });
  const texture = new Texture({ dynamic: true, source });
  const sprite = new Sprite({ texture });
  app.stage.removeChildren();
  app.stage.addChild(sprite);

  const timings = await benchmarkSamples("canvas-source", async (sample) => {
    sample.draw(context, 0, 0, metadata.width, metadata.height);
    source.update();
    texture.update();
    app.renderer.render({ container: app.stage });
  });

  sprite.destroy();
  texture.destroy(true);
  canvas.width = 0;
  canvas.height = 0;

  return timings;
}

async function benchmarkVideoFrameImageSource(
  app: Application,
  metadata: Awaited<ReturnType<typeof readVideoMetadata>>,
) {
  const placeholder = document.createElement("canvas");
  placeholder.width = metadata.width;
  placeholder.height = metadata.height;
  const source = new ImageSource({
    dynamic: true,
    height: metadata.height,
    resource: placeholder,
    width: metadata.width,
  });
  const texture = new Texture({ dynamic: true, source });
  const sprite = new Sprite({ texture });
  app.stage.removeChildren();
  app.stage.addChild(sprite);

  const timings = await benchmarkSamples(
    "video-frame-image-source",
    async (sample) => {
      const frame = sample.toVideoFrame();

      try {
        source.resource = frame;
        source.update();
        texture.update();
        app.renderer.render({ container: app.stage });
      } finally {
        frame.close();
      }
    },
  );

  sprite.destroy();
  texture.destroy(true);
  placeholder.width = 0;
  placeholder.height = 0;

  return timings;
}

async function benchmarkImageBitmapImageSource(
  app: Application,
  metadata: Awaited<ReturnType<typeof readVideoMetadata>>,
) {
  const placeholder = document.createElement("canvas");
  placeholder.width = metadata.width;
  placeholder.height = metadata.height;
  const source = new ImageSource({
    dynamic: true,
    height: metadata.height,
    resource: placeholder,
    width: metadata.width,
  });
  const texture = new Texture({ dynamic: true, source });
  const sprite = new Sprite({ texture });
  app.stage.removeChildren();
  app.stage.addChild(sprite);

  const timings = await benchmarkSamples(
    "image-bitmap-image-source",
    async (sample) => {
      const frame = sample.toVideoFrame();
      let bitmap: ImageBitmap | undefined;

      try {
        bitmap = await createImageBitmap(frame);
        source.resource = bitmap;
        source.update();
        texture.update();
        app.renderer.render({ container: app.stage });
      } finally {
        bitmap?.close();
        frame.close();
      }
    },
  );

  sprite.destroy();
  texture.destroy(true);
  placeholder.width = 0;
  placeholder.height = 0;

  return timings;
}

async function benchmarkSamples(
  name: string,
  presentSample: (sample: VideoSample) => Promise<void> | void,
): Promise<StrategyResult> {
  const input = await openInput();

  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw new Error("No primary video track.");
    }

    const firstTimestamp = await track.getFirstTimestamp();
    const sink = new VideoSampleSink(track);
    const timings: number[] = [];
    let index = 0;

    for await (const sample of sink.samples(firstTimestamp, undefined, {
      skipLiveWait: true,
    })) {
      if (index >= SAMPLE_COUNT + WARMUP_COUNT) {
        sample.close();
        break;
      }

      const start = performance.now();
      try {
        await presentSample(sample);
      } finally {
        sample.close();
      }

      if (index >= WARMUP_COUNT) {
        timings.push(performance.now() - start);
      }

      index += 1;
    }

    return summarize(name, timings);
  } finally {
    input.dispose();
  }
}

async function openInput() {
  const input = new Input({
    formats: [MP4, QTFF, WEBM, MATROSKA],
    source: new UrlSource(MEDIA_URL),
  });

  if (!(await input.canRead())) {
    input.dispose();
    throw new Error("Mediabunny cannot read benchmark media.");
  }

  return input;
}

function summarize(name: string, timings: readonly number[]): StrategyResult {
  const sorted = [...timings].sort((a, b) => a - b);
  const totalMs = timings.reduce((sum, value) => sum + value, 0);

  return {
    averageMs: totalMs / timings.length,
    medianMs: percentile(sorted, 0.5),
    name,
    p95Ms: percentile(sorted, 0.95),
    sampleCount: timings.length,
    totalMs,
  };
}

function percentile(sorted: readonly number[], percentileValue: number) {
  if (sorted.length === 0) {
    return 0;
  }

  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))
  ]!;
}
