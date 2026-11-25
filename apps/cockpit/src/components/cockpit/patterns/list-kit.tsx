import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@ui/molecules/dropdown-menu";
import { EmptyState } from "@ui/molecules/empty-state";
import { activeFilterCount, FilterBar, type FilterSelect } from "@ui/organisms/filter-bar";
import { Columns3, SearchX } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type ColumnOption,
  type CreatedBy,
  hideableColumns,
  listCategory,
  nextSort,
  type SortOrder,
  toggleColumn,
} from "@/lib/list-state";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { Button } from "./controls";

export const tid = (...parts: (string | number)[]) =>
  parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

export type GroupKey =
  | "all"
  | "category"
  | "status"
  | "kind"
  | "origin"
  | "scope"
  | "date"
  | "topic";
const GROUP_VALUES: readonly GroupKey[] = [
  "all",
  "category",
  "status",
  "kind",
  "origin",
  "scope",
  "date",
  "topic",
];
const isGroup = (v: string): v is GroupKey => (GROUP_VALUES as readonly string[]).includes(v);
const isOrder = (v: string): v is SortOrder => v === "asc" || v === "desc";
const isCreatedBy = (v: string): v is CreatedBy => v === "all" || v === "ai" || v === "person";
const anyText = (v: string): v is string => v !== "";

export function useListState(defaults?: { category: string | undefined }) {
  const [q, setQ] = useSearchParamState("q", "", anyText);
  const [rawCat, setCat] = useSearchParamState("category", defaults ? "" : "all", anyText);
  const cat = defaults ? listCategory(rawCat, defaults.category) : rawCat;
  const homeCat = defaults?.category ?? "all";
  const [group, setGroup] = useSearchParamState<GroupKey>("group", "all", isGroup);
  const [createdBy, setCreatedBy] = useSearchParamState<CreatedBy>(
    "created_by",
    "all",
    isCreatedBy,
  );
  const [sortKey, setSortKey] = useSearchParamState("sort", "", anyText);
  const [order, setOrder] = useSearchParamState<SortOrder>("order", "asc", isOrder);
  return {
    q,
    setQ,
    cat,
    setCat,
    group,
    setGroup,
    createdBy,
    setCreatedBy,
    sort: { key: sortKey, order },
    sortBy: (key: string) => {
      const next = nextSort({ key: sortKey, order }, key);
      setSortKey(next.key);
      setOrder(next.order);
    },
    dirty: !!q || cat !== homeCat || group !== "all" || createdBy !== "all",
    reset: () => {
      setQ("");
      setCat(defaults ? "" : "all");
      setGroup("all");
      setCreatedBy("all");
    },
  };
}
export type ListState = ReturnType<typeof useListState>;

const GROUP_KEYS = {
  all: "kn.groups.all",
  category: "kn.groups.category",
  status: "kn.groups.status",
  kind: "kn.groups.kind",
  origin: "kn.groups.origin",
  scope: "kn.groups.scope",
  date: "kn.groups.date",
  topic: "kn.groups.topic",
} as const;

const CREATED_KEYS = {
  all: "catalog.createdBy.all",
  ai: "catalog.createdBy.ai",
  person: "catalog.createdBy.person",
} as const;

export interface ColumnChoice {
  options: ColumnOption[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

export function useColumnChoice(head: Head[]): ColumnChoice {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  return {
    options: headColumns(head),
    hidden,
    onToggle: (id) => setHidden((h) => toggleColumn(h, id)),
  };
}

function ColumnsMenu({ choice }: { choice: ColumnChoice }) {
  const { t } = useI18n();
  const options = hideableColumns(choice.options);
  if (options.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-testid="kn-columns" variant="outline" className="ml-auto">
          <Columns3 className="size-4" aria-hidden />
          {t("catalog.columns")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("catalog.columns")}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.id}
            data-testid={tid("kn-column", o.id)}
            checked={!choice.hidden.has(o.id)}
            onCheckedChange={() => choice.onToggle(o.id)}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListToolbar({
  st,
  groups,
  categories,
  createdBy = false,
  filters = [],
  columns,
  onReset,
  categoryLabel = (category) => category,
}: {
  st: ListState;
  groups: GroupKey[];
  categories?: [string, number][];
  createdBy?: boolean;
  filters?: readonly FilterSelect[];
  columns?: ColumnChoice;
  onReset?: () => void;
  categoryLabel?: (category: string, other: string) => string;
}) {
  const { t } = useI18n();
  const other = t("catalog.categoryOther");
  const total = (categories ?? []).reduce((n, [, c]) => n + c, 0);
  const selects: FilterSelect[] = [
    ...filters,
    ...(createdBy
      ? [
          {
            label: t("catalog.createdBy"),
            value: st.createdBy,
            defaultValue: "all",
            onChange: (v: string) => st.setCreatedBy(isCreatedBy(v) ? v : "all"),
            testId: "kn-created-by",
            options: (["all", "ai", "person"] as const).map((v) => ({
              value: v,
              label: t(CREATED_KEYS[v]),
            })),
          },
        ]
      : []),
    {
      label: t("kn.groupBy"),
      value: st.group,
      defaultValue: "all",
      onChange: (v: string) => st.setGroup(isGroup(v) ? v : "all"),
      testId: "kn-group",
      options: (["all", ...groups] as GroupKey[]).map((g) => ({
        value: g,
        label: t(GROUP_KEYS[g]),
      })),
    },
  ];
  const reset = onReset ?? st.reset;
  const dirty = st.dirty || activeFilterCount(filters) > 0;
  return (
    <div className="mb-4 flex flex-col gap-3" data-slot="list-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <FilterBar
          search={{
            value: st.q,
            onChange: st.setQ,
            placeholder: t("kn.search"),
            testId: "kn-search",
          }}
          selects={selects}
          reset={{ label: t("kn.reset"), onClick: reset }}
        />
        {dirty && (
          <Button data-testid="kn-reset" variant="ghost" onClick={reset}>
            {t("kn.reset")}
          </Button>
        )}
        {columns && <ColumnsMenu choice={columns} />}
      </div>
      {categories && (categories.length > 1 || st.cat !== "all") && (
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-1" aria-label={t("kn.groups.category")}>
          {[["all", total] as [string, number], ...categories].map(([c, n]) => (
            <Button
              key={c}
              data-testid={tid("kn-category", c)}
              size="sm"
              variant={st.cat === c ? "secondary" : "ghost"}
              aria-pressed={st.cat === c}
              className="rounded-full"
              onClick={() => st.setCat(c)}
            >
              {c === "all" ? t("kn.groups.all") : categoryLabel(c, other)}
              <span className="font-mono text-xs text-muted-foreground">{n}</span>
            </Button>
          ))}
        </fieldset>
      )}
    </div>
  );
}

export function NoMatch({ onReset }: { onReset?: () => void }) {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={SearchX}
      title={t("kn.noMatch")}
      text={t("kn.noMatchHint")}
      action={
        onReset ? (
          <Button data-testid="kn-nomatch-reset" size="sm" variant="outline" onClick={onReset}>
            {t("kn.reset")}
          </Button>
        ) : undefined
      }
    />
  );
}

export type Head = string | { label: string; sort?: string; id?: string; priority?: "low" };

export function headColumns(head: Head[]): ColumnOption[] {
  return head.map((h, i) =>
    typeof h === "string"
      ? { id: h || `column-${i}`, label: h }
      : {
          id: h.id ?? h.sort ?? h.label,
          label: h.label,
          ...(h.priority ? { priority: h.priority } : {}),
        },
  );
}

export function ListSummary({
  parts,
  aiCount,
  testId,
  loaded,
}: {
  parts: ReactNode[];
  aiCount?: number | null;
  testId?: string;
  loaded?: { items: unknown[]; total: number; truncated?: boolean } | undefined;
}) {
  const { t, locale } = useI18n();
  const count = new Intl.NumberFormat(LOCALE_TAGS[locale]);
  const all = [...parts, aiCount ? t("catalog.aiCount", { count: aiCount }) : null].filter(
    (p) => p !== null && p !== false && p !== "",
  );
  return (
    <>
      <p
        className="mb-3 flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground"
        data-testid={testId}
      >
        {all.map((p, i) => (
          <Fragment key={typeof p === "string" ? p : i}>
            {i > 0 && <span aria-hidden>·</span>}
            {p}
          </Fragment>
        ))}
      </p>
      {loaded?.truncated && (
        <p className="mb-3 text-sm text-warning-ink" role="status" data-testid="kn-list-partial">
          {t("kn.partial", {
            n: count.format(loaded.items.length),
            total: count.format(loaded.total),
          })}
        </p>
      )}
    </>
  );
}
