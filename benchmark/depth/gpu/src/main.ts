import { runExactnessProbe, type ExactnessCase } from "./exactness";
import {
  BackendName,
  createBenchBackend,
  type BackendDescription,
} from "./pixi-backend";

export interface DepthGpuBenchmarkReport {
  readonly benchmark: {
    readonly generatedAt: string;
    readonly name: string;
  };
  readonly environment: {
    readonly userAgent: string;
    /** Whether the page sees WebGPU at all, and whether it gets an adapter. */
    readonly webGpu: { readonly api: boolean; readonly adapter: boolean };
    readonly backends: readonly BackendDescription[];
    readonly errors: readonly string[];
  };
  readonly exactness: readonly ExactnessCase[];
}

declare global {
  interface Window {
    __SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__?: DepthGpuBenchmarkReport;
  }
}

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
  const backends = (params.get("backends") ?? "webgl,webgpu")
    .split(",")
    .filter((name): name is BackendName =>
      Object.values(BackendName).includes(name as BackendName),
    );
  const descriptions: BackendDescription[] = [];
  const errors: string[] = [];
  const exactness: ExactnessCase[] = [];

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
      setStatus(`${requested}: exactness probe...`);
      exactness.push(...(await runExactnessProbe(backend)));
    } catch (error) {
      errors.push(
        `${requested}: ${error instanceof Error ? error.stack : String(error)}`,
      );
    } finally {
      backend.destroy();
    }
  }

  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  const result: DepthGpuBenchmarkReport = {
    benchmark: {
      generatedAt: new Date().toISOString(),
      name: "depth-gpu-exactness",
    },
    environment: {
      backends: descriptions,
      errors,
      userAgent: navigator.userAgent,
      webGpu: { adapter: adapter !== null, api: gpu !== undefined },
    },
    exactness,
  };

  window.__SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__ = result;
  outputElement.textContent = JSON.stringify(result, null, 2);
  setStatus(
    exactness.length > 0 && exactness.every(({ pass }) => pass)
      ? "Benchmark complete. Exactness: every code exact."
      : "Benchmark complete. Exactness: MISMATCHES.",
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
