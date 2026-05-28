import type {
  DetectionBufferState,
  MediaRendererPlaybackState,
} from "supervision-js";
import { formatExactTime, formatTime } from "../format";
import { PlaybackControls } from "./PlaybackControls";
import { Readout } from "./Readout";
import { TimelineView } from "./TimelineView";

export function ControlBar({
  activeDetectionFrameTime,
  canUseRenderer,
  currentTime,
  detectionBuffer,
  duration,
  onSeek,
  onTogglePlayback,
  playbackState,
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly canUseRenderer: boolean;
  readonly currentTime: number | null;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly duration: number | null;
  readonly onSeek: (time: number) => void;
  readonly onTogglePlayback: () => void;
  readonly playbackState: MediaRendererPlaybackState | null;
}) {
  return (
    <section className="control-bar" aria-label="Playback controls">
      <PlaybackControls
        disabled={!canUseRenderer}
        onTogglePlayback={onTogglePlayback}
        playbackState={playbackState}
      />
      <TimelineView
        activeDetectionFrameTime={activeDetectionFrameTime}
        currentTime={currentTime ?? 0}
        detectionBuffer={detectionBuffer}
        disabled={!canUseRenderer}
        duration={duration}
        onSeek={onSeek}
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
