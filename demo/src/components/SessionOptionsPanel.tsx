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
  ControlSubheading,
  NumberControl,
  SegmentedControl,
  SliderControl,
  ToggleControl,
} from "./InspectorControls";
import { Readout } from "./Readout";
import {
  DemoEngineSource,
  DemoMediaPath,
  DemoSourceResidency,
  readDemoSourceResidencyMode,
  resolveNormalizationVideoCodecLabel,
  type DemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";
import { DEMO_SOURCE_RESIDENCY_BUDGET_MB } from "../session/source-residency";

const AUTO = "auto";
const UNSET = "unset";
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const STATE_READOUT_CLASS = "session-options__state";

/** When the wait happens. What is waited for is the Waiting for reading. */
const gateReachSentences: Record<PlaybackGateReach, string> = {
  [PlaybackGateReach.EveryFrame]:
    "Every frame waits for what it needs, for as long as the clip runs. A wait that drags on gives up and the picture moves.",
  [PlaybackGateReach.Off]:
    "Nothing holds the picture. A frame is drawn with whatever has arrived by the time it is shown.",
  [PlaybackGateReach.StartOfPlayback]:
    "The video waits once, at the start. After that it keeps going even if annotations or masks fall behind.",
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
        These are set when the clip opens. Changing one reopens it and picks up
        where you left off, and every value shown is the one the open session is
        running on.
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
  const waitingForAnnotations =
    options.detectionGateEnabled ?? detectionGate?.enabled ?? false;
  const waitingForMasks =
    options.preparationGateEnabled ?? preparationGate?.enabled ?? false;
  const container =
    options.normalizeContainer ?? MediaNormalizationContainer.WebM;
  const engine = configuration.engine;
  const engineDriven = configuration.mediaPath === DemoMediaPath.Engine;
  const fetchedSource = configuration.engineSource === DemoEngineSource.Url;
  const mediaPathSupport = configuration.mediaPathSupport;
  const normalizationSupport = configuration.normalizationSupport;
  const residency =
    options.sourceResidency ??
    readDemoSourceResidencyMode(engine.sourceResidency);
  const holdingBytes = residency !== DemoSourceResidency.Off;
  const residencyBudgetMb =
    options.sourceResidencyBudgetMb ??
    toMebibytes(engine.sourceResidency?.budgetBytes) ??
    DEMO_SOURCE_RESIDENCY_BUDGET_MB;
  const normalizing =
    normalizationSupport.supported && options.normalize === true;
  const sizedOutput =
    options.normalizeWidth !== undefined &&
    options.normalizeHeight !== undefined;
  const keepingAudio = (options.normalizeDiscardAudio ?? true) === false;

  return (
    <>
      <ControlSection
        description="What kind of video this is, and whether the picture keeps up with annotations that arrive while it plays."
        title="Lifecycle"
      >
        <SegmentedControl
          label="Mode"
          onChange={(value) => onUpdate("mode", value)}
          optionPath="mode"
          options={[
            { label: "File", value: MediaSessionMode.File },
            { label: "Stream", value: MediaSessionMode.Stream },
          ]}
          tooltip="Whether the video has an end. File loads 10s of annotations ahead of the playhead and 0.5s behind, and looks for more every 2.5s. Stream loads 5s each way and looks four times a second, because more video is still arriving. Switching this moves every loading default in the panel. `mode`, default File."
          value={options.mode ?? configuration.mode}
        />
        <ToggleControl
          checked={options.autoRefresh ?? configuration.autoRefresh}
          label="Auto refresh"
          onChange={(checked) => onUpdate("autoRefresh", checked)}
          optionPath="detections.autoRefresh"
          tooltip="Redraws the frame on screen as soon as annotations covering it arrive. This clip has all of them before it opens, so nothing changes here; you see it while an upload is still being inferred. Off, the picture only redraws when your own code calls `session.refresh()`. `detections.autoRefresh`, default on."
        />
      </ControlSection>

      <ControlSection
        description="Two gates can hold the video: one until the frame's annotations have loaded, one until its masks have been drawn. The mask gate holds twice, once for the frame on screen and again to bank a run of drawn masks ahead of it, and the overlay names which one you are waiting on. Playback gate sets both at once, and each gate's own switch beats it."
        title="Playback gates"
      >
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
          tooltip="On, the video opens with its boxes and masks already on it. Off, the picture moves at once and they appear as they land, which is what you want for skimming a long clip. Unset waits for masks but not for annotations, unless annotations are still being written. `playbackGate`; this workbench opens a sample clip On and an upload Unset."
          value={writeTriState(
            options.playbackGate ?? configuration.playbackGate,
          )}
        />
        <Readout
          className={STATE_READOUT_CLASS}
          label="Waiting for"
          value={describeWait(waitingForAnnotations, waitingForMasks)}
        />
        <Readout
          className={STATE_READOUT_CLASS}
          label="Playback gate reach"
          value={
            playbackGateReach === null
              ? "Waiting for the clip to open."
              : gateReachSentences[playbackGateReach]
          }
        />
        <ControlSubheading>Until the annotations load</ControlSubheading>
        <ToggleControl
          checked={waitingForAnnotations}
          label="Playback gate enabled"
          onChange={(checked) => onUpdate("detectionGateEnabled", checked)}
          optionPath="detections.playbackGate.enabled"
          tooltip="The video waits for the boxes and labels that belong to the frame it is about to show. Off, that frame is drawn without them and they appear once they load. `detections.playbackGate.enabled`; off unless Playback gate is On or annotations are still being written."
        />
        <SliderControl
          label="Required ahead seconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("detectionGateRequiredAheadSeconds", value)
          }
          optionPath="detections.playbackGate.requiredAheadSeconds"
          step={0.25}
          tooltip="How many seconds of annotations have to be loaded before the video is allowed to move. A clip whose annotations are already in memory clears any figure at once; the wait shows while they are still being fetched or written, and a bigger number then means a longer pause before the first frame. At 0 it still waits for the frame it is about to show. `detections.playbackGate.requiredAheadSeconds`, default 2s."
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
        <ControlSubheading>Until the masks are drawn</ControlSubheading>
        <ToggleControl
          checked={waitingForMasks}
          label="Playback gate enabled"
          onChange={(checked) => onUpdate("preparationGateEnabled", checked)}
          optionPath="renderPreparation.playbackGate.enabled"
          tooltip="The video waits for the masks that belong to the frame it is about to show to be turned into pixels. Off, that frame is drawn without its masks. `renderer.renderPreparation.playbackGate.enabled`, on by default."
        />
        <SliderControl
          label="Minimum ahead seconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("preparationGateMinimumAheadSeconds", value)
          }
          optionPath="renderPreparation.playbackGate.minimumAheadSeconds"
          step={0.25}
          tooltip="How little drawn mask can be left in front of the playhead before the video stops. It then stays stopped until Required ahead seconds is met, so setting the two apart keeps a clip that is only just keeping up from stuttering in and out. Nothing on this clip gets near the floor, so raising it changes nothing you can see here. `renderer.renderPreparation.playbackGate.minimumAheadSeconds`, default 0.25s, and never more than the required figure."
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
          optionPath="renderPreparation.playbackGate.requiredAheadSeconds"
          step={0.25}
          tooltip="How much drawn mask has to be in front of the playhead before a stop ends. This is the wait the overlay calls Drawing ahead of the video, where the frame on screen is already finished and the gate is banking a runway in front of it. At 0 that wait is off and the video waits only for the frame it is about to show, which is the other half of this gate. This clip is held about a second when it opens, and this machine draws masks fast enough that the figure barely changes that, so expect it to bite on a denser clip. `renderer.renderPreparation.playbackGate.requiredAheadSeconds`, default 1s."
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
      </ControlSection>

      <ControlSection
        description="How much of the annotation track is held in memory around the playhead, and how often the library looks for more."
        title="Detection buffer"
      >
        <SliderControl
          label="Buffer ahead seconds"
          max={30}
          min={0}
          onChange={(value) => onUpdate("bufferAheadSeconds", value)}
          optionPath="buffer.bufferAheadSeconds"
          step={0.5}
          tooltip="Boxes turn up late after you skip forward? Raise this. It costs memory on a long video. Masks are never drawn further ahead than the annotations are loaded, so lowering it shortens the mask lead too. `detections.buffer.bufferAheadSeconds`, default 10s for a file and 5s for a stream."
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
          tooltip="Boxes blink out when you step or scrub backwards? Raise this. It costs memory and nothing else. `detections.buffer.bufferBehindSeconds`, default 0.5s for a file and 5s for a stream."
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
          tooltip="How often already loaded annotations are read again. A file's annotations never change, so nothing on screen moves with this: a stretch the buffer has not reached yet is fetched the moment you get there whatever this says, and raising it only saves repeated work. On a stream more annotations keep arriving, and this is how often they are picked up. `detections.buffer.refreshIntervalSeconds`, default 2.5s for a file and 0.25s for a stream."
          value={
            options.refreshIntervalSeconds ?? buffer.refreshIntervalSeconds ?? 0
          }
          valueLabel={formatSeconds(
            options.refreshIntervalSeconds ?? buffer.refreshIntervalSeconds,
          )}
        />
      </ControlSection>

      <ControlSection
        description="Segmentation masks are turned into pixels before they can be drawn. Frame counts here are seconds converted at this clip's annotation frame rate, so their defaults read differently on every clip."
        title="Render preparation"
      >
        <SegmentedControl
          label="Mode"
          onChange={(value) => onUpdate("preparationMode", value)}
          optionPath="renderPreparation.mode"
          options={[
            { label: "Auto", value: RenderPreparationMode.Auto },
            { label: "Main thread", value: RenderPreparationMode.MainThread },
            { label: "Worker", value: RenderPreparationMode.Worker },
          ]}
          tooltip="Where masks are turned into pixels. Main thread does it on the same thread that draws the video, so a crowded frame stutters. Worker moves it off that thread. `renderer.renderPreparation.mode`, default Auto, which takes Worker wherever workers exist; this workbench opens on Worker."
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
          tooltip="How many masks can be turned into pixels at once. More of them catch up faster after you jump, and compete with the video itself for the machine. The Workers reading counts the busy ones out of this number. `renderer.renderPreparation.maskFrame.workerCount`; empty takes half this machine's cores capped at 4, and a figure you type is capped at 8."
          value={options.maskWorkerCount ?? maskFrame?.workerCount}
        />
        <NumberControl
          label="Prefetch frame count"
          min={1}
          onChange={(value) => onUpdate("maskPrefetchFrameCount", value)}
          optionPath="maskFrame.prefetchFrameCount"
          step={1}
          tooltip="How many frames of masks are kept drawn ahead of the picture while it plays. Too few and masks drop out mid-shot on a crowded clip. The Prepared window reading says how many are actually there. A paused clip ignores this and keeps one batch ahead. `renderer.renderPreparation.maskFrame.prefetchFrameCount`, default 7 seconds' worth for a file and 3 for a stream, counted at the annotation frame rate."
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
          tooltip="How many drawn masks are held in memory before the oldest are dropped. Set it under the prefetch count and masks the playhead is about to reach get thrown out and drawn a second time. Set it over, and all it costs is memory. `renderer.renderPreparation.maskFrame.maxCacheFrameCount`, default 8 seconds' worth for a file and 5 for a stream."
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
          tooltip="A ceiling on how many frames can queue up waiting for a free worker, so one big jump cannot pile up unbounded work. The Cook reading shows that queue as its `q` figure. `renderer.renderPreparation.maskFrame.maxPendingFrameCount`, default 24."
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
          tooltip="How many frames are sent off to be drawn in one go. It also sets how far a paused clip works ahead: one batch plus the frame under the playhead. Raise it and stepping forward lands on a mask that is already drawn. `renderer.renderPreparation.maskFrame.scheduleBatchSize`, default 16."
          value={options.maskScheduleBatchSize ?? maskFrame?.scheduleBatchSize}
        />
        <SliderControl
          label="Scan interval seconds"
          max={1}
          min={0.02}
          onChange={(value) => onUpdate("maskScanIntervalSeconds", value)}
          optionPath="maskFrame.scanIntervalSeconds"
          step={0.02}
          tooltip="How often the library checks whether enough masks are drawn ahead, and starts more. On this clip it catches up within a few hundred milliseconds at every setting on the slider, so there is nothing here to watch; it is a lever for a machine that cannot keep up. `renderer.renderPreparation.maskFrame.scanIntervalSeconds`, default 0.1s."
          value={
            options.maskScanIntervalSeconds ??
            maskFrame?.scanIntervalSeconds ??
            0.02
          }
          valueLabel={formatSeconds(
            options.maskScanIntervalSeconds ?? maskFrame?.scanIntervalSeconds,
          )}
        />
      </ControlSection>

      <ControlSection
        description="How the picture sits in its box, what it does when you point at it, and what it does when it reaches the end."
        title="Renderer"
      >
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

      <ControlSection
        description="Which reader opens the clip and turns it into pictures. The Video engine group and the Normalization group each act on one of the two, so this decides which of them can do anything."
        title="Media path"
      >
        <SegmentedControl
          disabled={!mediaPathSupport.supported}
          label="Media path"
          onChange={(value) => onUpdate("mediaPath", value)}
          optionPath="media"
          options={[
            { label: "Video engine", value: DemoMediaPath.Engine },
            { label: "Mediabunny", value: DemoMediaPath.Mediabunny },
          ]}
          tooltip="Video engine opens the clip through this project's own decoder: it decodes in a worker, keeps frames it has already drawn so a drag paints at once, and fetches the file in pieces. Mediabunny gives the library the file's address and lets it read and decode the clip itself, which is the shorter path and the only one that can convert the file first. `media`, the video engine here."
          value={configuration.mediaPath}
        />
        {mediaPathSupport.supported ? null : (
          <ControlNote>{mediaPathSupport.reason}</ControlNote>
        )}
      </ControlSection>

      <ControlSection
        description="How the clip's own bytes are fetched, and how much decoded picture is kept around the playhead. Nothing here changes what is drawn, only how long you wait to see it."
        title="Video engine"
      >
        {engineDriven ? null : (
          <ControlNote>
            The media path is Mediabunny, so the library reads and decodes the
            clip itself and nothing in this group is used.
          </ControlNote>
        )}
        {!engineDriven || fetchedSource ? null : (
          <ControlNote>
            This clip was opened from a file on your own machine, so there is
            nothing to fetch: Source residency, Parallelism and Max cache size
            have nothing to act on.
          </ControlNote>
        )}
        <ControlSubheading>Decoding and scrubbing</ControlSubheading>
        <ToggleControl
          checked={options.prefer2d ?? engine.prefer2d ?? false}
          disabled={!engineDriven}
          label="Prefer2d"
          onChange={(checked) => onUpdate("prefer2d", checked)}
          optionPath="prefer2d"
          tooltip="Paints every decoded frame through a 2D canvas instead of the GPU. Both paths draw the same frames on the same cadence, so this is how you find out what the GPU is worth on your machine, or rule it out when the picture looks wrong. `prefer2d`; unset prefers WebGPU and falls back to the 2D canvas where WebGPU is missing."
        />
        <SegmentedControl
          disabled={!engineDriven}
          label="Cache strategy"
          onChange={(value) => onUpdate("cacheStrategy", value)}
          optionPath="cacheStrategy"
          options={[
            { label: "Tiered", value: "tiered" },
            { label: "None", value: "none" },
          ]}
          tooltip="Tiered keeps a small coarse copy of frames already seen plus a few at full resolution, so dragging the playhead paints something straight away. None throws all of it out and decodes every seek from scratch, which is how you see what the cache is worth. `cacheStrategy`, default tiered."
          value={options.cacheStrategy ?? engine.cacheStrategy ?? "tiered"}
        />
        <NumberControl
          disabled={!engineDriven}
          label="Preview capacity"
          min={1}
          onChange={(value) => onUpdate("previewCapacity", value)}
          optionPath="previewCapacity"
          placeholder="auto"
          step={1}
          tooltip="How many of those coarse frames are kept. More of them means a long drag lands more often on a frame already decoded, and each one costs memory. `previewCapacity`; empty sizes it from this machine's memory and the size of a frame."
          value={options.previewCapacity ?? engine.previewCapacity}
        />
        <NumberControl
          disabled={!engineDriven}
          label="Preview width"
          min={16}
          onChange={(value) => onUpdate("previewWidth", value)}
          optionPath="previewWidth"
          placeholder="auto"
          step={16}
          tooltip="How wide those coarse frames are, in pixels. Wider is sharper while you drag and fewer of them fit in memory. `previewWidth`; empty follows the box the picture is shown in and never goes past 320."
          value={options.previewWidth ?? engine.previewWidth}
        />
        <NumberControl
          disabled={!engineDriven}
          label="Cache skip near ms"
          min={0}
          onChange={(value) => onUpdate("cacheSkipNearMs", value)}
          optionPath="cacheSkipNearMs"
          placeholder="100"
          step={10}
          tooltip="A cached frame this close in time to the one already on screen is refused and the full decode is waited for instead, so stepping one frame forward does not snap back to the frame you were already looking at. `cacheSkipNearMs`, default 100ms."
          value={options.cacheSkipNearMs ?? engine.cacheSkipNearMs}
        />
        <ControlSubheading>Fetching the file</ControlSubheading>
        <SegmentedControl
          disabled={!fetchedSource}
          label="Source residency"
          onChange={(value) => onUpdate("sourceResidency", value)}
          optionPath="sourceResidency"
          options={[
            { label: "Off", value: DemoSourceResidency.Off },
            { label: "Hold", value: DemoSourceResidency.Hold },
            { label: "Prefetch", value: DemoSourceResidency.Prefetch },
          ]}
          tooltip="Keeps the video file's bytes in memory as they are read, so a part of the clip read once is never fetched again. Hold keeps what playback and scrubbing pull. Prefetch also walks the rest of the file in the background, so jumping to a part nobody has watched stops waiting on the network. `sourceResidency`, off by default: it costs memory, and prefetching spends the connection on video that may never be watched."
          value={residency}
        />
        <SliderControl
          disabled={!fetchedSource || !holdingBytes}
          label="Budget bytes"
          max={512}
          min={16}
          onChange={(value) => onUpdate("sourceResidencyBudgetMb", value)}
          optionPath="sourceResidency.budgetBytes"
          step={16}
          tooltip="The ceiling on held bytes, set here in mebibytes. Once it is reached the runs furthest from the playhead are dropped first, so a budget smaller than the file makes residency a window that follows the playhead rather than a copy of the whole clip. `sourceResidency.budgetBytes`, 160 MiB unless the page URL asked for another figure."
          value={residencyBudgetMb}
          valueLabel={formatMebibytes(residencyBudgetMb)}
        />
        <NumberControl
          disabled={!fetchedSource}
          label="Parallelism"
          max={16}
          min={1}
          onChange={(value) => onUpdate("urlSourceParallelism", value)}
          optionPath="urlSource.parallelism"
          placeholder="2"
          step={1}
          tooltip="How many requests for video bytes may be in flight at once. More of them can fill a fast connection a single request leaves idle, and can also make each one slower on a thin connection, so this is the knob to move when the picture is waiting on the network rather than on the machine. `parallelism`, default 2."
          value={options.urlSourceParallelism ?? engine.urlSource?.parallelism}
        />
        <NumberControl
          disabled={!fetchedSource}
          label="Max cache size"
          min={1}
          onChange={(value) => onUpdate("urlSourceMaxCacheMb", value)}
          optionPath="urlSource.maxCacheSize"
          placeholder="64 MiB"
          step={16}
          tooltip="How many mebibytes of fetched video are kept before the oldest are dropped. On a clip bigger than this figure, coming back to a part you already watched fetches it a second time. Source residency is the separate setting that holds bytes for as long as the session wants them. `maxCacheSize`, default 64 MiB."
          value={
            options.urlSourceMaxCacheMb ??
            toMebibytes(engine.urlSource?.maxCacheSize)
          }
        />
      </ControlSection>

      <ControlSection
        description="Rewrites the file into a format the browser can step through before anything plays. It belongs to the Mediabunny media path, where the library reads the conversion in place of the clip's own file."
        title="Normalization"
      >
        <ToggleControl
          checked={normalizing}
          disabled={!normalizationSupport.supported}
          label="Normalize"
          onChange={(checked) => onUpdate("normalize", checked || undefined)}
          optionPath="normalize"
          tooltip="Converts the file before anything plays, so a codec the browser cannot step through, or a frame rate that wanders, becomes one it can. The whole file is converted first, which takes a while on a long clip. `normalize`, off by default."
        />
        {normalizationSupport.supported ? null : (
          <ControlNote>{normalizationSupport.reason}</ControlNote>
        )}
        {normalizing || !normalizationSupport.supported ? null : (
          <ControlNote>
            Normalize is off, so the rest of this group does nothing.
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
          tooltip="The file the converted video is written into. It decides which video codecs are on offer and which one Auto picks. `normalize.container`, default WebM."
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
            Audio is being discarded, so Audio codec and Audio bitrate have
            nothing to act on.
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
          Converted bytes reach the video engine only when a host builds a{" "}
          <code>SourceKind.Blob</code> engine source from them, and this option
          cannot ask for that.
        </ControlNote>
      </ControlSection>
    </>
  );
}

function describeWait(annotations: boolean, masks: boolean) {
  if (annotations && masks) {
    return "Annotations and masks.";
  }

  if (annotations) {
    return "Annotations only.";
  }

  return masks ? "Masks only." : "Nothing.";
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

function toMebibytes(bytes: number | undefined) {
  return bytes === undefined ? undefined : bytes / BYTES_PER_MEBIBYTE;
}

function formatMebibytes(value: number) {
  return `${trimZeros(value)} MiB`;
}

function formatSeconds(value: number | undefined) {
  return value === undefined ? "none" : `${trimZeros(value)}s`;
}

function trimZeros(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
