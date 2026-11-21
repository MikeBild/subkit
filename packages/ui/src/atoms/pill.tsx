import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";
const tones: Record<Tone, string> = {
  success: "border-success/40 bg-success/10 text-success-ink",
  warning: "border-warning/50 bg-warning/10 text-warning-ink",
  danger: "border-destructive/40 bg-destructive/10 text-destructive-ink",
  info: "border-accent/40 bg-accent/10 text-info-ink",
  neutral: "border-border bg-secondary text-muted-foreground",
};
const dots: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-accent",
  neutral: "bg-muted-foreground",
};

export function Pill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-2 whitespace-nowrap rounded-full border px-2 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1 rounded-full", dots[tone])} />
      {children}
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs", className)}>{children}</span>;
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-card p-6 text-card-foreground", className)}>
      {children}
    </div>
  );
}
