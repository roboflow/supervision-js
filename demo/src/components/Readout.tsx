import { memo, type ReactNode } from "react";

export const Readout = memo(function Readout({
  className,
  label,
  tone = "default",
  value,
}: {
  readonly className?: string;
  readonly label: string;
  readonly tone?: "danger" | "default";
  readonly value: ReactNode;
}) {
  const classNames = ["readout", `readout--${tone}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classNames}>
      <strong className="readout__label">{label}</strong>
      <span className="readout__value">{value}</span>
    </span>
  );
});
