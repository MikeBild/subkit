import { createColumnHelper, type RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import type { CockpitColumn, CockpitTableFeatures } from "@/components/cockpit/data-table";
import { Badge } from "@/components/ui/badge";
import type { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

/** A value nobody sent (CUI-SEV-2). Never `0`, never an empty cell. */
export const MISSING = "—";

/**
 * A scalar as a word.
 *
 * An empty array used to render as `0`, so a workflow that reaches no
 * connector at all claimed a measured count of zero connections. An unmeasured
 * fact and a measured zero read differently (CUI-SEV-2).
 */
export function stringValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return MISSING;
  if (Array.isArray(value)) return value.length === 0 ? MISSING : String(value.length);
  return String(value);
}

/**
 * A byte count as a word. `null` is unmeasured and reads `—`; `0` is a
 * measured, empty file and reads `0 B`. They are different facts.
 */
export function bytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export interface Relation {
  /** `null` renders the label as plain text: a link to nowhere is worse than a word. */
  href: string | null;
  label: string;
}

interface ColumnOptions {
  sortable?: boolean;
  /** A Tailwind width class; declared widths are what keep the table `table-fixed`. */
  width?: string;
  /**
   * The cell places the row's link itself (`<RowName>`), because it holds more
   * than the name — a link of its own must not end up inside the row's link.
   */
  ownsRowLink?: boolean;
}

/**
 * The cell vocabulary every list shares.
 *
 * Each list picks its own columns, but a date, a state and a relation must
 * look and behave the same on all of them — that sameness is the whole point
 * of the refactor these helpers came out of.
 */
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
    meta: { width: options?.width, ownsRowLink: options?.ownsRowLink },
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
          // The badge primitive is `whitespace-nowrap` by default, which is
          // right for a one-word chip and wrong here: a state word can be
          // "Zugangsdaten abgelehnt", and in a `table-fixed` cell a pill that
          // refuses to wrap paints over the next column instead of growing.
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
        ...base(id, label, options),
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

    /** A single relation. Following it must not also open the row. */
    link(
      id: string,
      get: (row: TRow) => Relation | null,
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor((row): unknown => get(row)?.label ?? null, {
        ...base(id, label, options),
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

    /** A list of relations. An empty list is `—`, never `0`. */
    chips(
      id: string,
      get: (row: TRow) => Relation[],
      label: string,
      options?: ColumnOptions,
    ): CockpitColumn<TRow> {
      return helper.accessor((row): unknown => get(row).length, {
        ...base(id, label, options),
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
                  title={t("common.moreRelations", { count: hidden })}
                >
                  <span aria-hidden="true">+{hidden}</span>
                  <span className="sr-only">{t("common.moreRelations", { count: hidden })}</span>
                </span>
              ) : null}
            </span>
          );
        },
      });
    },

    /** Anything the shared vocabulary does not cover, still with a declared width. */
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
