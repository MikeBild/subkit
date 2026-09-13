import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "@/components/cockpit/icon-button";

export function ContextHelp({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <IconButton
      type="button"
      variant="ghost"
      size="icon-sm"
      label={label}
      tooltip={<span className="max-w-72 text-pretty">{children}</span>}
      data-testid={testId}
      className="shrink-0 text-muted-foreground"
    >
      <CircleHelp />
    </IconButton>
  );
}
