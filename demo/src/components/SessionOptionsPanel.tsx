import { memo } from "react";
import {
  MediaInteractionMode,
  MediaNormalizationAudioCodec,
  MediaNormalizationContainer,
  MediaNormalizationFit,
  MediaNormalizationVideoCodec,
  MediaRendererFit,
  MediaSessionMode,
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
import {
  resolveNormalizationVideoCodecLabel,
  type DemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";

const AUTO = "auto";
const UNSET = "unset";

export const SessionOptionsPanel = memo(function SessionOptionsPanel({
  configuration,
  onChange,
  options,
}: {
  readonly configuration: DemoSessionConfiguration | null;
  readonly onChange: (options: DemoSessionOptions) => void;
  readonly options: DemoSessionOptions;
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
        Read when the session is built, so changing one reopens the clip on the
        same fixture and resumes where it was. Every value is the one the open
        session resolved to.
      </p>
      {configuration === null ? (
        <p className="session-options__hint">
          Waiting for a session to report the configuration it opened on.
        </p>
      ) : (
        <SessionOptionControls
          configuration={configuration}
          onUpdate={update}
          options={options}
        />
      )}
    </section>
  );
});

function SessionOptionControls({
  configuration,
  onUpdate,
  options,
}: {
  readonly configuration: DemoSessionConfiguration;
  readonly onUpdate: <Key extends keyof DemoSessionOptions>(
    key: Key,
    value: DemoSessionOptions[Key],
  ) => void;
  readonly options: DemoSessionOptions;
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
          label="mode"
          onChange={(value) => onUpdate("mode", value)}
          options={[
            { label: "File", value: MediaSessionMode.File },
            { label: "Stream", value: MediaSessionMode.Stream },
          ]}
          value={options.mode ?? configuration.mode}
        />
        <SegmentedControl
          label="playbackGate"
          onChange={(value) =>
            onUpdate("playbackGate", value === UNSET ? UNSET : value === "on")
          }
          options={[
            { label: "Unset", value: UNSET },
            { label: "Off", value: "off" },
            { label: "On", value: "on" },
          ]}
          value={writeTriState(
            options.playbackGate ?? configuration.playbackGate,
          )}
        />
        <ToggleControl
          checked={options.autoRefresh ?? configuration.autoRefresh}
          label="detections.autoRefresh"
          onChange={(checked) => onUpdate("autoRefresh", checked)}
        />
        <ControlNote>
          The session switch answers for both gates below at once, and either
          gate&apos;s own <code>enabled</code> overrules it. Unset leaves the
          detection gate off unless detections are appendable, and leaves the
          preparation gate on.
        </ControlNote>
      </ControlSection>

      <ControlSection title="Detection buffer">
        <SliderControl
          label="bufferAheadSeconds"
          max={30}
          min={0}
          onChange={(value) => onUpdate("bufferAheadSeconds", value)}
          step={0.5}
          value={options.bufferAheadSeconds ?? buffer.bufferAheadSeconds ?? 0}
          valueLabel={formatSeconds(
            options.bufferAheadSeconds ?? buffer.bufferAheadSeconds,
          )}
        />
        <SliderControl
          label="bufferBehindSeconds"
          max={30}
          min={0}
          onChange={(value) => onUpdate("bufferBehindSeconds", value)}
          step={0.5}
          value={options.bufferBehindSeconds ?? buffer.bufferBehindSeconds ?? 0}
          valueLabel={formatSeconds(
            options.bufferBehindSeconds ?? buffer.bufferBehindSeconds,
          )}
        />
        <SliderControl
          label="refreshIntervalSeconds"
          max={10}
          min={0}
          onChange={(value) => onUpdate("refreshIntervalSeconds", value)}
          step={0.05}
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
          label="playbackGate.enabled"
          onChange={(checked) => onUpdate("detectionGateEnabled", checked)}
        />
        <SliderControl
          label="playbackGate.requiredAheadSeconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("detectionGateRequiredAheadSeconds", value)
          }
          step={0.25}
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
        <ControlNote>
          {normalizing
            ? "Normalizing through the session opens a pull source, so the gate holds every frame it has to wait for, for as long as playback runs."
            : "This clip presents its own frames, so the gate holds the start of playback and nothing after it. Raising the lookahead lengthens that first wait."}
        </ControlNote>
      </ControlSection>

      <ControlSection title="Render preparation">
        <SegmentedControl
          label="mode"
          onChange={(value) => onUpdate("preparationMode", value)}
          options={[
            { label: "Auto", value: RenderPreparationMode.Auto },
            { label: "Main", value: RenderPreparationMode.MainThread },
            { label: "Worker", value: RenderPreparationMode.Worker },
          ]}
          value={options.preparationMode ?? configuration.preparationMode}
        />
        <NumberControl
          label="maskFrame.workerCount"
          max={8}
          min={1}
          onChange={(value) => onUpdate("maskWorkerCount", value)}
          placeholder="auto"
          step={1}
          value={options.maskWorkerCount ?? maskFrame?.workerCount}
        />
        <NumberControl
          label="maskFrame.prefetchFrameCount"
          min={1}
          onChange={(value) => onUpdate("maskPrefetchFrameCount", value)}
          step={1}
          value={
            options.maskPrefetchFrameCount ?? maskFrame?.prefetchFrameCount
          }
        />
        <NumberControl
          label="maskFrame.maxCacheFrameCount"
          min={1}
          onChange={(value) => onUpdate("maskMaxCacheFrameCount", value)}
          step={1}
          value={
            options.maskMaxCacheFrameCount ?? maskFrame?.maxCacheFrameCount
          }
        />
        <NumberControl
          label="maskFrame.maxPendingFrameCount"
          min={1}
          onChange={(value) => onUpdate("maskMaxPendingFrameCount", value)}
          step={1}
          value={
            options.maskMaxPendingFrameCount ?? maskFrame?.maxPendingFrameCount
          }
        />
        <NumberControl
          label="maskFrame.scheduleBatchSize"
          min={1}
          onChange={(value) => onUpdate("maskScheduleBatchSize", value)}
          step={1}
          value={options.maskScheduleBatchSize ?? maskFrame?.scheduleBatchSize}
        />
        <SliderControl
          label="maskFrame.scanIntervalSeconds"
          max={1}
          min={0.02}
          onChange={(value) => onUpdate("maskScanIntervalSeconds", value)}
          step={0.02}
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
          label="playbackGate.enabled"
          onChange={(checked) => onUpdate("preparationGateEnabled", checked)}
        />
        <SliderControl
          label="playbackGate.minimumAheadSeconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("preparationGateMinimumAheadSeconds", value)
          }
          step={0.25}
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
          label="playbackGate.requiredAheadSeconds"
          max={10}
          min={0}
          onChange={(value) =>
            onUpdate("preparationGateRequiredAheadSeconds", value)
          }
          step={0.25}
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
        <ControlNote>
          Frame counts follow the detection frame rate, so the prefetch and
          cache defaults answer differently per fixture. An empty worker count
          lets the library size the pool from the machine.
        </ControlNote>
      </ControlSection>

      <ControlSection title="Renderer">
        <SegmentedControl
          label="fit"
          onChange={(value) => onUpdate("fit", value)}
          options={[
            { label: "Contain", value: MediaRendererFit.Contain },
            { label: "Cover", value: MediaRendererFit.Cover },
          ]}
          value={options.fit ?? configuration.fit}
        />
        <SegmentedControl
          label="interaction.mode"
          onChange={(value) => onUpdate("interactionMode", value)}
          options={[
            { label: "Paused", value: MediaInteractionMode.PausedOnly },
            { label: "Always", value: MediaInteractionMode.Always },
            { label: "Off", value: MediaInteractionMode.Disabled },
          ]}
          value={options.interactionMode ?? configuration.interactionMode}
        />
        <ToggleControl
          checked={options.loop ?? configuration.loop}
          label="loop"
          onChange={(checked) => onUpdate("loop", checked)}
        />
        <ToggleControl
          checked={options.autoPlay ?? configuration.autoPlay}
          label="autoPlay"
          onChange={(checked) => onUpdate("autoPlay", checked)}
        />
        <ControlNote>
          The workbench opens with <code>autoPlay: false</code> and starts
          playback itself; the library&apos;s own default is on.
        </ControlNote>
      </ControlSection>

      <ControlSection title="Normalization">
        <ToggleControl
          checked={normalizing}
          disabled={!configuration.normalizable.supported}
          label="normalize"
          onChange={(checked) => onUpdate("normalize", checked || undefined)}
        />
        {configuration.normalizable.supported ? null : (
          <ControlNote>{configuration.normalizable.reason}</ControlNote>
        )}
        <ToggleControl
          checked={options.normalizeStream ?? false}
          disabled={!normalizing}
          label="stream"
          onChange={(checked) => onUpdate("normalizeStream", checked)}
        />
        <SegmentedControl
          disabled={!normalizing}
          label="container"
          onChange={(value) => onUpdate("normalizeContainer", value)}
          options={[
            { label: "WebM", value: MediaNormalizationContainer.WebM },
            { label: "MP4", value: MediaNormalizationContainer.Mp4 },
          ]}
          value={container}
        />
        <SegmentedControl
          disabled={!normalizing}
          label={`video.codec (auto = ${resolveNormalizationVideoCodecLabel(container)})`}
          onChange={(value) =>
            onUpdate("normalizeVideoCodec", value === AUTO ? undefined : value)
          }
          options={[
            { label: "Auto", value: AUTO },
            { label: "VP9", value: MediaNormalizationVideoCodec.Vp9 },
            { label: "VP8", value: MediaNormalizationVideoCodec.Vp8 },
            { label: "AVC", value: MediaNormalizationVideoCodec.Avc },
            { label: "AV1", value: MediaNormalizationVideoCodec.Av1 },
          ]}
          value={writeAuto(options.normalizeVideoCodec)}
        />
        <NumberControl
          disabled={!normalizing}
          label="video.frameRate"
          min={1}
          onChange={(value) => onUpdate("normalizeFrameRate", value)}
          placeholder="30"
          step={1}
          value={options.normalizeFrameRate}
        />
        <SliderControl
          disabled={!normalizing}
          label="video.keyFrameInterval"
          max={10}
          min={0.25}
          onChange={(value) => onUpdate("normalizeKeyFrameInterval", value)}
          step={0.25}
          value={options.normalizeKeyFrameInterval ?? 1}
          valueLabel={formatSeconds(options.normalizeKeyFrameInterval ?? 1)}
        />
        <NumberControl
          disabled={!normalizing}
          label="video.bitrate"
          min={1}
          onChange={(value) => onUpdate("normalizeBitrate", value)}
          placeholder="encoder default"
          step={100000}
          value={options.normalizeBitrate}
        />
        <NumberControl
          disabled={!normalizing}
          label="video.width"
          min={2}
          onChange={(value) => onUpdate("normalizeWidth", value)}
          placeholder="source"
          step={2}
          value={options.normalizeWidth}
        />
        <NumberControl
          disabled={!normalizing}
          label="video.height"
          min={2}
          onChange={(value) => onUpdate("normalizeHeight", value)}
          placeholder="source"
          step={2}
          value={options.normalizeHeight}
        />
        <SegmentedControl
          disabled={!normalizing || !sizedOutput}
          label="video.fit"
          onChange={(value) =>
            onUpdate("normalizeFit", value === AUTO ? undefined : value)
          }
          options={[
            { label: "Unset", value: AUTO },
            { label: "Fill", value: MediaNormalizationFit.Fill },
            { label: "Contain", value: MediaNormalizationFit.Contain },
            { label: "Cover", value: MediaNormalizationFit.Cover },
          ]}
          value={writeAuto(options.normalizeFit)}
        />
        {sizedOutput ? null : (
          <ControlNote>
            <code>video.fit</code> decides the crop only once both width and
            height are set; one alone follows the aspect ratio.
          </ControlNote>
        )}
        <ToggleControl
          checked={options.normalizeForceTranscode ?? true}
          disabled={!normalizing}
          label="video.forceTranscode"
          onChange={(checked) => onUpdate("normalizeForceTranscode", checked)}
        />
        <ToggleControl
          checked={options.normalizeDiscardAudio ?? true}
          disabled={!normalizing}
          label="audio.discard"
          onChange={(checked) => onUpdate("normalizeDiscardAudio", checked)}
        />
        <SegmentedControl
          disabled={!normalizing || !keepingAudio}
          label="audio.codec"
          onChange={(value) =>
            onUpdate("normalizeAudioCodec", value === AUTO ? undefined : value)
          }
          options={[
            { label: "Unset", value: AUTO },
            { label: "Opus", value: MediaNormalizationAudioCodec.Opus },
            { label: "AAC", value: MediaNormalizationAudioCodec.Aac },
          ]}
          value={writeAuto(options.normalizeAudioCodec)}
        />
        <NumberControl
          disabled={!normalizing || !keepingAudio}
          label="audio.bitrate"
          min={1}
          onChange={(value) => onUpdate("normalizeAudioBitrate", value)}
          placeholder="encoder default"
          step={16000}
          value={options.normalizeAudioBitrate}
        />
        <ControlNote>
          This is the session&apos;s own <code>normalize</code> option, and it
          builds a renderer source of its own: an object URL for a full
          transcode, a streaming pull source for a progressive one. Neither is
          the video-engine source, so the renderer pulls decoded samples, engine
          diagnostics and the presented rate go quiet, and the gates above hold
          every frame rather than only the start of playback. Progressive output
          reopens from the beginning, since nothing past it has been produced
          yet. Normalized bytes do reach the engine when a host builds a{" "}
          <code>SourceKind.Blob</code> engine source itself; this option has no
          way to ask for that.
        </ControlNote>
      </ControlSection>
    </>
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
