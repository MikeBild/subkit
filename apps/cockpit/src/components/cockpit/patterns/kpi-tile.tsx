import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const KPI_TILE_BOX =
  "grid min-h-32 min-w-0 content-start gap-0.5 rounded-lg border px-4 py-3 xl:min-h-0";
export const KPI_TILE_LABEL = "line-clamp-2 min-h-8 text-xs text-muted-foreground xl:min-h-4";
export const KPI_TILE_VALUE_ROW = "flex min-h-8 min-w-0 items-baseline gap-1";
export const KPI_TILE_DETAIL = "min-h-8 text-xs break-words text-muted-foreground";
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
  dense = false,
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
  dense?: boolean;
}) {
  return (
    <div
      className={cn(KPI_TILE_BOX, dense && "min-h-0")}
      data-slot="kpi-tile"
      data-testid={testId}
      {...data}
    >
      <p className={cn(KPI_TILE_LABEL, dense && "min-h-0")}>{label}</p>
      {value !== undefined ? (
        <p className={KPI_TILE_VALUE_ROW}>
          {prefix ? (
            <span className="text-sm font-normal text-muted-foreground">{prefix}</span>
          ) : null}
          <span className={cn(VALUE, tone)}>{value}</span>
        </p>
      ) : null}
      {note ? (
        <p
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground",
            value === undefined ? "min-h-8 text-xs xl:text-sm" : "text-sm",
            dense && "min-h-0 text-sm [overflow-wrap:anywhere]",
          )}
        >
          {note}
        </p>
      ) : null}
      {dense && !detail ? null : (
        <p
          className={cn(KPI_TILE_DETAIL, dense && "min-h-0")}
          title={detailTitle}
          data-testid={detail ? detailTestId : undefined}
        >
          {detail}
        </p>
      )}
    </div>
  );
}
