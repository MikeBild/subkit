import { cn } from "@ui/lib/utils";
import type { Tone } from "./pill";

const dot: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-muted-foreground",
  neutral: "bg-muted-foreground/60",
};
export function StatusDot({
  tone,
  className,
  pulse,
}: {
  tone: Tone;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        dot[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}
