import { IconTile } from "@ui/atoms/icon-tile";
import type { Tone } from "@ui/atoms/pill";
import { StatusDot } from "@ui/atoms/status-dot";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ConnectionGraphic({
  from,
  via,
  to,
  tone,
  state,
  className,
}: {
  from: ReactNode;
  via: LucideIcon;
  to: ReactNode;
  tone: Tone;
  state: string;
  className?: string;
}) {
  const V = via;
  const line =
    tone === "danger"
      ? "border-destructive/60 border-dashed"
      : tone === "warning"
        ? "border-warning/70 border-dashed"
        : tone === "success"
          ? "border-success/70"
          : "border-border border-dashed";
  return (
    <div className={cn("rounded-xl border bg-muted/30 p-4", className)}>
      <div className="flex items-center">
        {from}
        <span className={cn("mx-2 flex-1 border-t-2", line)} />
        <IconTile icon={V} size="sm" variant="outline" />
        <span className={cn("mx-2 flex-1 border-t-2", line)} />
        {to}
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs">
        <StatusDot tone={tone} pulse={tone === "info"} />
        {state}
      </p>
    </div>
  );
}
