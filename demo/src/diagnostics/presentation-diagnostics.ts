import type { MediaRenderer } from "supervision";
import type {
  PresentedFrameRecord,
  PresentedFrameTap,
} from "./presented-frame-tap";
import {
  readRendererReadinessBands,
  type ReadinessBand,
} from "./renderer-readiness";

export interface PresentationDiagnosticsSample {
  readonly lastPresented: PresentedFrameRecord | null;
  readonly presentedCount: number;
  readonly presentedPerSecond: number | null;
  readonly readinessBands: readonly ReadinessBand[] | null;
  readonly renderCount: number | null;
  readonly ticks: readonly PresentedFrameRecord[];
}

export function samplePresentationDiagnostics(options: {
  readonly renderer: MediaRenderer | null;
  readonly tap: PresentedFrameTap;
}): PresentationDiagnosticsSample {
  const presented = options.tap.read();

  return {
    lastPresented: presented.lastPresented,
    presentedCount: presented.presentedCount,
    presentedPerSecond: presented.presentedPerSecond,
    readinessBands: readRendererReadinessBands(options.renderer),
    renderCount: options.renderer?.getRenderCount() ?? null,
    ticks: presented.records,
  };
}
