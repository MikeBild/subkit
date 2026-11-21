import { Button } from "@ui/atoms/button";
import { cn } from "@ui/lib/utils";
import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export function BusyButton({
  busy,
  busyLabel,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { busy: boolean; busyLabel: string; children: ReactNode }) {
  return (
    <Button
      {...props}
      disabled={busy || props.disabled}
      aria-busy={busy}
      className={cn("grid", className)}
    >
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
          busy && "invisible",
        )}
      >
        {children}
      </span>
      <span
        aria-hidden={!busy}
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
          !busy && "invisible",
        )}
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {busyLabel}
      </span>
    </Button>
  );
}
