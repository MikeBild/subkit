import { IconTile } from "@ui/components/proto/visual";
import { Label } from "@ui/components/ui/label";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SettingRow({
  id,
  label,
  hint,
  icon,
  className,
  children,
}: {
  id?: string | undefined;
  label: string;
  hint?: string | undefined;
  icon?: LucideIcon | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2", className)}
    >
      {icon && <IconTile icon={icon} size="md" />}
      <div className="min-w-0 flex-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
