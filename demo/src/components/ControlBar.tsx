import type {
  DetectionBufferState,
  MediaRendererPlaybackState,
} from "supervision-js";
import { formatExactTime, formatTime } from "../format";
import type { TimelineRange } from "../session/demo-session-types";
import { PlaybackControls } from "./PlaybackControls";
import { Readout } from "./Readout";
import { TimelineView } from "./TimelineView";

export function ControlBar({
  activeDetectionFrameTime,
  canUseRenderer,
  currentTime,
  detectionBuffer,
  duration,
  normalizedRanges,
  onSeek,
  onStepFrame,
  onTogglePlayback,
  playbackState,
  processedRanges,
  processingRanges,
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly canUseRenderer: boolean;
  readonly currentTime: number | null;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly duration: number | null;
  readonly normalizedRanges: readonly TimelineRange[];
  readonly onSeek: (time: number) => void;
  readonly onStepFrame: (frameDelta: number) => void;
  readonly onTogglePlayback: () => void;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly processedRanges: readonly TimelineRange[];
  readonly processingRanges: readonly TimelineRange[];
}) {
  return (
    <section className="control-bar" aria-label="Playback controls">
      <PlaybackControls
        disabled={!canUseRenderer}
        onStepFrame={onStepFrame}
        onTogglePlayback={onTogglePlayback}
        playbackState={playbackState}
      />
      <TimelineView
        activeDetectionFrameTime={activeDetectionFrameTime}
        currentTime={currentTime ?? 0}
        detectionBuffer={detectionBuffer}
        disabled={!canUseRenderer}
        duration={duration}
        normalizedRanges={normalizedRanges}
        onSeek={onSeek}
        processedRanges={processedRanges}
        processingRanges={processingRanges}
      />
      <div className="control-bar__time">
        <Readout
          label="Time"
          value={`${formatExactTime(currentTime)} / ${formatTime(duration)}`}
        />
        <Readout
          label="Detection"
          value={formatExactTime(activeDetectionFrameTime)}
        />
      </div>
    </section>
  );
}
