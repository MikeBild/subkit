import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconTile } from "@ui/atoms/icon-tile";
import { Panel, type Tone } from "@ui/atoms/pill";
import { StatusDot } from "@ui/atoms/status-dot";
import { useUi } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/molecules/dropdown-menu";
import { EmptyState } from "@ui/molecules/empty-state";
import { IconButton } from "@ui/molecules/icon-button";
import { StatusStrip } from "@ui/molecules/status-strip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/molecules/tabs";
import { ConfirmDialog } from "@ui/organisms/confirm-dialog";
import { activeFilterCount, FilterBar, type FilterSelect } from "@ui/organisms/filter-bar";
import { MarkdownDocument } from "@ui/organisms/markdown-document";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Columns3,
  History,
  type LucideIcon,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Plus,
  SearchX,
} from "lucide-react";
import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiCall } from "@/api/call";
import type { PackageKind } from "@/api/packages";
import { type ChatReferenceSeed, chatNewHref, routerTarget } from "@/app/links";
import { useSession } from "@/app/session";
import type { ActionMenuItem } from "@/components/cockpit/patterns/action-menu";
import { Button } from "@/components/cockpit/patterns/controls";
import { DataState } from "@/components/cockpit/patterns/data-state";
import { priorityClass } from "@/components/cockpit/patterns/data-table";
import { FactList } from "@/components/cockpit/patterns/fact-list";
import { measureClass } from "@/components/cockpit/patterns/measure";
import { PageTitle } from "@/components/cockpit/patterns/page-title";
import { RecordSheet } from "@/components/cockpit/patterns/record-sheet";
import { SectionSubheading } from "@/components/cockpit/patterns/section";
import { SideDetails, SideSection } from "@/components/cockpit/patterns/side-details";
import type { CatalogKind, CatalogMetadataRecord } from "@/features/catalog";
import {
  CatalogCategories,
  CatalogMetadataDialog,
  catalogAICount,
  useCatalogMetadataActions,
} from "@/features/catalog";
import { lineDiff, relTime } from "@/features/knowledge/model/knowledge";
import { usePackageActions } from "@/features/settings";
import { humanizeCategory } from "@/features/workflows/model";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import {
  type ColumnFit,
  type ColumnOption,
  type CreatedBy,
  columnFits,
  columnMask,
  hideableColumns,
  listCategory,
  nextSort,
  type SortOrder,
  toggleColumn,
} from "./list-model";
import type { UseRow } from "./uses-model";

export { Panel };

export function useRel() {
  const { locale } = useI18n();
  const { now } = useUi();
  return (iso: string) => relTime(iso, now(), LOCALE_TAGS[locale]);
}

export const tid = (...parts: (string | number)[]) =>
  parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

export function MenuItems({ items }: { items: readonly ActionMenuItem[] }) {
  return (
    <>
      {items.map((a) => (
        <DropdownMenuItem
          key={a.testId ?? a.label}
          data-testid={a.testId}
          disabled={a.disabled}
          className={a.destructive ? "text-destructive-ink" : undefined}
          onSelect={() => a.onSelect?.()}
        >
          {a.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

export function ChatMenu({
  prompts,
  extra,
  items = [],
  label,
  references,
  testId = "kn-menu",
}: {
  prompts: string[];
  extra?: ReactNode;
  items?: readonly ActionMenuItem[];
  label?: string;
  references?: ChatReferenceSeed[];
  testId?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const canChat = permissions.includes("conversation:write");
  const hasExtra = !!extra || items.length > 0;
  const chat = canChat && prompts.length > 0;
  if (!hasExtra && !chat) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          variant="outline"
          size="icon"
          label={label ?? t("kn.pageMenu")}
          data-testid={testId}
        >
          <MoreHorizontal className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {extra}
        <MenuItems items={items} />
        {hasExtra && chat && <DropdownMenuSeparator />}
        {chat && (
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            {t("kn.inChat")}
          </DropdownMenuLabel>
        )}
        {(chat ? prompts : []).map((p, i) => (
          <DropdownMenuItem
            key={p}
            data-testid={tid(testId, "chat", i)}
            onSelect={() =>
              void navigate(
                routerTarget(chatNewHref({ prompt: p, references: references ?? null })),
              )
            }
          >
            <MessageSquare className="size-4" aria-hidden />
            {p}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OnboardingCard({
  icon,
  title,
  text,
  children,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <Panel className="mb-6">
      <div className="flex items-start gap-4">
        <IconTile icon={icon} size="lg" tone="info" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{text}</p>
          {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
        </div>
      </div>
    </Panel>
  );
}

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

export function Toolbar({
  st,
  groups,
  categories,
  createdBy = false,
  filters = [],
  columns,
  onReset,
}: {
  st: ListState;
  groups: GroupKey[];
  categories?: [string, number][];
  createdBy?: boolean;
  filters?: readonly FilterSelect[];
  columns?: ColumnChoice;
  onReset?: () => void;
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
              {c === "all" ? t("kn.groups.all") : humanizeCategory(c, other)}
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

const FIT_CLASS: Record<ColumnFit, string> = {
  control: "w-12",
  name: "",
  fit: "w-36 truncate",
  low: cn("w-36 truncate", priorityClass("low")),
};

function shownCells(el: ReactNode, mask: boolean[], fits: ColumnFit[]): ReactNode {
  if (!isValidElement(el)) return el;
  const row = el as ReactElement<{ children?: ReactNode }>;
  return cloneElement(
    row,
    undefined,
    Children.toArray(row.props.children)
      .filter((_, i) => mask[i] !== false)
      .map((cell, i) => {
        const fit = fits[i];
        if (!fit || !isValidElement(cell)) return cell;
        const td = cell as ReactElement<{ className?: string }>;
        return cloneElement(td, { className: cn(td.props.className, FIT_CLASS[fit]) });
      }),
  );
}

export function GroupedTable<T>({
  head: allHead,
  groups,
  row,
  sort,
  onSort,
  hidden,
}: {
  head: Head[];
  groups: [string, T[]][];
  row: (x: T) => ReactNode;
  sort?: { key: string; order: SortOrder };
  onSort?: (key: string) => void;
  hidden?: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const options = headColumns(allHead);
  const mask = columnMask(options, hidden ?? new Set());
  const head = allHead.filter((_, i) => mask[i]);
  const fits = columnFits(options).filter((_, i) => mask[i]);
  return (
    <div className="@container overflow-x-clip rounded-lg ring-1 ring-inset ring-border">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b">
            {head.map((h, i) => {
              const label = typeof h === "string" ? h : h.label;
              const key = typeof h === "string" ? null : (h.sort ?? null);
              const active = key !== null && sort?.key === key;
              return (
                <th
                  key={label || i}
                  aria-sort={
                    active ? (sort?.order === "asc" ? "ascending" : "descending") : undefined
                  }
                  className={cn(
                    "h-10 px-3 text-left text-xs font-medium text-muted-foreground first:pl-4 last:pr-4",
                    fits[i] && FIT_CLASS[fits[i]],
                  )}
                >
                  {key !== null && onSort ? (
                    <button
                      type="button"
                      data-testid={tid("kn-sort", key)}
                      title={t("kn.sortBy", { column: label })}
                      onClick={() => onSort(key)}
                      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground"
                    >
                      {label}
                      {active && sort?.order === "asc" && (
                        <ArrowUp className="size-3" aria-hidden />
                      )}
                      {active && sort?.order === "desc" && (
                        <ArrowDown className="size-3" aria-hidden />
                      )}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {groups.map(([label, items]) => (
            <Fragment key={label || "all"}>
              {label && (
                <tr className="bg-muted/40">
                  <th
                    colSpan={head.length}
                    className="h-8 px-4 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {label} <span className="font-mono font-normal">· {items.length}</span>
                  </th>
                </tr>
              )}
              {items.map((x) => shownCells(row(x), mask, fits))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Row({
  children,
  onOpen,
  label,
  testId = "kn-row",
}: {
  children: ReactNode;
  onOpen: () => void;
  label: string;
  testId?: string;
}) {
  return (
    <tr
      data-testid={testId}
      className="cursor-pointer border-b last:border-0 hover:bg-muted/40 [&>td]:h-12 [&>td]:px-3 [&>td]:py-2 [&>td:first-child]:pl-4 [&>td:last-child]:pr-4"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      tabIndex={0}
      aria-label={label}
    >
      {children}
    </tr>
  );
}

export function NameCell({
  icon,
  title,
  sub,
}: {
  icon: ReactNode;
  title: string;
  sub?: string | null | undefined;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", measureClass("name"))}>
      {icon}
      <div className="min-w-0">
        <p className="truncate font-medium">{title}</p>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

export function StatusCell({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

export interface DetailFact {
  label: string;
  value: ReactNode;
  mono?: boolean;
}
export function DetailShell({
  back,
  onBack,
  icon,
  title,
  sub,
  strip,
  menu,
  tabs,
  facts,
  tab,
  onTab,
  actions,
}: {
  back: string;
  onBack: () => void;
  icon: ReactNode;
  title: string;
  sub?: ReactNode;
  strip: { tone: Tone; text: ReactNode; action?: ReactNode };
  menu: ReactNode;
  tabs: { id: string; label: string; content: ReactNode }[];
  facts: DetailFact[];
  tab?: string;
  onTab?: (v: string) => void;
  actions?: ReactNode;
}) {
  return (
    <div>
      <Button
        data-testid="kn-back"
        variant="ghost"
        size="sm"
        className="-ml-3 mb-3"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" aria-hidden />
        {back}
      </Button>
      <div className="mb-6 flex min-h-10 flex-wrap items-center gap-3">
        {icon}
        <div className="min-w-0 flex-1 basis-48">
          <PageTitle testId="kn-detail-title">{title}</PageTitle>
          {sub && <p className="mt-1 truncate text-sm text-muted-foreground">{sub}</p>}
        </div>
        <div className="flex items-center gap-2 max-[639px]:w-full max-[639px]:justify-end">
          {actions}
          {menu}
        </div>
      </div>
      <StatusStrip tone={strip.tone} action={strip.action}>
        {strip.text}
      </StatusStrip>
      <Tabs
        {...(tab ? { value: tab } : { defaultValue: tabs[0]?.id ?? "" })}
        {...(onTab ? { onValueChange: onTab } : {})}
        className="min-w-0"
      >
        <TabsList className="mb-6">
          {tabs.map((x) => (
            <TabsTrigger key={x.id} data-testid={tid("kn-tab", x.id)} value={x.id}>
              {x.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((x) => (
          <TabsContent key={x.id} value={x.id} className="mt-0">
            {x.content}
          </TabsContent>
        ))}
      </Tabs>
      <SideDetails>
        <TechFacts facts={facts} />
      </SideDetails>
    </div>
  );
}

export function TechFacts({ facts }: { facts: DetailFact[] }) {
  const { t } = useI18n();
  return (
    <SideSection title={t("kn.technical")} testId="kn-facts">
      <FactList
        layout="stacked"
        items={facts.map((f) => ({
          label: f.label,
          value: f.mono ? <span className="break-all font-mono text-xs">{f.value}</span> : f.value,
        }))}
      />
    </SideSection>
  );
}

export function ConfirmDelete({
  open,
  onOpenChange,
  name,
  warning,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  name: string;
  warning?: string | undefined;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      destructive
      testId="kn-delete-confirm"
      open={open}
      onOpenChange={onOpenChange}
      title={t("kn.deleteTitle", { name })}
      consequence={warning ?? t("kn.deleteBody")}
      confirmLabel={t("kn.delete")}
      onConfirm={() => {
        onOpenChange(false);
        onConfirm();
      }}
    />
  );
}

export type Use = UseRow;

const USE_KEYS = {
  workflow: "kn.use.workflow",
  chat: "kn.use.chat",
  task: "kn.use.task",
  intake: "kn.use.intake",
  connector: "kn.use.connector",
  other: "kn.use.other",
} as const;
export function UsageList({ uses, empty }: { uses: Use[]; empty?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (!uses.length)
    return <p className="text-sm text-muted-foreground">{empty ?? t("kn.noUses")}</p>;
  return (
    <ul className="divide-y rounded-xl border">
      {uses.map((u, i) => (
        <li key={u.href}>
          <button
            type="button"
            data-testid={tid("kn-use", i)}
            onClick={() => void navigate({ to: u.href })}
            className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/40"
          >
            <span className="w-24 shrink-0 text-xs text-muted-foreground">
              {u.line ?? t(USE_KEYS[u.kind])}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function useAiCount(kind: CatalogKind): number | null {
  const query = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () => apiCall("get", "/v1/categories", {}),
  });
  return query.error ? null : catalogAICount(query.data?.categories, kind);
}

export function ListSummary({
  parts,
  kind,
  testId,
}: {
  parts: ReactNode[];
  kind?: CatalogKind;
  testId?: string;
}) {
  const { t } = useI18n();
  const ai = useAiCount(kind ?? "file");
  const all = [...parts, kind && ai ? t("catalog.aiCount", { count: ai }) : null].filter(
    (p) => p !== null && p !== false && p !== "",
  );
  return (
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
  );
}

export interface VersionItem {
  key: string;
  v: number;
  by: string;
  at: string;
  current: boolean;
  note?: string | null;
}
export function VersionsTab({
  versions,
  load,
  onRestore,
  busy,
  canRestore = true,
  summary,
  note,
}: {
  versions: VersionItem[];
  load: (key: string) => Promise<string>;
  onRestore: (key: string) => void;
  busy?: boolean;
  canRestore?: boolean;
  summary?: string | undefined;
  note?: string | null | undefined;
}) {
  const { t, dateTime } = useI18n();
  const [picked, setPicked] = useSearchParamState("version", "", anyText);
  const open = picked || null;
  const setOpen = (key: string | null) => setPicked(key ?? "");
  const [confirm, setConfirm] = useState<VersionItem | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const sel = versions.find((x) => x.key === open);
  const prev = sel ? versions.find((x) => x.v < sel.v) : undefined;
  const selKey = sel?.key;
  const prevKey = prev?.key;
  useEffect(() => {
    for (const key of [selKey, prevKey]) {
      if (!key || asked.current.has(key)) continue;
      asked.current.add(key);
      void load(key)
        .then((text) => setTexts((m) => ({ ...m, [key]: text })))
        .catch(() => setTexts((m) => ({ ...m, [key]: "" })));
    }
  }, [selKey, prevKey, load]);
  const show = (key: string) => setOpen(key);
  const selText = sel ? texts[sel.key] : undefined;
  const prevText = prev ? texts[prev.key] : undefined;
  const diff = useMemo(
    () => (selText !== undefined && prevText !== undefined ? lineDiff(prevText, selText) : null),
    [selText, prevText],
  );
  const noteLine = note ? (
    <p className="mt-3 text-sm text-muted-foreground" data-testid="kn-versions-note">
      {note}
    </p>
  ) : null;
  if (!versions.length)
    return (
      <>
        <p className="text-sm text-muted-foreground">{t("kn.noVersions")}</p>
        {noteLine}
      </>
    );
  return (
    <>
      {summary && (
        <p className="mb-3 text-sm text-muted-foreground" data-testid="kn-versions-summary">
          {summary}
        </p>
      )}
      <ul className="divide-y rounded-xl border">
        {versions.map((x) => (
          <li key={x.key}>
            <button
              type="button"
              data-testid={tid("kn-version", x.v)}
              onClick={() => show(x.key)}
              className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/40"
            >
              <IconTile icon={History} size="sm" />
              <span className="font-medium">{t("kn.versionN", { n: x.v })}</span>
              {x.current && (
                <span className="rounded-full border border-success/40 bg-success/10 px-2 text-xs font-medium leading-5 text-success-ink">
                  {t("kn.current")}
                </span>
              )}
              {x.note && <span className="min-w-0 truncate text-muted-foreground">{x.note}</span>}
              <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                {x.by} · {dateTime(x.at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {noteLine}
      <RecordSheet
        open={!!sel}
        onOpenChange={(v) => !v && setOpen(null)}
        testId="kn-version-sheet"
        title={
          sel
            ? `${t("kn.versionN", { n: sel.v })}${sel.current ? ` · ${t("kn.current")}` : ""}`
            : ""
        }
        subtitle={sel ? `${sel.by} · ${dateTime(sel.at)}` : undefined}
      >
        {sel && (
          <div className="flex flex-col gap-3">
            <SectionSubheading>
              {prev ? t("kn.diffTitle", { n: prev.v }) : t("kn.firstVersion")}
            </SectionSubheading>
            {diff && (
              <div className="overflow-hidden rounded-lg border font-mono text-xs">
                {!diff.added.length && !diff.removed.length && (
                  <p className="p-3 text-muted-foreground">{t("kn.noDiff")}</p>
                )}
                {diff.removed.map((x, i) => (
                  <p
                    key={`r${i}-${x}`}
                    className="flex gap-2 bg-destructive/10 px-3 py-1 text-destructive-ink"
                  >
                    <Minus className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {x}
                  </p>
                ))}
                {diff.added.map((x, i) => (
                  <p
                    key={`a${i}-${x}`}
                    className="flex gap-2 bg-success/10 px-3 py-1 text-success-ink"
                  >
                    <Plus className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {x}
                  </p>
                ))}
              </div>
            )}
            {selText !== undefined && (
              <div className="mt-3 rounded-lg border p-4">
                <MarkdownDocument text={selText} toc={false} />
              </div>
            )}
            {!sel.current && canRestore && (
              <Button
                data-testid="kn-version-restore"
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => setConfirm(sel)}
              >
                {t("kn.restore")}
              </Button>
            )}
          </div>
        )}
      </RecordSheet>
      <ConfirmDialog
        testId="kn-restore-confirm"
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={confirm ? t("kn.restoreTitle", { n: confirm.v }) : ""}
        consequence={t("kn.restoreBody")}
        confirmLabel={t("kn.restore")}
        onConfirm={() => {
          if (confirm) onRestore(confirm.key);
          setConfirm(null);
          setOpen(null);
        }}
      />
    </>
  );
}

export function Loaded<T>({
  query,
  children,
}: {
  query: { data: T | undefined; isError: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError)
    return (
      <DataState
        state="error"
        scope="page"
        error={query.error}
        onRetry={() => void query.refetch()}
        testId="kn"
      />
    );
  return <ListSkeleton />;
}

export function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <div className="h-10 w-1/3 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-muted/70" />
      ))}
    </div>
  );
}

export function useMetadataMenu({
  kind,
  id,
  record,
  queryKey,
  nameKey,
}: {
  kind: CatalogKind;
  id: string;
  record: CatalogMetadataRecord;
  queryKey: readonly unknown[];
  nameKey?: "name" | "filename" | "title";
}) {
  const [open, setOpen] = useState(false);
  const actions = useCatalogMetadataActions({
    kind,
    id,
    record,
    queryKey,
    onEdit: () => setOpen(true),
  });
  return {
    items: actions.map((a) => (
      <DropdownMenuItem
        key={a.testId ?? a.label}
        data-testid={`kn-${a.testId ?? "metadata"}`}
        disabled={a.disabled}
        onSelect={() => a.onSelect?.()}
      >
        {a.label}
      </DropdownMenuItem>
    )),
    dialog: (
      <CatalogMetadataDialog
        kind={kind}
        id={id}
        record={record}
        open={open}
        onOpenChange={setOpen}
        queryKey={queryKey}
        {...(nameKey ? { nameKey } : {})}
      />
    ),
  };
}

export function usePageMenu({
  pkg,
  categories,
  category,
}: {
  pkg?: PackageKind;
  categories?: CatalogKind | "intake";
  category?: string;
}) {
  const { t } = useI18n();
  const { permissions } = useSession();
  const [open, setOpen] = useState(false);
  const packages = usePackageActions({
    permissions,
    kind: pkg ?? "file",
    category: category && category !== "all" ? category : undefined,
  });
  const items: ActionMenuItem[] = [
    ...(categories
      ? [
          {
            label: t("catalogCategories.title"),
            onSelect: () => setOpen(true),
            testId: "kn-categories",
          },
        ]
      : []),
    ...(pkg ? packages.items : []),
  ];
  const dialogs = (
    <>
      {pkg ? packages.dialogs : null}
      {categories ? (
        <CatalogCategories kind={categories} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
  return { items, dialogs };
}
