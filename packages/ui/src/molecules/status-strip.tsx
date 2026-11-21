import type { Tone } from "@ui/atoms/pill";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

const stripDot: Record<Tone, string> = {
  success: "bg-emerald-500",
  info: "bg-blue-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};
export function StatusStrip({
  tone,
  children,
  action,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "mb-6 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        className,
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", stripDot[tone])} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {action}
    </div>
  );
}
