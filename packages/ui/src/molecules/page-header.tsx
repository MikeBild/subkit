import type { ReactNode } from "react";

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {actions}
      </div>
      {lead && <p className="mt-3 max-w-prose text-sm text-muted-foreground">{lead}</p>}
    </div>
  );
}
