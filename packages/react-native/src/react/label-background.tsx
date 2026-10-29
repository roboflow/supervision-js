import { Path, RoundedRect } from "@shopify/react-native-skia";
import type { TopLeftRect } from "supervision-js-core";

/** Shared by file and live labels; unspecified corners retain native defaults. */
export function LabelBackground({
  rect,
  color,
  cornerRadius,
  topCornersOnly,
}: {
  readonly rect: TopLeftRect;
  readonly color: string;
  readonly cornerRadius: number;
  readonly topCornersOnly?: boolean;
}) {
  if (!topCornersOnly) {
    return <RoundedRect {...rect} color={color} r={cornerRadius} />;
  }
  const { x, y, width, height } = rect;
  const r = Math.max(0, Math.min(cornerRadius, width / 2, height / 2));
  const right = x + width;
  const bottom = y + height;
  return (
    <Path
      color={color}
      path={`M ${x + r} ${y} L ${right - r} ${y} Q ${right} ${y} ${right} ${y + r} L ${right} ${bottom} L ${x} ${bottom} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`}
    />
  );
}
