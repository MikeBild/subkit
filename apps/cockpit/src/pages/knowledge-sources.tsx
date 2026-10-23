import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { AlignLeft, ChevronRight, Inbox, Link, Plus, Upload, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { listIntakeClips } from "@/api/intake";
import { loadKnowledgeChunks } from "@/api/knowledge";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, recordHref, workflowHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { CatalogOriginSummary, useCatalogOrigin } from "@/components/cockpit/catalog-categories";
import {
  CatalogCategoryChip,
  CatalogMetadataDialog,
  CatalogNameCell,
  CatalogPurpose,
  useCatalogMetadataActions,
  useCategoryFilter,
} from "@/components/cockpit/catalog-metadata";
import { recordCategory } from "@/components/cockpit/catalog-metadata-model";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { type UsageCard, UsageCards } from "@/components/cockpit/knowledge-usage";
import { KnowledgeVersions, useKnowledgeHistory } from "@/components/cockpit/knowledge-versions";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  ConfirmDialog,
  CopyField,
  DataState,
  DataTable,
  DetailPage,
  type DetailStrip,
  type Fact,
  FactList,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FileDrop,
  FilePreview,
  FilterBar,
  FormDialog,
  formatBytes,
  GroupingTabs,
  IconTile,
  Input,
  MarkdownDocument,
  MarkdownEditor,
  OnboardingFrame,
  Page,
  PageHeader,
  RecordSheet,
  SectionHeading,
  SegmentedControl,
  StatusBadge,
  TabBody,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { formatRelativeTime, LOCALE_TAGS, type Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { useSearchParamState } from "@/lib/use-search-param-state";
import {
  type ApiEndpoint,
  documentUnderTitle,
  knowledgeSummary,
  knowledgeWorkflowId,
  knowledgeWorkflowTarget,
  matchesEndpoint,
  openApiEndpoints,
  type RefreshRhythm,
  rawPreview,
  refreshFields,
  refreshRhythm,
  type SourceKind,
  type SourceSection,
  sourceKind,
  sourcePrimaryAction,
  sourceSections,
} from "@/pages/knowledge-sources-model";
import { keptVersionCount } from "@/pages/knowledge-versions-model";

type KnowledgeSource = components["schemas"]["KnowledgeSource"];

const ENDPOINT = "/v1/knowledge-sources";
const ENDPOINT_PAGE = 200;

const KIND_KEYS = {
  url: "knowledge.kind.url",
  discovered: "knowledge.kind.url",
  file: "knowledge.kind.file",
  text: "knowledge.kind.text",
  bundle: "knowledge.kind.bundle",
} as const satisfies Record<SourceKind, string>;

type Translate = ReturnType<typeof useI18n>["t"];

type OfferedRhythm = Exclude<RefreshRhythm, "custom">;

const RHYTHM_KEYS = {
  never: "knowledge.rhythm.never",
  daily: "knowledge.rhythm.daily",
  weekly: "knowledge.rhythm.weekly",
  custom: "knowledge.rhythm.custom",
} as const satisfies Record<RefreshRhythm, string>;

const STARTER_SOURCES = ["handbook", "product", "faq", "api", "prices"] as const;

function rhythmLabel(t: Translate, source: KnowledgeSource): string {
  const rhythm = refreshRhythm(source.refresh_strategy, source.refresh_cron);
  return rhythm === "custom" && source.refresh_cron
    ? `${t(RHYTHM_KEYS.custom)} (${source.refresh_cron})`
    : t(RHYTHM_KEYS[rhythm]);
}

function RefreshField({
  value,
  onChange,
  current,
}: {
  value: OfferedRhythm | null;
  onChange(next: OfferedRhythm): void;
  current?: string;
}) {
  const { t } = useI18n();
  return (
    <Field>
      <FieldLabel>{t("knowledge.field.refresh")}</FieldLabel>
      <SegmentedControl
        label={t("knowledge.field.refresh")}
        value={value ?? ""}
        onValueChange={(next) => onChange(next as OfferedRhythm)}
        options={(["never", "daily", "weekly"] as const).map((rhythm) => ({
          value: rhythm,
          label: t(RHYTHM_KEYS[rhythm]),
          testId: `knowledge-refresh-${rhythm}`,
        }))}
        testId="knowledge-refresh-rhythm"
      />
      <FieldDescription>
        {current ? t("knowledge.rhythm.current", { rhythm: current }) : t("knowledge.rhythm.help")}
      </FieldDescription>
    </Field>
  );
}

function sectionsLine(t: Translate, count: number): string {
  return t(count === 1 ? "knowledge.sections.one" : "knowledge.sections.other", { count });
}

type AddMode = "url" | "file" | "text";

const ADD_CARDS: readonly { mode: AddMode; icon: typeof Link }[] = [
  { mode: "url", icon: Link },
  { mode: "file", icon: Upload },
  { mode: "text", icon: AlignLeft },
];

function SourcesOnboarding({
  canWrite,
  onAdd,
}: {
  canWrite: boolean;
  onAdd(mode: AddMode, name?: string): void;
}) {
  const { t } = useI18n();
  return (
    <OnboardingFrame lead={t("knowledge.onboarding.lead")} testId="knowledge-onboarding">
      <ul className="grid gap-3 sm:grid-cols-3">
        {ADD_CARDS.map((card) => (
          <li key={card.mode}>
            <button
              type="button"
              disabled={!canWrite}
              onClick={() => onAdd(card.mode)}
              className="flex h-full w-full flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
              data-testid={`knowledge-onboarding-${card.mode}`}
            >
              <IconTile>
                <card.icon />
              </IconTile>
              <span className="text-sm font-medium">
                {t(`knowledge.onboarding.${card.mode}.title`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`knowledge.onboarding.${card.mode}.line`)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <section className="flex flex-col gap-2" aria-labelledby="knowledge-onboarding-starters">
          <SectionHeading id="knowledge-onboarding-starters">
            {t("knowledge.onboarding.starters")}
          </SectionHeading>
          <div className="flex flex-wrap gap-2">
            {STARTER_SOURCES.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => onAdd("text", t(`knowledge.onboarding.starter.${starter}`))}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`knowledge-starter-${starter}`}
              >
                <Plus aria-hidden="true" className="size-3.5 text-muted-foreground" />
                {t(`knowledge.onboarding.starter.${starter}`)}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </OnboardingFrame>
  );
}

export function KnowledgeSourcesPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const canRead = permissions.includes("knowledge:read");
  const canWrite = permissions.includes("knowledge:write");
  const canChat = permissions.includes("conversation:write");
  const [search, setSearch] = useSearchParamState("q", "");
  const [groupMode, setGroupMode] = useSearchParamState("group", "all");
  const q = useDebouncedValue(search).trim();
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [first] = sorting;
  const [adding, setAdding] = useState<{ mode: AddMode; name?: string } | null>(null);
  const categoryFilter = useCategoryFilter("knowledge_source");
  const origin = useCatalogOrigin();
  const list = useInfiniteList<
    KnowledgeSource,
    { items: KnowledgeSource[]; total: number; sections_total?: number }
  >(
    ENDPOINT,
    {
      q: q || undefined,
      category: categoryFilter.category,
      description_source: origin.descriptionSource,
      sort: first?.id ?? "updated_at",
      order: first?.desc ? "desc" : "asc",
    },
    { enabled: canRead },
  );
  const title = t("nav.knowledgeSources");

  const columns = useMemo<CockpitColumn<KnowledgeSource>[]>(() => {
    const column = tableColumns<KnowledgeSource>({ t, dateTime });
    return [
      column.custom(
        "name",
        (row) => row.name,
        t("knowledge.column.name"),
        (row) => <CatalogNameCell name={row.name} record={row} />,
        {
          sortable: true,
          width: "w-[34%]",
        },
      ),
      column.custom(
        "status",
        (row) => row.status,
        t("resource.field.status"),
        (row) => <StatusBadge state={row.status} />,
        { sortable: true, width: "w-[14%]" },
      ),
      column.custom(
        "source_type",
        (row) => row.source_type,
        t("knowledge.column.kind"),
        (row) => t(KIND_KEYS[sourceKind(row.source_type)]),
        { sortable: true, width: "w-[14%]" },
      ),
      {
        ...column.custom(
          "chunk_count",
          (row) => row.chunk_count,
          t("knowledge.column.size"),
          (row) => `${sectionsLine(t, row.chunk_count)} · ${sizeLabel(row.bytes_total, locale)}`,
          { width: "w-[20%]" },
        ),
        meta: { width: "w-[20%]", priority: "low" },
      },
      column.date(
        "updated_at",
        (row) => row.last_refreshed_at ?? row.updated_at,
        t("knowledge.column.read"),
        { sortable: true, width: "w-[18%]" },
      ),
    ];
  }, [t, dateTime]);

  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="catalog-knowledge"
        header={<PageHeader title={title} />}
      >
        <ForbiddenState />
      </Page>
    );

  const rows = list.items;
  const pending = list.query.isPending && !list.query.failureReason;
  const failed = Boolean(list.query.error || list.query.failureReason);
  const empty =
    !pending && !failed && rows.length === 0 && !q && !categoryFilter.category && !origin.active;
  const addButton = (testId: string) =>
    canWrite ? (
      <Button onClick={() => setAdding({ mode: "url" })} data-testid={testId}>
        {t("knowledge.add")}
      </Button>
    ) : undefined;

  return (
    <Page
      kind="list"
      surface="collection"
      scroll="content"
      testId="catalog-knowledge"
      header={
        <PageHeader
          title={title}
          action={empty ? undefined : addButton("knowledge-add")}
          menu={
            canChat ? (
              <ActionMenu
                alwaysMenu
                testId="knowledge-page-actions"
                items={[
                  {
                    label: t("knowledge.addInChat"),
                    href: absolute(chatNewHref({ prompt: t("knowledge.addPrompt") })),
                    testId: "knowledge-add-in-chat",
                  },
                ]}
              />
            ) : undefined
          }
        />
      }
    >
      {empty ? (
        <SourcesOnboarding canWrite={canWrite} onAdd={(mode, name) => setAdding({ mode, name })} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {rows.length > 0 || origin.active || q || categoryFilter.category ? (
            <CatalogOriginSummary
              text={knowledgeSummary(list.total ?? rows.length, list.first?.sections_total, t)}
              testId="knowledge-summary"
              kind="knowledge_source"
              origin={origin}
            />
          ) : null}
          <DataTable
            columns={columns}
            data={rows}
            groupingTabs={
              <GroupingTabs
                label={t("common.groupBy")}
                value={groupMode}
                onChange={setGroupMode}
                options={[
                  { value: "all", label: t("common.all") },
                  { value: "kind", label: t("knowledge.column.kind") },
                  { value: "status", label: t("resource.field.status") },
                ]}
                testId="knowledge-grouping"
                note={groupMode === "all" ? undefined : t("common.loadedOnly")}
              />
            }
            grouping={
              groupMode === "all"
                ? undefined
                : {
                    getKey: (row) =>
                      groupMode === "kind"
                        ? t(KIND_KEYS[sourceKind(row.source_type)])
                        : statusLabel(t, row.status),
                  }
            }
            infinite={list.infinite}
            total={list.total}
            getRowId={(row) => row.id}
            toolbar={
              <FilterBar
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: t("knowledge.search"),
                  testId: "knowledge-search",
                }}
                selects={categoryFilter.select ? [categoryFilter.select] : []}
                reset={{
                  label: t("catalog.clearFilters"),
                  onClick: () => {
                    setSearch("");
                    categoryFilter.select?.onChange("all");
                    origin.setValue("all");
                  },
                }}
              />
            }
            pending={pending}
            error={
              failed
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void list.query.refetch(),
                  }
                : null
            }
            emptyState={{
              zero: { title: t("knowledge.empty"), action: addButton("knowledge-empty-add") },
              filtered: {
                title: t("resource.noMatches"),
                description: t("resource.broaderSearch"),
                resetLabel: t("catalog.clearFilters"),
                onReset: () => {
                  setSearch("");
                  categoryFilter.select?.onChange("all");
                  origin.setValue("all");
                },
              },
            }}
            hasActiveFilters={Boolean(q || categoryFilter.category || origin.active)}
            sorting={sorting}
            onSortingChange={setSorting}
            onOpen={(row) => void navigate({ to: recordHref("knowledge", row.id) })}
            rowHref={(row) => recordHref("knowledge", row.id)}
            rowLabel={(row) => row.name}
            columnsLabel={t("catalog.columns")}
            actionsLabel={t("common.actions")}
            collectionId="knowledge-sources"
          />
        </div>
      )}
      {canWrite ? (
        <AddSourceDialog
          open={adding !== null}
          initialMode={adding?.mode ?? "url"}
          initialName={adding?.name ?? ""}
          onOpenChange={(open) => !open && setAdding(null)}
        />
      ) : null}
    </Page>
  );
}

function AddSourceDialog({
  open,
  initialMode,
  initialName,
  onOpenChange,
}: {
  open: boolean;
  initialMode: AddMode;
  initialName: string;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [url, setUrl] = useState("");
  const [rhythm, setRhythm] = useState<OfferedRhythm>("weekly");
  const [name, setName] = useState(initialName);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setName(initialName);
      return;
    }
    setUrl("");
    setRhythm("weekly");
    setName("");
    setText("");
    setFile(null);
    setProblem(null);
  }, [open, initialMode, initialName]);

  const create = useMutation({
    mutationFn: async (): Promise<KnowledgeSource> => {
      if (mode === "url")
        return apiRequest(`${ENDPOINT}/url`, {
          method: "POST",
          body: JSON.stringify({ url: url.trim(), ...refreshFields(rhythm) }),
        });
      if (mode === "text")
        return apiRequest(`${ENDPOINT}/inline`, {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), content: text, mime_type: "text/markdown" }),
        });
      const form = new FormData();
      form.set("file", file as File);
      form.set("metadata", JSON.stringify({ name: name.trim() || (file as File).name }));
      return apiRequest(ENDPOINT, { method: "POST", body: form });
    },
    onSuccess: async (source) => {
      toast.success(t("knowledge.added", { name: source.name }));
      await client.invalidateQueries({ queryKey: ["catalog"] });
      onOpenChange(false);
      void navigate({ to: recordHref("knowledge", source.id) });
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 422
          ? t("knowledge.add.unreadable")
          : error instanceof ApiError && error.status === 413
            ? t("knowledge.add.tooLarge")
            : t("common.actionFailed"),
      ),
  });

  const submit = () => {
    setProblem(null);
    if (mode === "url" && !/^https?:\/\/\S+\.\S+/.test(url.trim()))
      return setProblem(t("knowledge.add.urlMissing"));
    if (mode === "text" && !name.trim()) return setProblem(t("knowledge.add.nameMissing"));
    if (mode === "text" && !text.trim()) return setProblem(t("knowledge.add.textMissing"));
    if (mode === "file" && !file) return setProblem(t("knowledge.add.fileMissing"));
    create.mutate();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("knowledge.add")}
      size={mode === "text" ? "wide" : "default"}
      submit={{ label: t("knowledge.add.submit"), pending: create.isPending }}
      onSubmit={submit}
      testId="knowledge-add-dialog"
    >
      <SegmentedControl
        label={t("knowledge.add.mode")}
        value={mode}
        onValueChange={(next) => {
          setMode(next as AddMode);
          setProblem(null);
        }}
        options={[
          { value: "url", label: t("knowledge.kind.url"), testId: "knowledge-add-mode-url" },
          { value: "file", label: t("knowledge.add.modeFile"), testId: "knowledge-add-mode-file" },
          { value: "text", label: t("knowledge.kind.text"), testId: "knowledge-add-mode-text" },
        ]}
        testId="knowledge-add-mode"
      />
      {mode === "url" ? (
        <Field>
          <FieldLabel htmlFor="knowledge-add-url">{t("knowledge.field.url")}</FieldLabel>
          <Input
            id="knowledge-add-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://docs.example.com/handbuch"
            data-testid="knowledge-add-url"
          />
          <FieldDescription>{t("knowledge.add.urlHelp")}</FieldDescription>
        </Field>
      ) : null}
      {mode === "url" ? <RefreshField value={rhythm} onChange={setRhythm} /> : null}
      {mode === "file" ? (
        <>
          <FileDrop
            onFiles={(files) => setFile(files[0] ?? null)}
            accept=".md,.markdown,.txt,.csv,.json,.html,.pdf,.docx,text/*"
            testId="knowledge-add-file"
          />
          {file ? (
            <FilePreview name={file.name} file={file} testId="knowledge-add-file-preview" />
          ) : null}
        </>
      ) : null}
      {mode === "text" ? (
        <>
          <Field>
            <FieldLabel htmlFor="knowledge-add-name">{t("common.name")}</FieldLabel>
            <Input
              id="knowledge-add-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("knowledge.add.namePlaceholder")}
              data-testid="knowledge-add-name"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="knowledge-add-text">{t("knowledge.field.text")}</FieldLabel>
            <MarkdownEditor
              id="knowledge-add-text"
              label={t("knowledge.field.text")}
              value={text}
              onChange={setText}
              placeholder={t("knowledge.add.textPlaceholder")}
              rows={10}
              testId="knowledge-add-text"
            />
          </Field>
        </>
      ) : null}
      {problem ? <FieldError data-testid="knowledge-add-error">{problem}</FieldError> : null}
    </FormDialog>
  );
}

interface SourceContent {
  version: string;
  editable: boolean;
  documents: { path: string; content: string }[];
}

type EditMode = "address" | "text";

export function KnowledgeSourcePage({ permissions }: { permissions: readonly string[] }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const canRead = permissions.includes("knowledge:read");
  const canWrite = permissions.includes("knowledge:write");
  const canDelete = permissions.includes("knowledge:delete");
  const canChat = permissions.includes("conversation:write");
  const queryKey = ["knowledge-source", id];
  const query = useQuery({
    queryKey,
    queryFn: () => apiRequest<KnowledgeSource>(`${ENDPOINT}/${encodeURIComponent(id)}`),
    enabled: canRead && Boolean(id),
    ...live,
  });
  const chunks = useQuery({
    queryKey: [...queryKey, "chunks", query.data?.version],
    queryFn: () => loadKnowledgeChunks(id),
    enabled: Boolean(query.data),
  });
  const history = useKnowledgeHistory(id);
  const [editing, setEditing] = useState<EditMode | null>(null);
  const [describing, setDescribing] = useState(false);
  const metadataActions = useCatalogMetadataActions({
    kind: "knowledge_source",
    id,
    record: query.data,
    queryKey: queryKey,
    onEdit: () => setDescribing(true),
    label: t("knowledge.edit"),
  });
  const [deleting, setDeleting] = useState(false);
  const [section, setSection] = useSearchParamState("section", "");

  const refresh = useMutation({
    mutationFn: () =>
      apiRequest<KnowledgeSource>(`${ENDPOINT}/${encodeURIComponent(id)}/refresh`, {
        method: "POST",
      }),
    onSuccess: (source) => {
      client.setQueryData(queryKey, source);
      void client.invalidateQueries({ queryKey: [...queryKey, "chunks"] });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      toast.success(
        t("knowledge.refreshed", {
          name: source.name,
          sections: sectionsLine(t, source.chunk_count),
        }),
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 422
          ? t("knowledge.add.unreadable")
          : t("common.actionFailed"),
      ),
  });
  const setStatus = useOptimisticAction<"active" | "inactive", KnowledgeSource, KnowledgeSource>({
    queryKey,
    mutationFn: (status) =>
      apiRequest(`${ENDPOINT}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    apply: (current, status) => (current ? { ...current, status } : current),
  });
  const remove = useMutation({
    mutationFn: () => apiRequest(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("knowledge.deleted", { name: query.data?.name ?? "" }));
      void client.invalidateQueries({ queryKey: ["catalog"] });
      void navigate({ to: "/knowledge" });
    },
    onError: () => toast.error(t("common.actionFailed")),
  });

  const back = { to: "/knowledge", label: t("nav.knowledgeSources") };
  if (!canRead)
    return (
      <DetailPage testId="detail-knowledge" back={back} title={t("nav.knowledgeSources")}>
        <ForbiddenState />
      </DetailPage>
    );
  const source = query.data;
  const kind = source ? sourceKind(source.source_type) : "file";
  const primary = canWrite ? sourcePrimaryAction(kind) : null;
  const currentVersion = history.data?.items.find((version) => version.current);
  const strip: DetailStrip | null = !source
    ? null
    : source.status === "error"
      ? {
          tone: "error",
          line: t("knowledge.strip.error"),
          help: source.last_error ?? undefined,
        }
      : source.status === "processing"
        ? { tone: "warn", line: t("knowledge.strip.processing") }
        : source.status === "inactive"
          ? {
              tone: "warn",
              line: t("knowledge.strip.inactive"),
              action: canWrite ? (
                <Button
                  variant="outline"
                  onClick={() => setStatus.mutate("active")}
                  data-testid="knowledge-activate"
                >
                  {t("knowledge.activate")}
                </Button>
              ) : undefined,
            }
          : {
              tone: "ok",
              line:
                kind === "text" && currentVersion !== undefined
                  ? t("knowledge.strip.version", {
                      version: currentVersion.version,
                      when: formatRelativeTime(locale, currentVersion.created_at),
                    })
                  : t("knowledge.strip.active", {
                      when: formatRelativeTime(
                        locale,
                        source.last_refreshed_at ?? source.updated_at,
                      ),
                    }),
            };
  const menu = source
    ? [
        ...(canChat
          ? [
              {
                label: t("detail.changeInChat"),
                href: absolute(
                  chatNewHref({
                    prompt: t("detail.changeRecordPrompt"),
                    references: [{ type: "knowledge_source", id: source.id }],
                  }),
                ),
                testId: "detail-action",
              },
            ]
          : []),
        ...(canWrite ? metadataActions : []),
        ...(canWrite && kind === "url"
          ? [
              {
                label: t("knowledge.editAddress"),
                onSelect: () => setEditing("address"),
                testId: "knowledge-edit-address",
              },
            ]
          : []),
        ...(canWrite && source.status === "active"
          ? [
              {
                label: t("knowledge.deactivate"),
                onSelect: () => setStatus.mutate("inactive"),
                testId: "knowledge-deactivate",
              },
            ]
          : []),
        ...(canDelete
          ? [
              {
                label: t("knowledge.delete"),
                onSelect: () => setDeleting(true),
                destructive: true,
                testId: "knowledge-delete",
              },
            ]
          : []),
      ]
    : [];

  return (
    <>
      <DetailPage
        testId="detail-knowledge"
        back={back}
        title={source?.name ?? ""}
        badge={source ? <CatalogCategoryChip category={recordCategory(source)} /> : undefined}
        purpose={source ? <CatalogPurpose record={source} /> : undefined}
        loading={query.isPending}
        action={
          primary === "refresh" ? (
            <Button
              onClick={() => refresh.mutate()}
              pending={refresh.isPending}
              data-testid="knowledge-refresh"
            >
              {t("knowledge.refresh")}
            </Button>
          ) : primary === "edit" ? (
            <Button onClick={() => setEditing("text")} data-testid="knowledge-edit">
              {t("knowledge.editText")}
            </Button>
          ) : undefined
        }
        menu={
          menu.length > 0 ? <ActionMenu alwaysMenu items={menu} testId="detail-menu" /> : undefined
        }
        strip={strip ? { ...strip, testId: "knowledge-strip" } : null}
        tabs={
          source
            ? [
                {
                  value: "content",
                  label: t("knowledge.tab.content"),
                  testId: "knowledge-tab-content",
                  content: (
                    <SourceContentTab
                      source={source}
                      kind={kind}
                      sections={sourceSections(chunks.data?.items ?? [])}
                      loading={chunks.isPending}
                      failed={Boolean(chunks.error)}
                      onRetry={() => void chunks.refetch()}
                      onOpenSection={setSection}
                    />
                  ),
                },
                {
                  value: "usage",
                  label: t("knowledge.tab.usage"),
                  testId: "knowledge-tab-usage",
                  content: <SourceUsageTab source={source} permissions={permissions} />,
                },
                {
                  value: "versions",
                  label: t("knowledge.tab.versions"),
                  count: history.data?.total || undefined,
                  testId: "knowledge-tab-versions",
                  content: (
                    <TabBody
                      testId="knowledge-versions-tab"
                      summary={
                        history.data
                          ? t(
                              keptVersionCount(history.data.total) === 1
                                ? "knowledge.versions.countOne"
                                : "knowledge.versions.countOther",
                              { count: keptVersionCount(history.data.total) },
                            )
                          : undefined
                      }
                    >
                      <KnowledgeVersions
                        sourceId={source.id}
                        sourceName={source.name}
                        canWrite={canWrite}
                      />
                    </TabBody>
                  ),
                },
              ]
            : undefined
        }
      >
        {query.error ? (
          <DataState
            state="error"
            line={t("detail.loadFailed")}
            onRetry={() => void query.refetch()}
            testId="detail-load-failed"
          />
        ) : null}
      </DetailPage>
      {source && canWrite ? (
        <>
          <EditSourceDialog
            source={source}
            mode={editing}
            onOpenChange={(open) => !open && setEditing(null)}
          />
          <CatalogMetadataDialog
            kind="knowledge_source"
            id={source.id}
            record={source}
            open={describing}
            onOpenChange={setDescribing}
            queryKey={["knowledge-source", source.id]}
            nameKey="name"
            title={t("knowledge.edit.title")}
          />
        </>
      ) : null}
      {source ? (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          object={source.name}
          verb={t("knowledge.delete")}
          consequence={t("knowledge.deleteConsequence", {
            sections: sectionsLine(t, source.chunk_count),
          })}
          destructive
          pending={remove.isPending}
          onConfirm={() => remove.mutateAsync().then(() => undefined)}
          testId="knowledge-delete-confirm"
        />
      ) : null}
      {source ? (
        <SectionSheet
          source={source}
          sections={sourceSections(chunks.data?.items ?? [])}
          selected={section}
          onSelect={setSection}
        />
      ) : null}
    </>
  );
}

function SourceContentTab({
  source,
  kind,
  sections,
  loading,
  failed,
  onRetry,
  onOpenSection,
}: {
  source: KnowledgeSource;
  kind: SourceKind;
  sections: SourceSection[];
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  onOpenSection(key: string): void;
}) {
  const { t, dateTime, locale } = useI18n();
  const [filter, setFilter] = useState("");
  const contents = useMemo(() => sections.map((section) => section.content), [sections]);
  const endpoints = useMemo(() => openApiEndpoints(contents), [contents]);
  const raw = useMemo(() => rawPreview(contents), [contents]);
  const summary = [
    endpoints
      ? t(endpoints.length === 1 ? "knowledge.endpoints.one" : "knowledge.endpoints.other", {
          count: endpoints.length,
        })
      : sectionsLine(t, source.chunk_count ?? 0),
    sizeLabel(source.bytes_total, locale),
    endpoints ? t("knowledge.kind.api") : t(KIND_KEYS[kind]),
    ...(kind === "url" ? [rhythmLabel(t, source)] : []),
  ].join(" · ");
  const technical: Fact[] = [
    ...(kind === "url" || kind === "discovered"
      ? [
          {
            label: t("knowledge.field.url"),
            value: <CopyField value={source.source_uri} label={t("knowledge.field.url")} />,
          },
        ]
      : []),
    {
      label: t("knowledge.fact.slug"),
      value: <span className="font-mono text-xs">@{source.slug}</span>,
    },
    { label: t("knowledge.fact.mime"), value: source.mime_type ?? MISSING },
    { label: t("knowledge.fact.size"), value: sizeLabel(source.bytes_total, locale) },
    { label: t("knowledge.fact.created"), value: dateTime(source.created_at) },
    {
      label: t("knowledge.fact.id"),
      value: <span className="font-mono text-xs">{source.id}</span>,
    },
  ];
  const shown = endpoints?.filter((endpoint) => matchesEndpoint(endpoint, filter)) ?? [];
  const [only] = sections;

  return (
    <TabBody
      testId="knowledge-content"
      summary={
        endpoints && endpoints.length > 10 ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="min-w-0" data-testid="knowledge-content-summary">
              {summary}
            </span>
            <Input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("knowledge.endpoints.search")}
              aria-label={t("knowledge.endpoints.search")}
              className="ml-auto h-8 w-full sm:w-56"
              data-testid="knowledge-endpoint-search"
            />
          </div>
        ) : (
          summary
        )
      }
      technical={
        <>
          <FactList items={technical} testId="knowledge-technical" />
          {raw.text ? (
            <CodeBlock
              code={raw.text}
              label={raw.truncated ? t("knowledge.raw.truncated") : t("knowledge.raw.label")}
              testId="knowledge-raw"
            />
          ) : null}
        </>
      }
    >
      {loading ? (
        <DataState state="loading" />
      ) : failed ? (
        <DataState
          state="error"
          line={t("knowledge.contentFailed")}
          onRetry={onRetry}
          testId="knowledge-load-failed"
        />
      ) : sections.length === 0 ? (
        <DataState state="empty" line={t("knowledge.noDocuments")} testId="knowledge-empty" />
      ) : endpoints ? (
        <div className="flex flex-col gap-2">
          <ul className="divide-y rounded-lg border" data-testid="knowledge-endpoints">
            {shown.slice(0, ENDPOINT_PAGE).map((endpoint) => (
              <li key={endpoint.key}>
                <EndpointRow endpoint={endpoint} onOpen={() => onOpenSection(endpoint.key)} />
              </li>
            ))}
          </ul>
          {shown.length > ENDPOINT_PAGE ? (
            <p className="text-xs text-muted-foreground">
              {t("knowledge.endpoints.more", { count: shown.length - ENDPOINT_PAGE })}
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("resource.noMatches")}</p>
          ) : null}
        </div>
      ) : sections.length === 1 && only ? (
        <MarkdownDocument
          text={documentUnderTitle(only.content, source.name)}
          testId="knowledge-preview"
        />
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="knowledge-sections">
          {sections.map((section, index) => (
            <li key={section.key}>
              <button
                type="button"
                onClick={() => onOpenSection(section.key)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`knowledge-section-${index}`}
              >
                <span className="w-6 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{section.title}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {sizeLabel(section.bytes, locale)}
                </span>
                <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </TabBody>
  );
}

function MethodChip({ method }: { method: string }) {
  return (
    <span className="w-16 shrink-0 rounded border px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold">
      {method}
    </span>
  );
}

function EndpointRow({ endpoint, onOpen }: { endpoint: ApiEndpoint; onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="knowledge-endpoint"
    >
      <MethodChip method={endpoint.method} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{endpoint.purpose || endpoint.path}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {endpoint.path}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
    </button>
  );
}

function SectionSheet({
  source,
  sections,
  selected,
  onSelect: setSelected,
}: {
  source: KnowledgeSource;
  sections: SourceSection[];
  selected: string;
  onSelect(key: string): void;
}) {
  const { t, dateTime, locale } = useI18n();
  const contents = useMemo(() => sections.map((section) => section.content), [sections]);
  const endpoints = useMemo(() => openApiEndpoints(contents), [contents]);
  const endpoint = endpoints?.find((entry) => entry.key === selected) ?? null;
  const section = endpoint ? null : (sections.find((entry) => entry.key === selected) ?? null);
  const open = Boolean(selected) && (endpoint !== null || section !== null);
  return (
    <RecordSheet
      open={open}
      onOpenChange={(next) => !next && setSelected("")}
      title={endpoint ? endpoint.purpose || endpoint.path : (section?.title ?? "")}
      subtitle={t("knowledge.section.from", { name: source.name })}
      testId="knowledge-section-sheet"
    >
      {endpoint ? (
        <div className="flex flex-col gap-6">
          <FactList
            testId="knowledge-endpoint-facts"
            items={[
              { label: t("knowledge.endpoint.method"), value: endpoint.method },
              {
                label: t("knowledge.endpoint.path"),
                value: <span className="font-mono text-xs">{endpoint.path}</span>,
              },
              ...(endpoint.purpose
                ? [{ label: t("knowledge.endpoint.purpose"), value: endpoint.purpose }]
                : []),
            ]}
          />
          <TechnicalDetails testId="knowledge-endpoint-technical">
            <CodeBlock
              code={JSON.stringify(endpoint.operation, null, 2)}
              label={t("knowledge.raw.label")}
              testId="knowledge-endpoint-raw"
            />
          </TechnicalDetails>
        </div>
      ) : section ? (
        <div className="flex flex-col gap-4">
          <FactList
            items={[
              { label: t("knowledge.column.size"), value: sizeLabel(section.bytes, locale) },
              {
                label: t("knowledge.column.read"),
                value: source.last_refreshed_at ? dateTime(source.last_refreshed_at) : MISSING,
              },
            ]}
            testId="knowledge-section-facts"
          />
          <FilePreview
            name=""
            mimeType="text/markdown"
            text={documentUnderTitle(section.content, section.title)}
          />
        </div>
      ) : null}
    </RecordSheet>
  );
}

function SourceUsageTab({
  source,
  permissions,
}: {
  source: KnowledgeSource;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const workflowId = knowledgeWorkflowId(source.scope, source.workflow_id);
  const workflow = useQuery({
    queryKey: ["knowledge-source-workflow", workflowId],
    queryFn: () =>
      apiRequest<{ id: string; name?: string | null; slug?: string | null }>(
        `/v1/workflows/${encodeURIComponent(workflowId ?? "")}`,
      ),
    enabled: Boolean(workflowId) && permissions.includes("workflow:read"),
    retry: false,
  });
  const intake = useQuery({
    queryKey: ["intake", "knowledge-backlinks", source.id],
    queryFn: () => listIntakeClips(),
    enabled: permissions.includes("intake:read"),
  });
  const target = knowledgeWorkflowTarget(source.scope, source.workflow_id, workflow.data);
  const origins = (intake.data?.items ?? []).filter(
    (item) => item.admitted_target_kind === "knowledge" && item.admitted_target_id === source.id,
  );
  const cards: UsageCard[] = workflowId
    ? [
        {
          id: workflowId,
          title: target?.name ?? t("knowledge.scope.workflow"),
          line: t("knowledge.usage.workflowLine"),
          href: workflowHref(workflowId),
          icon: <Workflow />,
        },
      ]
    : [];
  return (
    <TabBody
      testId="knowledge-usage"
      summary={t(workflowId ? "knowledge.usage.workflow" : "knowledge.usage.global")}
      more={
        <>
          {origins.length > 0 ? (
            <CollapsibleSection
              label={t("intake.originalClips")}
              count={origins.length}
              testId="knowledge-origin"
            >
              <UsageCards
                testId="knowledge-intake-clips"
                items={origins.map((item) => ({
                  id: item.id,
                  title: item.title,
                  line: t("knowledge.usage.originLine"),
                  href: recordHref("intake", item.id),
                  icon: <Inbox />,
                }))}
              />
            </CollapsibleSection>
          ) : null}
          {permissions.includes("conversation:read") ? (
            <ConversationsAbout target={{ knowledge_source_id: source.id }} />
          ) : null}
        </>
      }
    >
      {cards.length > 0 ? (
        <UsageCards items={cards} testId="knowledge-scope" />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="knowledge-usage-global">
          {t("knowledge.usage.globalLine")}
        </p>
      )}
    </TabBody>
  );
}

function EditSourceDialog({
  source,
  mode,
  onOpenChange,
}: {
  source: KnowledgeSource;
  mode: EditMode | null;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const open = mode !== null;
  const content = useQuery({
    queryKey: ["knowledge-source", source.id, "content"],
    queryFn: () =>
      apiRequest<SourceContent>(`${ENDPOINT}/${encodeURIComponent(source.id)}/content`),
    enabled: mode === "text",
  });
  const document =
    content.data?.editable && content.data.documents.length === 1
      ? content.data.documents[0]
      : undefined;
  const savedRhythm = refreshRhythm(source.refresh_strategy, source.refresh_cron);
  const [address, setAddress] = useState(source.source_uri);
  const [note, setNote] = useState("");
  const [rhythm, setRhythm] = useState<OfferedRhythm | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAddress(source.source_uri);
      setNote("");
      setRhythm(savedRhythm === "custom" ? null : savedRhythm);
      setProblem(null);
    }
  }, [open, source.source_uri, savedRhythm]);
  useEffect(() => setText(document?.content ?? ""), [document?.content]);

  const save = useMutation({
    mutationFn: async () => {
      if (mode === "address") {
        const rhythmChanged = rhythm !== null && rhythm !== savedRhythm;
        const addressChanged = address.trim() !== source.source_uri;
        if (rhythmChanged || addressChanged)
          await apiRequest(`${ENDPOINT}/${encodeURIComponent(source.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              ...(rhythmChanged && rhythm ? refreshFields(rhythm) : {}),
              ...(addressChanged ? { source_uri: address.trim() } : {}),
            }),
          });
        return;
      }
      if (document && content.data && text !== document.content)
        await apiRequest(`${ENDPOINT}/${encodeURIComponent(source.id)}/content`, {
          method: "PUT",
          body: JSON.stringify({
            expected_version: content.data.version,
            path: document.path,
            content: text,
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        });
    },
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      await client.invalidateQueries({ queryKey: ["knowledge-source", source.id] });
      onOpenChange(false);
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t("knowledge.edit.conflict")
          : t("detail.saveFailed"),
      ),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === "address" ? t("knowledge.editAddress") : t("knowledge.editText")}
      size={mode === "text" ? "wide" : "default"}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: mode === "address" ? !address.trim() : !document,
      }}
      onSubmit={() => save.mutate()}
      testId="knowledge-edit-dialog"
    >
      {mode === "address" ? (
        <>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-address">{t("knowledge.field.url")}</FieldLabel>
            <Input
              id="knowledge-edit-address"
              type="url"
              required
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              data-testid="knowledge-edit-address"
            />
          </Field>
          <RefreshField
            value={rhythm}
            onChange={setRhythm}
            current={savedRhythm === "custom" ? rhythmLabel(t, source) : undefined}
          />
        </>
      ) : content.isPending ? (
        <DataState state="loading" />
      ) : document ? (
        <>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-text">{t("knowledge.field.text")}</FieldLabel>
            <MarkdownEditor
              id="knowledge-edit-text"
              label={t("knowledge.field.text")}
              value={text}
              onChange={setText}
              rows={14}
              testId="knowledge-edit-text"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-note">
              {t("knowledge.versions.column.why")}
            </FieldLabel>
            <Input
              id="knowledge-edit-note"
              value={note}
              disabled={text === document.content}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              data-testid="knowledge-edit-note"
            />
          </Field>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("knowledge.edit.notEditable")}</p>
      )}
      {problem ? <FieldError>{problem}</FieldError> : null}
    </FormDialog>
  );
}

function sizeLabel(value: unknown, locale: Locale): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatBytes(value, LOCALE_TAGS[locale])
    : MISSING;
}
