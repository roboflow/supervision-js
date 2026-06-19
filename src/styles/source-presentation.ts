import { BaseBoxStyle } from "#styles/box-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import type {
  BoxDrawInstruction,
  BoxStyle,
  BoxStyleContext,
} from "#types/box-style";
import type { Detection } from "#types/detections";
import type {
  LabelDrawInstruction,
  LabelStyle,
  LabelStyleContext,
} from "#types/label-style";
import type {
  MaskDrawInstruction,
  MaskStyle,
  MaskStyleContext,
} from "#types/mask-style";
import type { MediaRendererPresentation } from "#types/media-renderer";

export type SourcePresentation = Pick<
  MediaRendererPresentation,
  "boxStyle" | "labelStyle" | "maskStyle"
>;

export interface SourcePresentationEntry {
  readonly id: string;
  readonly presentation?: SourcePresentation;
}

export function createSourceAwarePresentation(
  globalPresentation: MediaRendererPresentation = {},
  sources: readonly SourcePresentationEntry[],
): MediaRendererPresentation {
  if (!sources.some((source) => source.presentation !== undefined)) {
    return globalPresentation;
  }

  const sourcePresentations = new Map(
    sources.map((source) => [source.id, source.presentation] as const),
  );

  return {
    ...globalPresentation,
    boxStyle: hasSourceStyle(sources, "boxStyle")
      ? new SourceAwareBoxStyle(
          normalizeGlobalBoxStyle(globalPresentation.boxStyle),
          sourcePresentations,
        )
      : globalPresentation.boxStyle,
    labelStyle: hasSourceStyle(sources, "labelStyle")
      ? new SourceAwareLabelStyle(
          normalizeGlobalLabelStyle(globalPresentation.labelStyle),
          sourcePresentations,
        )
      : globalPresentation.labelStyle,
    maskStyle: hasSourceStyle(sources, "maskStyle")
      ? new SourceAwareMaskStyle(
          normalizeGlobalMaskStyle(globalPresentation.maskStyle),
          sourcePresentations,
        )
      : globalPresentation.maskStyle,
  };
}

class SourceAwareBoxStyle implements BoxStyle {
  constructor(
    private readonly globalStyle: BoxStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "boxStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareLabelStyle implements LabelStyle {
  constructor(
    private readonly globalStyle: LabelStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "labelStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareMaskStyle implements MaskStyle {
  readonly artifactKey = undefined;
  readonly opacity: number | undefined;

  constructor(
    private readonly globalStyle: MaskStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {
    this.opacity = globalStyle?.opacity;
  }

  resolve(
    detection: Detection,
    context: MaskStyleContext,
  ): MaskDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "maskStyle",
    );

    return style?.resolve(detection, context);
  }
}

function hasSourceStyle(
  sources: readonly SourcePresentationEntry[],
  key: keyof SourcePresentation,
) {
  return sources.some((source) => source.presentation?.[key] !== undefined);
}

function resolveSourceStyle<
  TKey extends keyof SourcePresentation,
  TStyle extends NonNullable<SourcePresentation[TKey]>,
>(
  detection: Detection,
  globalStyle: TStyle | null,
  sourcePresentations: ReadonlyMap<string, SourcePresentation | undefined>,
  key: TKey,
): TStyle | null {
  const sourcePresentation = detection.sourceId
    ? sourcePresentations.get(detection.sourceId)
    : undefined;
  const sourceStyle = sourcePresentation?.[key];

  return sourceStyle === undefined ? globalStyle : (sourceStyle as TStyle);
}

function normalizeGlobalBoxStyle(style: BoxStyle | null | undefined) {
  return style === undefined ? new BaseBoxStyle() : style;
}

function normalizeGlobalLabelStyle(style: LabelStyle | null | undefined) {
  return style === undefined ? new BaseLabelStyle() : style;
}

function normalizeGlobalMaskStyle(style: MaskStyle | null | undefined) {
  return style === undefined ? new BaseMaskStyle() : style;
}
