import { cn } from "@ui/lib/utils";
import { Loader2Icon } from "lucide-react";
import { useReducedMotion } from "@/lib/use-reduced-motion";

export function LiveIndicator({
  kind = "pulse",
  className,
  testId,
}: {
  kind?: "pulse" | "spinner";
  className?: string;
  testId?: string;
}) {
  const reduced = useReducedMotion();
  const motion = reduced ? "reduced" : "full";
  if (kind === "spinner" && !reduced)
    return (
      <Loader2Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
        data-testid={testId}
        data-motion={motion}
      />
    );
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex size-2.5 shrink-0", className)}
      data-testid={testId}
      data-motion={motion}
    >
      {reduced ? null : (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
      )}
      <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
    </span>
  );
}
