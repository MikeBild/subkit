import { createColumnHelper, type RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import type { CockpitColumn, CockpitTableFeatures } from "@/components/cockpit/patterns/data-table";
import { Badge } from "@/components/ui/badge";
import { pluralKey } from "@/lib/i18n";
import type { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

export const MISSING = "—";

export function stringValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return MISSING;
  if (Array.isArray(value)) return value.length === 0 ? MISSING : String(value.length);
  return String(value);
}

export function bytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export interface Relation {
  href: string | null;
  label: string;
}

interface ColumnOptions {
  sortable?: boolean;
  width?: string;
  align?: "start" | "end";
  ownsRowLink?: boolean;
  interactive?: boolean;
  cardLabel?: boolean;
}

export function tableColumns<TRow extends RowData>({
  t,
  dateTime,
}: {
  t: ReturnType<typeof useI18n>["t"];
  dateTime: ReturnType<typeof useI18n>["dateTime"];
}) {
  const helper = createColumnHelper<CockpitTableFeatures, TRow>();

  const base = (id: string, label: string, options?: ColumnOptions) => ({
    id,
    header: label,
    enableSorting: options?.sortable ?? false,
    meta: {
      width: options?.width,
      align: options?.align,
      ownsRowLink: options?.ownsRowLink,
      interactive: options?.interactive,
      cardLabel: options?.cardLabel,
    },
  });

  return {
    helper,

    text(
      id: string,
      get: (row: TRow) => unknown,
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor(get, {
        ...base(id, label, options),
        cell: ({ getValue }) => stringValue(getValue()),
      });
    },

    status(
      id: string,
      get: (row: TRow) => unknown,
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor(get, {
        ...base(id, label, options),
        cell: ({ getValue }) => {
          const value = getValue();
          if (value === null || value === undefined || value === "") return MISSING;
          const label = statusLabel(t, String(value));
          return (
            <Badge
              variant="outline"
              className="h-auto max-h-10 overflow-hidden whitespace-normal text-left"
              title={label}
            >
              {label}
            </Badge>
          );
        },
      });
    },

    date(
      id: string,
      get: (row: TRow) => unknown,
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor(get, {
        ...base(id, label, { cardLabel: true, ...options }),
        cell: ({ getValue }) => {
          const value = getValue();
          return typeof value === "string" && value ? dateTime(value) : MISSING;
        },
      });
    },

    bytes(
      id: string,
      get: (row: TRow) => unknown,
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor(get, {
        ...base(id, label, options),
        cell: ({ getValue }) => <span className="tabular-nums">{bytes(getValue())}</span>,
      });
    },

    link(
      id: string,
      get: (row: TRow) => Relation | null,
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor((row): unknown => get(row)?.label ?? null, {
        ...base(id, label, { ...options, interactive: true }),
        cell: ({ row }) => {
          const relation = get(row.original);
          if (!relation?.label) return MISSING;
          if (!relation.href) return relation.label;
          return (
            <a
              className="font-medium underline-offset-4 hover:underline"
              href={relation.href}
              data-testid={`${id}-link-${row.index}`}
              onClick={(event) => event.stopPropagation()}
            >
              {relation.label}
            </a>
          );
        },
      });
    },

    chips(
      id: string,
      get: (row: TRow) => Relation[],
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor((row): unknown => get(row).length, {
        ...base(id, label, { ...options, interactive: true }),
        cell: ({ row }) => {
          const relations = get(row.original);
          if (relations.length === 0) return MISSING;
          const visible = relations.slice(0, 1);
          const hidden = relations.length - visible.length;
          return (
            <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
              {visible.map((relation, index) =>
                relation.href ? (
                  <a
                    key={relation.label}
                    className="block max-w-full truncate rounded-md border px-1.5 py-0.5 text-xs underline-offset-4 hover:underline"
                    href={relation.href}
                    title={relation.label}
                    data-testid={`${id}-chip-${row.index}-${index}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {relation.label}
                  </a>
                ) : (
                  <span
                    key={relation.label}
                    className="block max-w-full truncate rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground"
                    title={relation.label}
                  >
                    {relation.label}
                  </span>
                ),
              )}
              {hidden > 0 ? (
                <span
                  className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground"
                  title={t(pluralKey("common.moreRelations", hidden), { count: hidden })}
                >
                  <span aria-hidden="true">+{hidden}</span>
                  <span className="sr-only">
                    {t(pluralKey("common.moreRelations", hidden), { count: hidden })}
                  </span>
                </span>
              ) : null}
            </span>
          );
        },
      });
    },

    custom(
      id: string,
      get: (row: TRow) => unknown,
      label: string,
      render: (row: TRow, index: number) => ReactNode,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor(get, {
        ...base(id, label, options),
        cell: ({ row }) => render(row.original, row.index),
      });
    },
  };
}
