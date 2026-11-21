import { IconTile } from "@ui/components/proto/visual";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "@/components/cockpit/patterns";

export function Row({
  id,
  label,
  hint,
  icon,
  children,
  below,
  testId,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  children?: ReactNode;
  below?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="py-3" data-slot="settings-row" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {icon && <IconTile icon={icon} size="md" />}
        <div className="min-w-0 flex-1">
          <Label htmlFor={id}>{label}</Label>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {children}
      </div>
      {below ? <div className="mt-3 pl-11">{below}</div> : null}
    </div>
  );
}
