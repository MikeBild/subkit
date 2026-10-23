import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const BOX = "grid min-h-[72px] min-w-0 content-center gap-0.5 rounded-lg border px-4 py-3";
const VALUE = "shrink-0 text-2xl font-semibold leading-8 tracking-[-0.02em] tabular-nums";

export function KpiTile({
  label,
  value,
  prefix,
  tone,
  note,
  detail,
  detailTitle,
  testId,
  detailTestId,
  data,
}: {
  label: ReactNode;
  value?: ReactNode;
  prefix?: ReactNode;
  tone?: string | null;
  note?: ReactNode;
  detail?: ReactNode;
  detailTitle?: string;
  testId?: string;
  detailTestId?: string;
  data?: Readonly<Record<`data-${string}`, string | undefined>>;
}) {
  return (
    <div className={BOX} data-slot="kpi-tile" data-testid={testId} {...data}>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      {value !== undefined ? (
        <p className="flex min-w-0 items-baseline gap-1">
          {prefix ? (
            <span className="text-sm font-normal text-muted-foreground">{prefix}</span>
          ) : null}
          <span className={cn(VALUE, tone)}>{value}</span>
        </p>
      ) : null}
      {note ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {note}
        </p>
      ) : null}
      {detail ? (
        <p className="text-xs text-muted-foreground" title={detailTitle} data-testid={detailTestId}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}
