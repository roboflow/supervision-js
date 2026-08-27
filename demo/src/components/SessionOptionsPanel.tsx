import { memo } from "react";
import {
  MediaInteractionMode,
  MediaNormalizationAudioCodec,
  MediaNormalizationContainer,
  MediaNormalizationFit,
  MediaNormalizationVideoCodec,
  MediaRendererFit,
  MediaSessionMode,
  PlaybackGateReach,
  RenderPreparationMode,
} from "supervision";
import {
  ControlNote,
  ControlSection,
  NumberControl,
  SegmentedControl,
  SliderControl,
  ToggleControl,
} from "./InspectorControls";
import { Readout } from "./Readout";
import {
  resolveNormalizationVideoCodecLabel,
  type DemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";

const AUTO = "auto";
const UNSET = "unset";

const gateReachSentences: Record<PlaybackGateReach, string> = {
  [PlaybackGateReach.EveryFrame]:
    "This source hands the renderer decoded frames, so a gate that is on holds every frame, for as long as the clip runs.",
  [PlaybackGateReach.Off]:
    "No gate is on. The picture moves, and a frame missing its annotations or masks is drawn without them.",
  [PlaybackGateReach.StartOfPlayback]:
    "This source presents its own frames, so a gate that is on holds only the start of playback. After that, frames play whether their annotations and masks are ready or not.",
};

export const SessionOptionsPanel = memo(function SessionOptionsPanel({
  configuration,
  onChange,
  options,
  playbackGateReach,
}: {
  readonly configuration: DemoSessionConfiguration | null;
  readonly onChange: (options: DemoSessionOptions) => void;
  readonly options: DemoSessionOptions;
  readonly playbackGateReach: PlaybackGateReach | null;
}) {
  const changedCount = Object.values(options).filter(
    (value) => value !== undefined,
  ).length;
  const update = <Key extends keyof DemoSessionOptions>(
    key: Key,
    value: DemoSessionOptions[Key],
  ) => {
    onChange({ ...options, [key]: value });
  };

  return (
    <section className="session-options" aria-label="Session options">
      <header className="inspector-card__header">
        <h2>Session</h2>
        <button
          disabled={changedCount === 0}
          onClick={() => onChange({})}
          type="button"
        >
          Reset {changedCount === 0 ? "" : changedCount}
        </button>
      </header>
      <p className="session-options__hint">
        Changing one reopens the clip and picks up where you left off. Every
        value shown is the one the open session is running on.
      </p>
      {configuration === null ? (
        <p className="session-options__hint">Waiting for a clip to open.</p>
      ) : (
        <SessionOptionControls
          configuration={configuration}
          onUpdate={update}
          options={options}
          playbackGateReach={playbackGateReach}
        />
      )}
    </section>
  );
});

function SessionOptionControls({
  configuration,
  onUpdate,
  options,
  playbackGateReach,
}: {
  readonly configuration: DemoSessionConfiguration;
  readonly onUpdate: <Key extends keyof DemoSessionOptions>(
    key: Key,
    value: DemoSessionOptions[Key],
  ) => void;
  readonly options: DemoSessionOptions;
  readonly playbackGateReach: PlaybackGateReach | null;
}) {
  const buffer = configuration.resolved.detectionBuffer;
  const detectionGate = buffer.playbackGate;
  const maskFrame = configuration.resolved.renderPreparation.maskFrame;
  const preparationGate = configuration.resolved.renderPreparation.playbackGate;
  const container =
    options.normalizeContainer ?? MediaNormalizationContainer.WebM;
  const normalizing = options.normalize === true;
  const sizedOutput =
    options.normalizeWidth !== undefined &&
    options.normalizeHeight !== undefined;
  const keepingAudio = (options.normalizeDiscardAudio ?? true) === false;

  return (
    <>
      <ControlSection title="Lifecycle">
        <SegmentedControl
          label="Mode"
          onChange={(value) => onUpdate("mode", value)}
          optionPath="mode"
          options={[
            { label: "File", value: MediaSessionMode.File },
            { label: "Stream", value: MediaSessionMode.Stream },
          ]}
          tooltip="Whether the video has an end. File keeps 10s of annotations ahead of the playhead and 0.5s behind, and rebuilds that window every 2.5s. Stream keeps 5s each way and rebuilds four times a second, because the source is still growing. Every default in the two loading groups moves with this. `mode`, default File."
          value={options.mode ?? configuration.mode}
        />
        <SegmentedControl
          label="Playback gate"
          onChange={(value) =>
            onUpdate("playbackGate", value === UNSET ? UNSET : value === "on")
          }
          optionPath="playbackGate"
          options={[
            { label: "Unset", value: UNSET },
            { label: "Off", value: "off" },
            { label: "On", value: "on" },
          ]}
          tooltip="On, the video starts with its boxes and masks already drawn on it. Off, the picture moves at once and the overlays appear as they land, which is what you want for skimming a long clip. Unset waits for masks and not for annotations. `playbackGate`; this workbench passes on."
          value={writeTriState(
            options.playbackGate ?? configuration.playbackGate,
          )}
        />
        <PlaybackGateReachReadout reach={playbackGateReach} />
        <ToggleControl
          checked={options.autoRefresh ?? configuration.autoRefresh}
          label="Auto refresh"
          onChange={(checked) => onUpdate("autoRefresh", checked)}
          optionPath="detections.autoRefresh"
          tooltip="The frame on screen repaints the moment annotations covering it arrive. There is nothing to see on this clip, whose annotations are all present before it opens; it shows while an upload is still being inferred. `detections.autoRefresh`, default on. Off leaves every repaint to `session.refresh()`."
        />
        <ControlNote>
          The switch above answers for both <code>playbackGate.enabled</code>{" "}
          toggles below at once, and either one overrules it. Unset leaves the
          detection one off unless annotations are still being written, and
          leaves the render preparation one on.
        </ControlNote>
      </ControlSection>

      <ControlSection title="Detection buffer">
        <SliderControl
          label="Buffer ahead seconds"
          max={30}
          min={0}
          onChange={(value) => onUpdate("bufferAheadSeconds", value)}
          optionPath="buffer.bufferAheadSeconds"
          step={0.5}
          tooltip="Boxes turn up late after you skip forward? Raise this. Costs memory on a long video. Masks are never drawn further ahead than annotations are loaded, so lowering it shortens the prepared run as well. `detections.buffer.bufferAheadSeconds`, default 10s for a file and 5s for a stream."
          value={options.bufferAheadSeconds ?? buffer.bufferAheadSeconds ?? 0}
          valueLabel={formatSeconds(
            options.bufferAheadSeconds ?? buffer.bufferAheadSeconds,
          )}
        />
        <SliderControl
          label="Buffer behind seconds"
          max={30}
          min={0}
          onChange={(value) => onUpdate("bufferBehindSeconds", value)}
          optionPath="buffer.bufferBehindSeconds"
          step={0.5}
          tooltip="Boxes blink out when you step or scrub backwards? Raise this. Costs memory and nothing else. `detections.buffer.bufferBehindSeconds`, default 0.5s for a file and 5s for a stream."
          value={options.bufferBehindSeconds ?? buffer.bufferBehindSeconds ?? 0}
          valueLabel={formatSeconds(
            options.bufferBehindSeconds ?? buffer.bufferBehindSeconds,
          )}
        />
        <SliderControl
          label="Refresh interval seconds"
          max={10}
          min={0}
          onChange={(value) => onUpdate("refreshIntervalSeconds", value)}
          optionPath="buffer.refreshIntervalSeconds"
          step={0.05}
          tooltip="Nothing on screen moves with this on a file, whose annotations are fixed: ground the loaded window has not reached is fetched the moment the playhead needs it whatever this says. Raising it saves repeated work. On a stream the source gains data underneath, and this is how often that data is picked up. `detections.buffer.refreshIntervalSeconds`, default 2.5s for a file and 0.25s for a stream."
          value={
            options.refreshIntervalSeconds ?? buffer.refreshIntervalSeconds ?? 0
          }
          valueLabel={formatSeconds(
            options.refreshIntervalSeconds ?? buffer.refreshIntervalSeconds,
          )}
        />
        <ToggleControl
          checked={
            options.detectionGateEnabled ?? detectionGate?.enabled ?? false
          }
          label="Playback gate enabled"
          onChange={(checked) => onUpdate("detectionGateEnabled", checked)}
          optionPath="playbackGate.enabled"
          tooltip="Annotations alone hold the video back, whatever the Lifecycle switch says. Off, a frame whose boxes have not loaded is drawn without them. `detections.playbackGate.enabled`, on here because the session switch is on."
        />
        <SliderControl
          label="Required ahead seconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("detectionGateRequiredAheadSeconds", value)
          }
          optionPath="playbackGate.requiredAheadSeconds"
          step={0.25}
          tooltip="Seconds of annotations that have to be loaded before the video is allowed to move. A clip whose annotations are already in memory meets any figure instantly; the wait shows while they are still being fetched or written, and a bigger number then means a longer pause before the first frame. At 0 nothing is waited for. `detections.playbackGate.requiredAheadSeconds`, default 2s."
          value={
            options.detectionGateRequiredAheadSeconds ??
            detectionGate?.requiredAheadSeconds ??
            0
          }
          valueLabel={formatSeconds(
            options.detectionGateRequiredAheadSeconds ??
              detectionGate?.requiredAheadSeconds,
          )}
        />
        <PlaybackGateReachReadout reach={playbackGateReach} />
      </ControlSection>

      <ControlSection title="Render preparation">
        <SegmentedControl
          label="Mode"
          onChange={(value) => onUpdate("preparationMode", value)}
          optionPath="renderPreparation.mode"
          options={[
            { label: "Auto", value: RenderPreparationMode.Auto },
            { label: "Main thread", value: RenderPreparationMode.MainThread },
            { label: "Worker", value: RenderPreparationMode.Worker },
          ]}
          tooltip="Segmentation masks are turned into pixels before they can be drawn. Main thread does that on the thread that draws the video, so a crowded frame stutters. Worker moves it off that thread. `renderer.renderPreparation.mode`, default Auto, which takes Worker wherever workers exist; this workbench opens on Worker."
          value={options.preparationMode ?? configuration.preparationMode}
        />
        <NumberControl
          label="Worker count"
          max={8}
          min={1}
          onChange={(value) => onUpdate("maskWorkerCount", value)}
          optionPath="maskFrame.workerCount"
          placeholder="auto"
          step={1}
          tooltip="Masks that can be turned into pixels at the same time. More of them refill the run of ready masks faster after a jump, and compete with video decode for the machine. The Workers readout below reads busy out of this number. `renderer.renderPreparation.maskFrame.workerCount`; empty takes half this machine's cores capped at 4, and an explicit value is capped at 8."
          value={options.maskWorkerCount ?? maskFrame?.workerCount}
        />
        <NumberControl
          label="Prefetch frame count"
          min={1}
          onChange={(value) => onUpdate("maskPrefetchFrameCount", value)}
          optionPath="maskFrame.prefetchFrameCount"
          step={1}
          tooltip="Frames of masks kept drawn ahead of the picture while it plays. Too few and masks drop out mid-shot on a crowded clip. The Prepared window readout below shows how many are actually there. A paused clip ignores this and keeps one batch ahead. `renderer.renderPreparation.maskFrame.prefetchFrameCount`, default 7 seconds' worth for a file and 3 for a stream, counted at the annotation frame rate."
          value={
            options.maskPrefetchFrameCount ?? maskFrame?.prefetchFrameCount
          }
        />
        <NumberControl
          label="Max cache frame count"
          min={1}
          onChange={(value) => onUpdate("maskMaxCacheFrameCount", value)}
          optionPath="maskFrame.maxCacheFrameCount"
          step={1}
          tooltip="Drawn masks held in memory before the oldest are dropped. Below the prefetch count, masks the playhead is about to reach are thrown out and drawn a second time. Above it, the cost is memory. `renderer.renderPreparation.maskFrame.maxCacheFrameCount`, default 8 seconds' worth for a file and 5 for a stream."
          value={
            options.maskMaxCacheFrameCount ?? maskFrame?.maxCacheFrameCount
          }
        />
        <NumberControl
          label="Max pending frame count"
          min={1}
          onChange={(value) => onUpdate("maskMaxPendingFrameCount", value)}
          optionPath="maskFrame.maxPendingFrameCount"
          step={1}
          tooltip="A ceiling on frames queued for a free worker, so a jump cannot pile up unbounded work. The Cook readout on the transport bar shows that queue as its `q` figure. `renderer.renderPreparation.maskFrame.maxPendingFrameCount`, default 24."
          value={
            options.maskMaxPendingFrameCount ?? maskFrame?.maxPendingFrameCount
          }
        />
        <NumberControl
          label="Schedule batch size"
          min={1}
          onChange={(value) => onUpdate("maskScheduleBatchSize", value)}
          optionPath="maskFrame.scheduleBatchSize"
          step={1}
          tooltip="Frames sent for drawing in one pass. It also sets how far a paused clip works ahead: one batch plus the frame under the playhead. Raise it and stepping forward lands on a mask that is already drawn. `renderer.renderPreparation.maskFrame.scheduleBatchSize`, default 16."
          value={options.maskScheduleBatchSize ?? maskFrame?.scheduleBatchSize}
        />
        <SliderControl
          label="Scan interval seconds"
          max={1}
          min={0.02}
          onChange={(value) => onUpdate("maskScanIntervalSeconds", value)}
          optionPath="maskFrame.scanIntervalSeconds"
          step={0.02}
          tooltip="How often the run of ready masks is checked and topped up. On this clip the run refills within a few hundred milliseconds at every setting on the slider, so there is nothing here to watch; it is a lever for a machine that cannot keep up. `renderer.renderPreparation.maskFrame.scanIntervalSeconds`, default 0.1s."
          value={
            options.maskScanIntervalSeconds ??
            maskFrame?.scanIntervalSeconds ??
            0.02
          }
          valueLabel={formatSeconds(
            options.maskScanIntervalSeconds ?? maskFrame?.scanIntervalSeconds,
          )}
        />
        <ToggleControl
          checked={
            options.preparationGateEnabled ?? preparationGate?.enabled ?? false
          }
          label="Playback gate enabled"
          onChange={(checked) => onUpdate("preparationGateEnabled", checked)}
          optionPath="playbackGate.enabled"
          tooltip="Masks alone hold the video back, whatever the Lifecycle switch says. Off, the picture moves and a frame whose mask is not drawn yet shows without it. `renderer.renderPreparation.playbackGate.enabled`, default on for a session."
        />
        <SliderControl
          label="Minimum ahead seconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("preparationGateMinimumAheadSeconds", value)
          }
          optionPath="playbackGate.minimumAheadSeconds"
          step={0.25}
          tooltip="Drop below this much drawn mask ahead of the playhead and the video stops. It then stays stopped until the required lead is reached, so setting the two apart keeps a clip that is only just keeping up from stuttering in and out. Nothing on this clip gets near the floor, so raising it changes nothing you can see here. `renderer.renderPreparation.playbackGate.minimumAheadSeconds`, default 0.25s, and capped by the required lead."
          value={
            options.preparationGateMinimumAheadSeconds ??
            preparationGate?.minimumAheadSeconds ??
            0
          }
          valueLabel={formatSeconds(
            options.preparationGateMinimumAheadSeconds ??
              preparationGate?.minimumAheadSeconds,
          )}
        />
        <SliderControl
          label="Required ahead seconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("preparationGateRequiredAheadSeconds", value)
          }
          optionPath="playbackGate.requiredAheadSeconds"
          step={0.25}
          tooltip="Seconds of drawn masks that end a stop once one has started. The clip is held for about a second when it opens; on a machine that draws masks this quickly the figure asked for barely changes that, so expect it to bite on a denser clip. `renderer.renderPreparation.playbackGate.requiredAheadSeconds`, default 1s."
          value={
            options.preparationGateRequiredAheadSeconds ??
            preparationGate?.requiredAheadSeconds ??
            0
          }
          valueLabel={formatSeconds(
            options.preparationGateRequiredAheadSeconds ??
              preparationGate?.requiredAheadSeconds,
          )}
        />
        <PlaybackGateReachReadout reach={playbackGateReach} />
        <ControlNote>
          The frame counts above are seconds converted at this clip&apos;s
          annotation frame rate, so their defaults read differently on every
          clip. An empty worker count lets the library size the pool from the
          machine.
        </ControlNote>
      </ControlSection>

      <ControlSection title="Renderer">
        <SegmentedControl
          label="Fit"
          onChange={(value) => onUpdate("fit", value)}
          optionPath="fit"
          options={[
            { label: "Contain", value: MediaRendererFit.Contain },
            { label: "Cover", value: MediaRendererFit.Cover },
          ]}
          tooltip="Contain shows the whole picture and leaves bars where its shape and the box disagree. Cover fills the box and crops what does not fit, which can take detections near the edges off screen. `renderer.fit`, default Contain."
          value={options.fit ?? configuration.fit}
        />
        <SegmentedControl
          label="Interaction mode"
          onChange={(value) => onUpdate("interactionMode", value)}
          optionPath="interaction.mode"
          options={[
            { label: "Paused only", value: MediaInteractionMode.PausedOnly },
            { label: "Always", value: MediaInteractionMode.Always },
            { label: "Disabled", value: MediaInteractionMode.Disabled },
          ]}
          tooltip="Hovering or clicking inside the video picks out the detection under the pointer and fills the Inspect panel. Paused only answers while the video is stopped. Always answers during playback too, where the picture keeps moving under the pointer. Disabled ignores it. `renderer.interaction.mode`, default Paused only."
          value={options.interactionMode ?? configuration.interactionMode}
        />
        <ToggleControl
          checked={options.loop ?? configuration.loop}
          label="Loop"
          onChange={(checked) => onUpdate("loop", checked)}
          optionPath="loop"
          tooltip="The clip runs again from the top instead of stopping on its last frame. `renderer.loop`, default on."
        />
        <ToggleControl
          checked={options.autoPlay ?? configuration.autoPlay}
          label="Auto play"
          onChange={(checked) => onUpdate("autoPlay", checked)}
          optionPath="autoPlay"
          tooltip="The video starts as soon as it is ready. There is nothing to see here either way, because this workbench calls play itself after every reopen. `renderer.autoPlay`, default on in the library and off in this workbench."
        />
      </ControlSection>

      <ControlSection title="Normalization">
        <ToggleControl
          checked={normalizing}
          disabled={!configuration.normalizable.supported}
          label="Normalize"
          onChange={(checked) => onUpdate("normalize", checked || undefined)}
          optionPath="normalize"
          tooltip="The file is converted to a known format before anything plays, so a codec the browser cannot step through, or a wandering frame rate, becomes one it can. The whole file is converted first, which takes a while on a long clip. The converted result feeds the picture from then on, so the engine readouts go quiet. `normalize`, off by default."
        />
        {configuration.normalizable.supported ? null : (
          <ControlNote>{configuration.normalizable.reason}</ControlNote>
        )}
        {normalizing || !configuration.normalizable.supported ? null : (
          <ControlNote>
            Normalize is off, so nothing below it applies.
          </ControlNote>
        )}
        <ToggleControl
          checked={options.normalizeStream ?? false}
          disabled={!normalizing}
          label="Stream"
          onChange={(checked) => onUpdate("normalizeStream", checked)}
          optionPath="stream"
          tooltip="The clip opens on the part converted so far instead of waiting for the whole file, so a picture arrives much sooner. It can only open at the beginning: this is the one setting here that loses the playhead. `normalize.stream`, default off."
        />
        <SegmentedControl
          disabled={!normalizing}
          label="Container"
          onChange={(value) => onUpdate("normalizeContainer", value)}
          optionPath="container"
          options={[
            { label: "WebM", value: MediaNormalizationContainer.WebM },
            { label: "MP4", value: MediaNormalizationContainer.Mp4 },
          ]}
          tooltip="The file the converted video is written into. It decides which codecs are available and which one Auto takes below. `normalize.container`, default WebM."
          value={container}
        />
        <SegmentedControl
          disabled={!normalizing}
          label="Video codec"
          onChange={(value) =>
            onUpdate("normalizeVideoCodec", value === AUTO ? undefined : value)
          }
          optionPath="video.codec"
          options={[
            {
              label: `Auto (${resolveNormalizationVideoCodecLabel(container)})`,
              value: AUTO,
            },
            { label: "VP9", value: MediaNormalizationVideoCodec.Vp9 },
            { label: "VP8", value: MediaNormalizationVideoCodec.Vp8 },
            { label: "AVC", value: MediaNormalizationVideoCodec.Avc },
            { label: "AV1", value: MediaNormalizationVideoCodec.Av1 },
          ]}
          tooltip="AV1 and VP9 write smaller files and take longer to convert. AVC is the one other tools are most likely to read. A codec this machine cannot encode fails the conversion outright. `normalize.video.codec`; Auto is AVC for MP4 and VP9 for WebM."
          value={writeAuto(options.normalizeVideoCodec)}
        />
        <NumberControl
          disabled={!normalizing}
          label="Frame rate"
          min={1}
          onChange={(value) => onUpdate("normalizeFrameRate", value)}
          optionPath="video.frameRate"
          placeholder="30"
          step={1}
          tooltip="A recording whose frame rate wanders is laid on an even grid, so a frame number means the same thing here as it did to whatever ran inference. Lower it for a smaller file and a choppier picture. `normalize.video.frameRate`, default 30."
          value={options.normalizeFrameRate}
        />
        <SliderControl
          disabled={!normalizing}
          label="Key frame interval"
          max={10}
          min={0.25}
          onChange={(value) => onUpdate("normalizeKeyFrameInterval", value)}
          optionPath="video.keyFrameInterval"
          step={0.25}
          tooltip="Seconds between the points a jump can land on directly. Short, and scrubbing and frame stepping land immediately, for more bytes. Long, and every jump decodes a run of frames before it can show one. `normalize.video.keyFrameInterval`, default 1s."
          value={options.normalizeKeyFrameInterval ?? 1}
          valueLabel={formatSeconds(options.normalizeKeyFrameInterval ?? 1)}
        />
        <NumberControl
          disabled={!normalizing}
          label="Video bitrate"
          min={1}
          onChange={(value) => onUpdate("normalizeBitrate", value)}
          optionPath="video.bitrate"
          placeholder="encoder default"
          step={100000}
          tooltip="Bits per second spent on the picture. Lower it and the file shrinks while busy frames smear. `normalize.video.bitrate`; empty leaves it to the encoder."
          value={options.normalizeBitrate}
        />
        <NumberControl
          disabled={!normalizing}
          label="Width"
          min={2}
          onChange={(value) => onUpdate("normalizeWidth", value)}
          optionPath="video.width"
          placeholder="source"
          step={2}
          tooltip="The converted picture's width in pixels. Set one of width and height and the other follows the source's shape. Smaller makes small objects harder to make out. `normalize.video.width`; empty keeps the source width."
          value={options.normalizeWidth}
        />
        <NumberControl
          disabled={!normalizing}
          label="Height"
          min={2}
          onChange={(value) => onUpdate("normalizeHeight", value)}
          optionPath="video.height"
          placeholder="source"
          step={2}
          tooltip="The converted picture's height in pixels. Set one of width and height and the other follows the source's shape. `normalize.video.height`; empty keeps the source height."
          value={options.normalizeHeight}
        />
        <SegmentedControl
          disabled={!normalizing || !sizedOutput}
          label="Fit"
          onChange={(value) =>
            onUpdate("normalizeFit", value === AUTO ? undefined : value)
          }
          optionPath="video.fit"
          options={[
            { label: "Unset", value: AUTO },
            { label: "Fill", value: MediaNormalizationFit.Fill },
            { label: "Contain", value: MediaNormalizationFit.Contain },
            { label: "Cover", value: MediaNormalizationFit.Cover },
          ]}
          tooltip="What happens when the size asked for is a different shape from the source. Fill stretches the picture, Contain adds bars, Cover crops. `normalize.video.fit`, unset by default."
          value={writeAuto(options.normalizeFit)}
        />
        {sizedOutput ? null : (
          <ControlNote>
            Fit applies once both width and height are set; one alone follows
            the source&apos;s shape.
          </ControlNote>
        )}
        <ToggleControl
          checked={options.normalizeForceTranscode ?? true}
          disabled={!normalizing}
          label="Force transcode"
          onChange={(checked) => onUpdate("normalizeForceTranscode", checked)}
          optionPath="video.forceTranscode"
          tooltip="Every frame is re-encoded, so the output carries the codec, size and frame rate asked for. Off, a video stream the target already accepts is copied through, which is much faster and leaves the input's own codec and frame rate in place. `normalize.video.forceTranscode`, default on."
        />
        <ToggleControl
          checked={options.normalizeDiscardAudio ?? true}
          disabled={!normalizing}
          label="Audio discard"
          onChange={(checked) => onUpdate("normalizeDiscardAudio", checked)}
          optionPath="audio.discard"
          tooltip="Every audio track is dropped. Nothing here plays sound, so keeping audio adds conversion time and file size, and pays off only when the output goes somewhere else. `normalize.audio.discard`, default on."
        />
        {!normalizing || keepingAudio ? null : (
          <ControlNote>
            Audio is being discarded, so the two rows below have nothing to act
            on.
          </ControlNote>
        )}
        <SegmentedControl
          disabled={!normalizing || !keepingAudio}
          label="Audio codec"
          onChange={(value) =>
            onUpdate("normalizeAudioCodec", value === AUTO ? undefined : value)
          }
          optionPath="audio.codec"
          options={[
            { label: "Unset", value: AUTO },
            { label: "Opus", value: MediaNormalizationAudioCodec.Opus },
            { label: "AAC", value: MediaNormalizationAudioCodec.Aac },
          ]}
          tooltip="How kept audio is compressed. Nothing here plays it. `normalize.audio.codec`; unset leaves the container's own choice in place."
          value={writeAuto(options.normalizeAudioCodec)}
        />
        <NumberControl
          disabled={!normalizing || !keepingAudio}
          label="Audio bitrate"
          min={1}
          onChange={(value) => onUpdate("normalizeAudioBitrate", value)}
          optionPath="audio.bitrate"
          placeholder="encoder default"
          step={16000}
          tooltip="Bits per second spent on kept audio. `normalize.audio.bitrate`; empty leaves it to the encoder."
          value={options.normalizeAudioBitrate}
        />
        <ControlNote>
          The converted result plays in place of the original, so the video
          engine stops feeding the picture: its diagnostics and the presented
          rate go quiet, and the gates above start holding every frame.
          Converted bytes reach the engine only when a host builds a{" "}
          <code>SourceKind.Blob</code> engine source from them; this option
          cannot ask for that.
        </ControlNote>
      </ControlSection>
    </>
  );
}

function PlaybackGateReachReadout({
  reach,
}: {
  readonly reach: PlaybackGateReach | null;
}) {
  return (
    <Readout
      className="session-options__reach"
      label="Playback gate reach"
      value={
        reach === null ? "Waiting for the renderer." : gateReachSentences[reach]
      }
    />
  );
}

function writeAuto<Value extends string>(value: Value | undefined) {
  return value ?? AUTO;
}

function writeTriState(value: boolean | typeof UNSET | undefined) {
  if (value === undefined || value === UNSET) {
    return UNSET;
  }

  return value ? "on" : "off";
}

function formatSeconds(value: number | undefined) {
  return value === undefined ? "none" : `${trimZeros(value)}s`;
}

function trimZeros(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
