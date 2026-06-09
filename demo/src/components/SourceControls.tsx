import {
  DemoSourceMode,
  type UploadInferenceState,
} from "../session/demo-session-types";
import type { Sam3FixtureDefinition } from "../fixtures/sam3-fixtures";

export function SourceControls({
  apiKey,
  classNames,
  disabled,
  mode,
  onApiKeyChange,
  onCancelUploadInference,
  onClassNamesChange,
  onFileChange,
  onModeChange,
  onSampleChange,
  onStartUploadInference,
  sampleFixtureId,
  sampleFixtures,
  selectedFileName,
  uploadState,
}: {
  readonly apiKey: string;
  readonly classNames: string;
  readonly disabled: boolean;
  readonly mode: DemoSourceMode;
  readonly onApiKeyChange: (apiKey: string) => void;
  readonly onCancelUploadInference: () => void;
  readonly onClassNamesChange: (classNames: string) => void;
  readonly onFileChange: (file: File | null) => void;
  readonly onModeChange: (mode: DemoSourceMode) => void;
  readonly onSampleChange: (sampleName: string) => void;
  readonly onStartUploadInference: () => void;
  readonly sampleFixtureId: string;
  readonly sampleFixtures: readonly Sam3FixtureDefinition[];
  readonly selectedFileName: string | null;
  readonly uploadState: UploadInferenceState;
}) {
  const uploadActive =
    mode === DemoSourceMode.Upload &&
    (uploadState.status === "preparing" || uploadState.status === "running");

  return (
    <section className="source-controls" aria-label="Media source controls">
      <header className="inspector-card__header">
        <h2>Source</h2>
      </header>
      <div className="source-controls__mode">
        {sampleFixtures.map((fixture) => (
          <button
            aria-pressed={
              mode === DemoSourceMode.Fixture &&
              sampleFixtureId === fixture.sampleName
            }
            disabled={disabled}
            key={fixture.sampleName}
            onClick={() => onSampleChange(fixture.sampleName)}
            type="button"
          >
            {fixture.displayName}
          </button>
        ))}
        <button
          aria-pressed={mode === DemoSourceMode.Upload}
          disabled={disabled}
          onClick={() => onModeChange(DemoSourceMode.Upload)}
          type="button"
        >
          Upload media
        </button>
      </div>

      {mode === DemoSourceMode.Upload ? (
        <div className="source-controls__upload">
          <label className="source-field source-field--file">
            <span>Media</span>
            <input
              accept="image/*,video/*"
              disabled={uploadActive}
              onChange={(event) =>
                onFileChange(event.currentTarget.files?.[0] ?? null)
              }
              type="file"
            />
            <strong>{selectedFileName ?? "Choose image or video"}</strong>
          </label>

          <label className="source-field">
            <span>Roboflow API key</span>
            <input
              autoComplete="off"
              disabled={uploadActive}
              onChange={(event) => onApiKeyChange(event.currentTarget.value)}
              placeholder="Paste key for this session"
              type="password"
              value={apiKey}
            />
          </label>

          <label className="source-field source-field--prompts">
            <span>Class names / prompts</span>
            <textarea
              disabled={uploadActive}
              onChange={(event) =>
                onClassNamesChange(event.currentTarget.value)
              }
              rows={2}
              value={classNames}
            />
          </label>

          <div className="source-actions">
            <button
              className="source-actions__primary"
              disabled={uploadActive}
              onClick={onStartUploadInference}
              type="button"
            >
              Start SAM3
            </button>
            <button
              disabled={!uploadActive}
              onClick={onCancelUploadInference}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === DemoSourceMode.Upload ? (
        <div className="source-progress" role="status">
          <span>{uploadState.statusLabel}</span>
          <strong>
            {uploadState.completedFrames}/{uploadState.totalFrames || "-"}{" "}
            frames
          </strong>
        </div>
      ) : null}
    </section>
  );
}
