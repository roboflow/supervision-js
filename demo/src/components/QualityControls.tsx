import { memo } from "react";
import {
  ControlNote,
  ControlSubheading,
  NumberControl,
  SegmentedControl,
  ToggleControl,
} from "./InspectorControls";
import {
  readDemoLibraryDefaults,
  readDemoOptionOrigin,
} from "../session/library-defaults";
import { formatOptionFlag } from "../session/option-format";
import type {
  DemoSessionConfiguration,
  DemoSessionOptions,
} from "../session/session-options";
import {
  defaultDemoRenderQuality,
  formatDemoRenderQualityValue,
  getDemoRenderQualityDescription,
  type DemoRenderQuality,
} from "../session/render-quality";

export const QualityControls = memo(function QualityControls({
  configuration,
  disabled,
  onChange,
  onSessionOptionsChange,
  quality,
  sessionOptions,
}: {
  readonly configuration: DemoSessionConfiguration | null;
  readonly disabled: boolean;
  readonly onChange: (quality: DemoRenderQuality) => void;
  readonly onSessionOptionsChange: (options: DemoSessionOptions) => void;
  readonly quality: DemoRenderQuality;
  readonly sessionOptions: DemoSessionOptions;
}) {
  const maskFrame = configuration?.resolved.renderPreparation.maskFrame;
  const preparationGate =
    configuration?.resolved.renderPreparation.playbackGate;
  const libraryPreparationGate =
    configuration === null
      ? undefined
      : readDemoLibraryDefaults(configuration).renderPreparation.playbackGate;
  const waitingForMasks =
    sessionOptions.preparationGateEnabled ?? preparationGate?.enabled ?? false;
  const update = <Key extends keyof DemoSessionOptions>(
    key: Key,
    value: DemoSessionOptions[Key],
  ) => {
    onSessionOptionsChange({ ...sessionOptions, [key]: value });
  };

  return (
    <section className="quality-controls" aria-label="Render quality">
      <header className="inspector-card__header">
        <h2>Quality</h2>
        <span>{getDemoRenderQualityDescription(quality)}</span>
      </header>
      <div className="quality-controls__input-row">
        <label>
          <span>Max DPR</span>
          <input
            disabled={disabled || quality === undefined}
            inputMode="decimal"
            min="0.25"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);

              if (Number.isFinite(value) && value > 0) {
                onChange(value);
              }
            }}
            step="0.25"
            type="number"
            value={quality === undefined ? "" : formatInputValue(quality)}
          />
        </label>
        <label className="quality-controls__toggle">
          <input
            checked={quality === undefined}
            disabled={disabled}
            onChange={(event) => {
              onChange(
                event.currentTarget.checked
                  ? undefined
                  : defaultDemoRenderQuality,
              );
            }}
            type="checkbox"
          />
          <span>No limit</span>
        </label>
      </div>
      {configuration === null ? null : (
        <>
          <ControlSubheading>Masks</ControlSubheading>
          <ControlNote>
            Changing mask settings reopens the clip at the current playhead.
          </ControlNote>
          <NumberControl
            label="Mask preview scale"
            libraryDefault="0.25"
            max={1}
            min={0.01}
            onChange={(value) => update("maskPreviewScale", value)}
            optionPath="maskFrame.previewScale"
            origin={readDemoOptionOrigin(
              sessionOptions.maskPreviewScale,
              sessionOptions.maskPreviewScale ??
                maskFrame?.previewScale ??
                0.25,
              0.25,
            )}
            placeholder="0.25"
            step={0.05}
            tooltip="Masks shown during fast movement use this fraction of the display-fitted width cap, bounded by native mask dimensions. Raise it for sharper previews at greater CPU and memory cost; 1 keeps the full fitted resolution. The visible frame refines when motion stops. `renderer.renderPreparation.maskFrame.previewScale`, default 0.25."
            value={sessionOptions.maskPreviewScale ?? maskFrame?.previewScale}
          />
          <ToggleControl
            checked={waitingForMasks}
            label="Mask playback gate enabled"
            libraryDefault={formatOptionFlag(
              libraryPreparationGate?.enabled ?? false,
            )}
            onChange={(checked) => update("preparationGateEnabled", checked)}
            optionPath="renderPreparation.playbackGate.enabled"
            origin={readDemoOptionOrigin(
              sessionOptions.preparationGateEnabled,
              waitingForMasks,
              libraryPreparationGate?.enabled ?? false,
            )}
            tooltip="The video waits for the masks that belong to the frame it is about to show to be turned into pixels. Off, that frame is drawn without its masks. `renderer.renderPreparation.playbackGate.enabled`, on by default."
          />
          <SegmentedControl
            label="Mask presentation quality"
            libraryDefault="Adaptive"
            onChange={(value) => update("preparationGateQuality", value)}
            optionPath="renderPreparation.playbackGate.quality"
            origin={readDemoOptionOrigin(
              sessionOptions.preparationGateQuality,
              sessionOptions.preparationGateQuality ??
                preparationGate?.quality ??
                "adaptive",
              "adaptive",
            )}
            options={[
              { label: "Adaptive", value: "adaptive" },
              { label: "Fine", value: "fine" },
            ]}
            tooltip="Adaptive accepts smaller mask previews during fast movement. With the mask playback gate enabled, Fine waits for the full display-fitted resolution during playback, scrubbing and seeking. It can increase CPU usage and buffering; the max-wait bound still applies. `renderer.renderPreparation.playbackGate.quality`, default Adaptive."
            value={
              sessionOptions.preparationGateQuality ??
              preparationGate?.quality ??
              "adaptive"
            }
          />
          {waitingForMasks ? null : (
            <ControlNote>
              The mask gate is off. Enable it to apply the selected presentation
              quality.
            </ControlNote>
          )}
        </>
      )}
    </section>
  );
});

function formatInputValue(quality: number) {
  return Number.isInteger(quality)
    ? String(quality)
    : formatDemoRenderQualityValue(quality);
}
