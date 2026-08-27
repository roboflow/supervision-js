import { memo, useSyncExternalStore } from "react";

import {
  readDetectionFetchDelayMs,
  setDetectionFetchDelayMs,
  subscribeSlowWork,
} from "../diagnostics/slow-work";
import { ControlNote, SliderControl } from "./InspectorControls";

const MAX_DELAY_MS = 4000;
const DELAY_STEP_MS = 250;

export const SlowWorkPanel = memo(function SlowWorkPanel({
  onReopenSession,
}: {
  readonly onReopenSession: () => void;
}) {
  const delayMs = useSyncExternalStore(
    subscribeSlowWork,
    readDetectionFetchDelayMs,
    readDetectionFetchDelayMs,
  );

  return (
    <section className="session-options" aria-label="Slow work">
      <header className="inspector-card__header">
        <h2>Slow work</h2>
        <button onClick={onReopenSession} type="button">
          Reopen the clip
        </button>
      </header>
      <p className="session-options__hint">
        On a warm machine this player finishes its waits faster than the states
        reporting them can be read. Slowing real work down is how you watch one
        happen. Reopening rebuilds the session on the same clip at the same
        playhead with nothing loaded, which is the opening wait, the first
        annotation fetch and the first mask cook all over again.
      </p>
      <SliderControl
        label="Hold each annotation fetch"
        max={MAX_DELAY_MS}
        min={0}
        onChange={setDetectionFetchDelayMs}
        step={DELAY_STEP_MS}
        tooltip="Every batch of annotations the buffer asks for is fetched for real and arrives this much later. Only a few batches stay in memory at a time, so playing or scrubbing keeps asking for more."
        value={delayMs}
        valueLabel={delayMs === 0 ? "off" : `${(delayMs / 1000).toFixed(2)}s`}
      />
      <ControlNote>
        Past about a second the timeline&rsquo;s Requested lane grows a band of
        its own while a fetch is outstanding. Past the lookahead the picture
        runs out of annotations and the State chip reads Buffering.
      </ControlNote>
    </section>
  );
});
