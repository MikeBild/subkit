import { IconTile } from "@ui/atoms/icon-tile";
import { Label } from "@ui/atoms/label";
import { Skel } from "@ui/atoms/skeleton";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SettingsRow({
  id,
  label,
  rawLabel = false,
  hint,
  icon,
  children,
  below,
  phase = "ready",
  className,
  controlClassName,
  testId,
}: {
  id?: string | undefined;
  label: ReactNode;
  rawLabel?: boolean | undefined;
  hint?: ReactNode;
  icon?: LucideIcon | undefined;
  children?: ReactNode;
  below?: ReactNode;
  phase?: "blank" | "skeleton" | "ready";
  className?: string | undefined;
  controlClassName?: string | undefined;
  testId?: string | undefined;
}) {
  const loading = phase !== "ready";
  const region = (content: ReactNode, regionClass: string, iconRegion = false) => (
    <div className={cn("relative", regionClass)}>
      <div
        className={cn(loading && "invisible")}
        inert={loading}
        aria-hidden={loading || undefined}
      >
        {content}
      </div>
      {phase === "skeleton" && (
        <div aria-hidden className="absolute inset-0 flex items-center">
          {iconRegion ? <Skel.Block className="size-8 rounded-lg" /> : <Skel.Line />}
        </div>
      )}
    </div>
  );
  return (
    <div
      className={cn("py-3", className)}
      aria-busy={loading}
      data-slot="settings-row"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center gap-3">
        {icon && region(<IconTile icon={icon} size="md" />, "shrink-0", true)}
        {region(
          <>
            {rawLabel ? label : <Label htmlFor={id}>{label}</Label>}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </>,
          "min-w-0 flex-1 basis-40",
        )}
        {children !== undefined &&
          region(
            <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>,
            cn("ml-auto max-w-full", controlClassName),
          )}
      </div>
      {below ? <div className={cn("mt-3", icon && "pl-11")}>{below}</div> : null}
    </div>
  );
}
