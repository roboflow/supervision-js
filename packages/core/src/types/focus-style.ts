import type { BoxShape } from "#types/box-style";
import type { DetectionFrame } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";

export type FocusStyleValue<T> = T | ((context: FocusStyleContext) => T);

export enum FocusTargetMode {
  Hovered = "hovered",
  Selected = "selected",
  HoveredAndSelected = "hoveredAndSelected",
}

export interface FocusFillStyle {
  readonly color: number;
  readonly alpha: number;
}

export interface FocusFallbackStyle {
  readonly shape: BoxShape;
  readonly cornerRadius?: number;
}

export interface FocusStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly hoveredPick: DetectionPickResult | null;
  readonly selectedPick: DetectionPickResult | null;
}

export interface FocusDrawInstruction {
  readonly fill: FocusFillStyle;
  readonly targets: readonly DetectionPickResult[];
  readonly targetMode?: FocusTargetMode;
  readonly fallback?: FocusFallbackStyle;
}

export interface FocusStyle {
  resolve(context: FocusStyleContext): FocusDrawInstruction | undefined;
}
