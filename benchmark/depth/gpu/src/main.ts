import { renderSyntheticDisparity } from "./synthetic-stereo";
import { runDecodeCases, type DecodeCase } from "./decode";
import { runExactnessProbe, type ExactnessCase } from "./exactness";
import {
  computeMemoryCase,
  DEPTH_BUDGET_DEFAULTS,
  type MemoryCase,
} from "./memory";
import {
  BackendName,
  createBenchBackend,
  type BackendDescription,
} from "./pixi-backend";
import {
  FIXTURE_PREVIEW_LEVELS,
  readClipSize,
  runPreviewClipCodes,
  runPreviewCodesProbe,
  runPreviewDecode,
  runPreviewPlayback,
  type PreviewClip,
  type PreviewClipCodesCase,
  type PreviewCodesCase,
  type PreviewDecodeCase,
  type PreviewPlaybackCase,
} from "./preview-playback";
import {
  runUploadRender,
  type Resolution,
  type UploadRenderCase,
} from "./upload-render";

export interface DepthGpuBenchmarkReport {
  readonly benchmark: {
    readonly generatedAt: string;
    readonly name: string;
    readonly cases: readonly string[];
    readonly resolutions: readonly Resolution[];
    readonly budgets: typeof DEPTH_BUDGET_DEFAULTS;
  };
  readonly environment: {
    readonly userAgent: string;
    /** Whether the page sees WebGPU at all, and whether it gets an adapter. */
    readonly webGpu: { readonly api: boolean; readonly adapter: boolean };
    readonly hardwareConcurrency: number;
    readonly backends: readonly BackendDescription[];
    readonly errors: readonly string[];
  };
  readonly exactness: readonly ExactnessCase[];
  readonly decode: readonly DecodeCase[];
  readonly uploadRender: readonly UploadRenderCase[];
  readonly memory: readonly MemoryCase[];
  /** The probe at each level; the fixture's level first. */
  readonly previewCodes: readonly PreviewCodesCase[];
  readonly previewClipCodes: readonly PreviewClipCodesCase[];
  readonly previewDecode: readonly PreviewDecodeCase[];
  readonly previewPlayback: readonly PreviewPlaybackCase[];
}

declare global {
  interface Window {
    __SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__?: DepthGpuBenchmarkReport;
  }
}

const RESOLUTIONS: readonly Resolution[] = [
  { height: 720, label: "720p", width: 1280 },
  { height: 1080, label: "1080p", width: 1920 },
  { height: 2160, label: "4K", width: 3840 },
];
/** Frames of the synthetic scene per resolution, far enough apart to differ. */
const FRAME_TIMES_SECONDS = [0.5, 1.5, 2.5, 3.5];
const ALL_CASES = [
  "exactness",
  "decode",
  "upload",
  "memory",
  "preview",
  "playback",
  "codes",
] as const;
/**
 * ffmpeg's luma of the first frames of the fixture's preview, which
 * `run-gpu.mjs` writes, one byte per pixel, frame after frame.
 */
const CLIP_CODES_REFERENCE = {
  frames: 24,
  url: "/benchmark/depth/results/preview-720p-luma.gray",
};
/**
 * The Spring fixture's preview, and the runner's resizes of it with the
 * producer's encoder settings (`run-gpu.mjs` writes them with ffmpeg).
 */
const PREVIEW_CLIPS: readonly PreviewClip[] = [
  {
    label: "720p",
    url: "/demo/fixtures/spring_stereo_depth/sgbm/preview.mp4",
  },
  { label: "1080p", url: "/benchmark/depth/results/preview-1080p.mp4" },
  { label: "4K", url: "/benchmark/depth/results/preview-4k.mp4" },
];
const PLAYBACK_RATES = [1, 2, 8];

const params = new URLSearchParams(window.location.search);
const statusElement = document.querySelector<HTMLParagraphElement>("#status")!;
const outputElement = document.querySelector<HTMLPreElement>("#output")!;

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  setStatus(`Benchmark failed: ${message}`);
  void report({ error: message });
  throw error;
});

async function run() {
  const cases = new Set(
    (params.get("cases") ?? ALL_CASES.join(",")).split(",").filter(Boolean),
  );
  const backends = (params.get("backends") ?? "webgl,webgpu")
    .split(",")
    .filter((name): name is BackendName =>
      Object.values(BackendName).includes(name as BackendName),
    );
  const resolutions = RESOLUTIONS.filter((resolution) =>
    (params.get("resolutions") ?? "720p,1080p,4K")
      .split(",")
      .includes(resolution.label),
  );
  const descriptions: BackendDescription[] = [];
  const errors: string[] = [];
  const exactness: ExactnessCase[] = [];
  const uploadRender: UploadRenderCase[] = [];
  const decode: DecodeCase[] = [];
  const previewDecode: PreviewDecodeCase[] = [];
  const previewPlayback: PreviewPlaybackCase[] = [];
  const previewCodesByLevel: PreviewCodesCase[] = [];
  const previewClipCodes: PreviewClipCodesCase[] = [];
  const clips: PreviewClip[] = [];

  if (cases.has("preview") || cases.has("playback") || cases.has("codes")) {
    setStatus("Probing the page's preview decoders...");
    for (const levels of [FIXTURE_PREVIEW_LEVELS, "full"] as const) {
      try {
        previewCodesByLevel.push(await runPreviewCodesProbe(levels));
      } catch (error) {
        errors.push(`preview probe (${levels}): ${String(error)}`);
      }
    }
  }
  const previewCodes = previewCodesByLevel.find(
    ({ levels }) => levels === FIXTURE_PREVIEW_LEVELS,
  );

  if (cases.has("codes")) {
    setStatus("Comparing the preview's codes with ffmpeg's...");
    try {
      const response = await fetch(CLIP_CODES_REFERENCE.url);

      if (!response.ok) throw new Error(`${response.status}`);
      previewClipCodes.push(
        ...(await runPreviewClipCodes(
          PREVIEW_CLIPS[0],
          new Uint8Array(await response.arrayBuffer()),
          CLIP_CODES_REFERENCE.frames,
        )),
      );
    } catch (error) {
      errors.push(
        `preview clip codes: ${String(error)}; run the benchmark through run-gpu.mjs, which writes ${CLIP_CODES_REFERENCE.url}.`,
      );
    }
  }

  if (cases.has("preview") || cases.has("playback")) {
    for (const clip of PREVIEW_CLIPS) {
      if (
        resolutions.some(({ label }) => label === clip.label) &&
        (await readClipSize(clip))
      ) {
        clips.push(clip);
      } else if (resolutions.some(({ label }) => label === clip.label)) {
        errors.push(
          `${clip.url} did not open; run the benchmark through run-gpu.mjs, which writes it.`,
        );
      }
    }
  }
  const framesByResolution = new Map<
    string,
    ReturnType<typeof renderSyntheticDisparity>[]
  >();
  const framesFor = (resolution: Resolution) => {
    let frames = framesByResolution.get(resolution.label);

    if (!frames) {
      setStatus(`Rendering the synthetic scene at ${resolution.label}...`);
      frames = FRAME_TIMES_SECONDS.map((time) =>
        renderSyntheticDisparity(
          resolution.width,
          resolution.height,
          time,
          // A producer's scale: 1/256 px below 256 px of disparity, 1/128 at
          // 4K, where a near object passes 256 px.
          resolution.width > 1920 ? 128 : 256,
        ),
      );
      framesByResolution.set(resolution.label, frames);
    }

    return frames;
  };

  for (const requested of backends) {
    setStatus(`Starting Pixi on ${requested}...`);
    let backend;

    try {
      backend = await createBenchBackend(requested);
    } catch (error) {
      errors.push(`${requested}: ${String(error)}`);
      continue;
    }

    descriptions.push(backend.description);
    if (backend.description.rendererName !== requested) {
      errors.push(
        `${requested} was requested and Pixi created ${backend.description.rendererName}; its rows are skipped.`,
      );
      backend.destroy();
      continue;
    }

    try {
      if (cases.has("exactness")) {
        setStatus(`${requested}: exactness probe...`);
        exactness.push(...(await runExactnessProbe(backend)));
      }
      if (cases.has("playback") && previewPlayback.length === 0) {
        for (const clip of clips) {
          for (const rate of PLAYBACK_RATES) {
            for (const uploadAhead of [false, true]) {
              setStatus(
                `${requested}: playback ${clip.label} at ${rate}x${uploadAhead ? ", uploading ahead" : ""}...`,
              );
              previewPlayback.push(
                await runPreviewPlayback(backend, clip, rate, uploadAhead),
              );
            }
          }
        }
      }
      if (cases.has("upload")) {
        for (const resolution of resolutions) {
          const frames = framesFor(resolution).map((frame) => ({
            height: frame.height,
            kind: "disparity_px" as const,
            samples: {
              encoding: "scaled16" as const,
              scale: frame.scale,
              values: frame.values,
            },
            width: frame.width,
          }));

          uploadRender.push(
            ...(await runUploadRender(backend, resolution, frames, setStatus)),
          );
        }
      }
    } catch (error) {
      errors.push(
        `${requested}: ${error instanceof Error ? error.stack : String(error)}`,
      );
    } finally {
      backend.destroy();
    }
  }

  if (cases.has("preview") && previewCodes) {
    const decoders = [
      previewCodes.chosen,
      ...previewCodes.verdicts
        .filter(
          ({ hardwareAcceleration, supported }) =>
            supported && hardwareAcceleration !== previewCodes!.chosen,
        )
        .map(({ hardwareAcceleration }) => hardwareAcceleration),
    ] as HardwareAcceleration[];

    for (const clip of clips) {
      for (const decoder of decoders) {
        // The session copies in its worker; the page copy is the fallback.
        for (const copy of ["worker", "page"] as const) {
          if (copy === "page" && decoder !== previewCodes.chosen) continue;
          setStatus(`Preview decode ${clip.label} (${decoder}, ${copy})...`);
          try {
            previewDecode.push(await runPreviewDecode(clip, decoder, copy));
          } catch (error) {
            errors.push(
              `preview decode ${clip.label} ${decoder} ${copy}: ${String(error)}`,
            );
          }
        }
      }
    }
  }

  if (cases.has("decode")) {
    for (const resolution of resolutions) {
      const [frame] = framesFor(resolution);

      decode.push(...(await runDecodeCases(resolution, frame, setStatus)));
    }
  }

  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;

  const result: DepthGpuBenchmarkReport = {
    benchmark: {
      budgets: DEPTH_BUDGET_DEFAULTS,
      cases: [...cases],
      generatedAt: new Date().toISOString(),
      name: "synthetic-stereo-depth-gpu",
      resolutions,
    },
    decode,
    environment: {
      backends: descriptions,
      errors,
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
      webGpu: { adapter: adapter !== null, api: gpu !== undefined },
    },
    exactness,
    memory: cases.has("memory") ? resolutions.map(computeMemoryCase) : [],
    previewClipCodes,
    previewCodes: previewCodesByLevel,
    previewDecode,
    previewPlayback,
    uploadRender,
  };

  window.__SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__ = result;
  outputElement.textContent = JSON.stringify(result, null, 2);
  setStatus(
    exactness.length > 0 && exactness.every(({ pass }) => pass)
      ? "Benchmark complete. Exactness: every code exact."
      : exactness.length > 0
        ? "Benchmark complete. Exactness: MISMATCHES."
        : "Benchmark complete.",
  );
  await report(result);
}

/**
 * A browser the runner cannot drive over CDP (Firefox) opens the page with
 * `?report=<name>`, and the page hands its result to the benchmark's dev
 * server, which writes it next to the other results.
 */
async function report(result: unknown) {
  const name = params.get("report");

  if (!name) return;
  await fetch(`/__depth-benchmark/results/${encodeURIComponent(name)}`, {
    body: JSON.stringify(result, null, 2),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

function setStatus(message: string) {
  statusElement.textContent = message;
}
