import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  DetectionBufferStatus,
  MediaErrorKind,
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionStatus,
  MediaSourceStatus,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision";
import { describe, expect, it } from "vitest";

import { StatusPanel } from "./StatusPanel";

interface ReadoutProps {
  readonly label?: string;
  readonly title?: string;
  readonly value?: ReactNode;
  readonly children?: ReactNode;
}

type PanelProps = Parameters<typeof StatusPanel.type>[0];

function readout(tree: ReactNode, label: string): ReadoutProps {
  const found = collect(tree).filter((node) => node.props.label === label);

  if (found.length !== 1) {
    throw new Error(`${found.length} readouts are labelled "${label}"`);
  }

  return found[0].props;
}

function collect(
  node: ReactNode,
  found: ReactElement<ReadoutProps>[] = [],
): ReactElement<ReadoutProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, found);
    }
    return found;
  }

  if (!isValidElement<ReadoutProps>(node)) {
    return found;
  }

  found.push(node);

  return collect(node.props.children, found);
}

function renderPanel(overrides: Partial<PanelProps> = {}) {
  return StatusPanel.type({
    detectionSourceState: {
      datasetId: null,
      errorMessage: null,
      sourceSummary: null,
      status: "idle",
    },
    errorMessage: null,
    fixtureSummary: null,
    hoveredDetectionPick: null,
    mediaState: { errorMessage: null, status: "ready" },
    playbackState: MediaRendererPlaybackState.Paused,
    presentedRate: null,
    renderPreparationDiagnostics: null,
    rendererState: null,
    selectedDetectionPick: null,
    sessionState: null,
    sourceState: sourceState(0),
    ...overrides,
  });
}

function sourceState(audioTrackCount: number | null): MediaSourceState {
  return {
    audioTrackCount,
    canRead: true,
    duration: 10,
    errorKind: null as MediaErrorKind | null,
    errorMessage: null,
    estimatedFrameCount: 300,
    estimatedFrameRate: 30,
    firstTimestamp: 0,
    formatMimeType: "video/mp4",
    formatName: "mp4",
    mimeType: "video/mp4",
    primaryVideoHeight: 240,
    primaryVideoWidth: 320,
    status: MediaSourceStatus.Ready,
    trackCount: 2,
    videoTrackCount: 1,
  };
}

function rendererState(
  overrides: Partial<MediaRendererState> = {},
): MediaRendererState {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: 3,
    activeDetectionFrameTime: 0.1333,
    currentTime: 0.1333,
    detectionBuffer: {
      bufferEndTime: null,
      bufferStartTime: null,
      detectionCount: 0,
      errorMessage: null,
      frameCount: 0,
      requestedEndTime: null,
      requestedStartTime: null,
      status: DetectionBufferStatus.Idle,
    },
    drawnMaskFrameTime: null,
    duration: 10,
    fit: MediaRendererFit.Contain,
    lastFrameRenderTimings: null,
    maskHeldStale: false,
    mediaHeight: 240,
    mediaWidth: 320,
    playbackRate: 1,
    playbackState: MediaRendererPlaybackState.Paused,
    presentedFrames: 1,
    rendererBackend: "webgpu",
    source: sourceState(0),
    ...overrides,
  };
}

describe("StatusPanel", () => {
  it("reads the audio track count off the source it opened", () => {
    expect(readout(renderPanel(), "Audio").value).toBe("video-only source");
    expect(
      readout(renderPanel({ sourceState: sourceState(2) }), "Audio").value,
    ).toBe("2 audio tracks");
  });

  it("says when the mask on screen belongs to an older frame than the boxes", () => {
    const matched = renderPanel({
      rendererState: rendererState({ drawnMaskFrameTime: 0.1333 }),
    });
    const stale = renderPanel({
      rendererState: rendererState({
        drawnMaskFrameTime: 0.1,
        maskHeldStale: true,
      }),
    });

    expect(String(readout(matched, "Mask Frame").value)).not.toContain("stale");
    // Nothing else on the panel names the frame the raster really belongs to.
    expect(String(readout(stale, "Mask Frame").value)).toContain("stale");
  });

  it("says which side of the picture a mismatched raster sits on", () => {
    const forwards = renderPanel({
      rendererState: rendererState({
        activeDetectionFrameTime: 0.1333,
        drawnMaskFrameTime: 0.1,
        maskHeldStale: true,
      }),
    });
    const backwards = renderPanel({
      rendererState: rendererState({
        activeDetectionFrameTime: 0.1,
        drawnMaskFrameTime: 0.1333,
        maskHeldStale: true,
      }),
    });

    expect(String(readout(forwards, "Mask Frame").value)).toContain(
      "33.30ms behind",
    );
    expect(String(readout(backwards, "Mask Frame").value)).toContain(
      "33.30ms ahead",
    );
  });

  it("separates navigation, source reads, and a mask wait that gave up", () => {
    const tree = renderPanel({
      renderPreparationDiagnostics: {
        artifacts: [
          {
            activeFrame: { key: "mask:4", mediaTime: 4, status: "pending" },
            gateHold: {
              reason: "leadBelowRequirement",
              requiredAheadSeconds: 1,
            },
            kind: "maskFrame",
            pendingCount: 2,
            preparedAheadSeconds: 0.25,
            preparedCount: 3,
          },
        ],
        executionMode: "worker",
        message: null,
        workerStatus: "ready",
      } as PanelProps["renderPreparationDiagnostics"],
      rendererState: rendererState({
        renderPreparationGateAbandoned: true,
        scrubbing: true,
        seeking: true,
        source: { ...sourceState(0), awaitingRead: true },
      }),
    });

    expect(readout(tree, "Navigation").value).toBe("scrubbing | seeking");
    expect(readout(tree, "Source Read").value).toBe(
      "waiting for bytes or decode",
    );
    expect(readout(tree, "Mask Wait").value).toBe(
      "gave up | playback continuing",
    );
    expect(String(readout(tree, "Mask Readiness").value)).toContain("needed");
  });

  it("names the activity that is currently blocking playback", () => {
    const tree = renderPanel({
      sessionState: {
        activities: [
          {
            blockingPlayback: true,
            blockingPresentation: false,
            detail: "The masks for this frame are not drawn yet",
            kind: MediaSessionActivityKind.RenderPreparing,
            label: "Waiting for the masks",
            status: MediaSessionActivityStatus.Waiting,
          },
        ],
        errorMessage: null,
        media: {
          inputMetadata: null,
          normalizedMedia: null,
          objectUrl: null,
        },
        normalization: null,
        playbackBlocked: true,
        presentationBlocked: false,
        renderPreparation: null,
        renderer: null,
        status: MediaSessionStatus.Buffering,
      },
    });

    expect(readout(tree, "Current Blocker").value).toBe(
      "Waiting for the masks | The masks for this frame are not drawn yet",
    );
  });
});
