import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, recordHref, workflowHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import {
  CatalogMetadataDialog,
  CatalogMetadataSummary,
  CatalogNameCell,
  useCategoryFilter,
} from "@/components/cockpit/catalog-metadata";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  DataTable,
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
  Input,
  Page,
  PageHeader,
  RecordSheet,
  RowName,
  Section,
  SegmentedControl,
  StatusBadge,
  StatusStrip,
  SummaryLine,
  Textarea,
} from "@/components/cockpit/patterns";
import { bytes, MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState, queryView } from "@/components/failure-state";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  documentUnderTitle,
  type RefreshRhythm,
  refreshFields,
  refreshRhythm,
  type SourceKind,
  type SourceSection,
  sourceKind,
  sourcePrimaryAction,
  sourceSections,
} from "@/pages/knowledge-sources-model";

type KnowledgeSource = components["schemas"]["KnowledgeSource"];

const ENDPOINT = "/v1/knowledge-sources";

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

function countLine(t: Translate, count: number): string {
  return t(count === 1 ? "knowledge.summary.one" : "knowledge.summary.other", { count });
}

function sectionsLine(t: Translate, count: number): string {
  return t(count === 1 ? "knowledge.sections.one" : "knowledge.sections.other", { count });
}

export function KnowledgeSourcesPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const canRead = permissions.includes("knowledge:read");
  const canWrite = permissions.includes("knowledge:write");
  const canChat = permissions.includes("conversation:write");
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search).trim();
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [first] = sorting;
  const [adding, setAdding] = useState(false);
  const categoryFilter = useCategoryFilter("knowledge_source");
  const list = useInfiniteList<KnowledgeSource>(
    ENDPOINT,
    {
      q: q || undefined,
      category: categoryFilter.category,
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
          (row) => `${sectionsLine(t, row.chunk_count)} · ${bytes(row.bytes_total)}`,
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
        header={<PageHeader eyebrow={t("nav.group.knowledge")} title={title} />}
      >
        <ForbiddenState />
      </Page>
    );

  const rows = list.items;
  const pending = list.query.isPending && !list.query.failureReason;
  const failed = Boolean(list.query.error || list.query.failureReason);
  const empty = !pending && !failed && rows.length === 0 && !q && !categoryFilter.category;
  const addButton = (testId: string) =>
    canWrite ? (
      <Button onClick={() => setAdding(true)} data-testid={testId}>
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
          eyebrow={t("nav.group.knowledge")}
          title={title}
          action={empty ? undefined : addButton("knowledge-add")}
          secondary={
            canChat ? (
              <Button asChild variant="outline">
                <a
                  href={absolute(chatNewHref({ prompt: t("knowledge.addPrompt") }))}
                  data-testid="knowledge-add-in-chat"
                >
                  {t("knowledge.addInChat")}
                </a>
              </Button>
            ) : undefined
          }
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {rows.length > 0 ? (
          <SummaryLine text={countLine(t, list.total ?? rows.length)} testId="knowledge-summary" />
        ) : null}
        <DataTable
          columns={columns}
          data={rows}
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
              onReset: () => setSearch(""),
            },
          }}
          hasActiveFilters={Boolean(q)}
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
      {canWrite ? <AddSourceDialog open={adding} onOpenChange={setAdding} /> : null}
    </Page>
  );
}

type AddMode = "url" | "file" | "text";

function AddSourceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [mode, setMode] = useState<AddMode>("url");
  const [url, setUrl] = useState("");
  const [rhythm, setRhythm] = useState<OfferedRhythm>("weekly");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setUrl("");
      setRhythm("weekly");
      setName("");
      setText("");
      setFile(null);
      setProblem(null);
    }
  }, [open]);

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
            <Textarea
              id="knowledge-add-text"
              rows={8}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("knowledge.add.textPlaceholder")}
              className="font-mono text-xs"
              data-testid="knowledge-add-text"
            />
          </Field>
        </>
      ) : null}
      {problem ? <FieldError data-testid="knowledge-add-error">{problem}</FieldError> : null}
    </FormDialog>
  );
}

interface ChunkList {
  items: {
    ordinal: number;
    title: string | null;
    path: string | null;
    content: string;
    byte_size: number;
  }[];
}

interface SourceContent {
  version: string;
  editable: boolean;
  documents: { path: string; content: string }[];
}

export function KnowledgeSourcePage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime, locale } = useI18n();
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
    queryFn: () => apiRequest<ChunkList>(`${ENDPOINT}/${encodeURIComponent(id)}/chunks?limit=200`),
    enabled: Boolean(query.data),
  });
  const [editing, setEditing] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openSection, setOpenSection] = useState<SourceSection | null>(null);

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
  const frame = (body: React.ReactNode) => (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      testId="detail-knowledge"
      header={<PageHeader back={back} title={MISSING} />}
    >
      {body}
    </Page>
  );
  if (!canRead) return frame(<ForbiddenState />);
  const view = queryView(query, () => false);
  if (view === "loading") return frame(<DataState state="loading" />);
  const source = query.data;
  if (view === "error" || !source)
    return frame(
      <DataState
        state="error"
        line={t("detail.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="detail-load-failed"
      />,
    );

  const kind = sourceKind(source.source_type);
  const primary = canWrite ? sourcePrimaryAction(kind) : null;
  const readAt = source.last_refreshed_at ?? source.updated_at;
  const strip =
    source.status === "error" ? (
      <StatusStrip
        tone="error"
        line={t("knowledge.strip.error")}
        help={source.last_error ?? undefined}
        testId="knowledge-strip"
      />
    ) : source.status === "processing" ? (
      <StatusStrip tone="warn" line={t("knowledge.strip.processing")} testId="knowledge-strip" />
    ) : source.status === "inactive" ? (
      <StatusStrip
        tone="warn"
        line={t("knowledge.strip.inactive")}
        action={
          canWrite ? (
            <Button
              variant="outline"
              onClick={() => setStatus.mutate("active")}
              data-testid="knowledge-activate"
            >
              {t("knowledge.activate")}
            </Button>
          ) : undefined
        }
        testId="knowledge-strip"
      />
    ) : (
      <StatusStrip
        tone="ok"
        line={t("knowledge.strip.active", { when: formatRelativeTime(locale, readAt) })}
        testId="knowledge-strip"
      />
    );
  const sections = sourceSections(chunks.data?.items ?? []);
  const facts: Fact[] = [
    ...(kind === "url" || kind === "discovered"
      ? [
          {
            label: t("knowledge.field.url"),
            value: <span className="font-mono text-xs">{source.source_uri}</span>,
          },
        ]
      : []),
    ...(kind === "url"
      ? [{ label: t("knowledge.field.refresh"), value: rhythmLabel(t, source) }]
      : []),
    {
      label: t("knowledge.field.scope"),
      value:
        source.scope === "workflow" && source.workflow_id ? (
          <a
            className="underline-offset-4 hover:underline"
            href={absolute(workflowHref(source.workflow_id))}
            data-testid="knowledge-scope-workflow"
          >
            {t("knowledge.scope.workflow")}
          </a>
        ) : (
          t("knowledge.scope.global")
        ),
    },
  ];
  const technical: Fact[] = [
    {
      label: t("knowledge.fact.slug"),
      value: <span className="font-mono text-xs">{source.slug}</span>,
    },
    { label: t("knowledge.column.kind"), value: t(KIND_KEYS[kind]) },
    { label: t("knowledge.fact.mime"), value: source.mime_type ?? MISSING },
    { label: t("knowledge.fact.size"), value: bytes(source.bytes_total) },
    { label: t("knowledge.fact.created"), value: dateTime(source.created_at) },
  ];
  const menu = [
    ...(canWrite && primary !== "edit"
      ? [{ label: t("knowledge.edit"), onSelect: () => setEditing(true), testId: "knowledge-edit" }]
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
  ];

  return (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      testId="detail-knowledge"
      header={
        <PageHeader
          back={back}
          title={source.name}
          purpose={
            <CatalogMetadataSummary
              record={source}
              {...(canWrite ? { onEdit: () => setDescribing(true) } : {})}
            />
          }
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
              <Button onClick={() => setEditing(true)} data-testid="knowledge-edit">
                {t("knowledge.edit")}
              </Button>
            ) : undefined
          }
          secondary={
            canChat ? (
              <Button asChild variant="outline">
                <a
                  href={absolute(
                    chatNewHref({ prompt: t("detail.changeRecordPrompt", { name: source.name }) }),
                  )}
                  data-testid="detail-action"
                >
                  {t("detail.changeInChat")}
                </a>
              </Button>
            ) : undefined
          }
          menu={menu.length > 0 ? <ActionMenu items={menu} testId="detail-menu" /> : undefined}
        />
      }
    >
      <div className="flex flex-col gap-8">
        {strip}
        <div className="flex flex-col gap-3">
          <SummaryLine
            text={`${sectionsLine(t, source.chunk_count ?? 0)} · ${bytes(source.bytes_total)}`}
          />
          <FactList items={facts} testId="knowledge-facts" />
        </div>
        <SourceContentView
          kind={kind}
          name={source.name}
          sections={sections}
          loading={chunks.isPending}
          failed={Boolean(chunks.error)}
          onRetry={() => void chunks.refetch()}
          onOpen={setOpenSection}
        />
        <CollapsibleSection label={t("knowledge.technical")} testId="detail-overview">
          <FactList items={technical} />
        </CollapsibleSection>
      </div>
      <RecordSheet
        open={openSection !== null}
        onOpenChange={(open) => !open && setOpenSection(null)}
        title={openSection?.title ?? ""}
        testId="knowledge-section-sheet"
      >
        {openSection ? (
          <FilePreview
            name=""
            mimeType="text/markdown"
            text={documentUnderTitle(openSection.content, openSection.title)}
          />
        ) : null}
      </RecordSheet>
      {canWrite ? (
        <>
          <EditSourceDialog source={source} open={editing} onOpenChange={setEditing} />
          <CatalogMetadataDialog
            kind="knowledge_source"
            id={source.id}
            record={source}
            open={describing}
            onOpenChange={setDescribing}
            queryKey={["knowledge-source", source.id]}
          />
        </>
      ) : null}
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
    </Page>
  );
}

function SourceContentView({
  kind,
  name,
  sections,
  loading,
  failed,
  onRetry,
  onOpen,
}: {
  kind: SourceKind;
  name: string;
  sections: SourceSection[];
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  onOpen(section: SourceSection): void;
}) {
  const { t, dateTime } = useI18n();
  const columns = useMemo<CockpitColumn<SourceSection>[]>(() => {
    const column = tableColumns<SourceSection>({ t, dateTime });
    return [
      column.custom(
        "title",
        (row) => row.title,
        t("knowledge.column.section"),
        (row) => <RowName>{row.title}</RowName>,
        {
          width: "w-[70%]",
          ownsRowLink: true,
        },
      ),
      column.custom(
        "size",
        (row) => row.bytes,
        t("knowledge.column.size"),
        (row) => bytes(row.bytes),
        { width: "w-[30%]" },
      ),
    ];
  }, [t, dateTime]);
  if (loading) return <DataState state="loading" />;
  if (failed)
    return (
      <DataState
        state="error"
        line={t("knowledge.contentFailed")}
        onRetry={onRetry}
        testId="knowledge-load-failed"
      />
    );
  if (sections.length === 0)
    return <DataState state="empty" line={t("knowledge.noDocuments")} testId="knowledge-empty" />;
  const [only] = sections;
  if (sections.length === 1 && only)
    return (
      <Section label={t("knowledge.content")}>
        <FilePreview
          name=""
          mimeType="text/markdown"
          text={documentUnderTitle(only.content, name)}
          testId="knowledge-preview"
        />
      </Section>
    );
  return (
    <Section label={kind === "url" ? t("knowledge.pages") : t("knowledge.content")}>
      <DataTable
        columns={columns}
        data={sections}
        sorting={[]}
        onSortingChange={() => undefined}
        onOpen={onOpen}
        rowLabel={(row) => row.title}
        getRowId={(row) => row.key}
        emptyState={{
          zero: { title: t("knowledge.noDocuments") },
          filtered: { title: "", description: "", resetLabel: "", onReset: () => undefined },
        }}
        hasActiveFilters={false}
        columnsLabel={t("catalog.columns")}
        actionsLabel={t("common.actions")}
        collectionId="knowledge-sections"
        collectionTier="embedded"
      />
    </Section>
  );
}

function EditSourceDialog({
  source,
  open,
  onOpenChange,
}: {
  source: KnowledgeSource;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const content = useQuery({
    queryKey: ["knowledge-source", source.id, "content"],
    queryFn: () =>
      apiRequest<SourceContent>(`${ENDPOINT}/${encodeURIComponent(source.id)}/content`),
    enabled: open,
  });
  const document =
    content.data?.editable && content.data.documents.length === 1
      ? content.data.documents[0]
      : undefined;
  const isAddress = sourceKind(source.source_type) === "url";
  const savedRhythm = refreshRhythm(source.refresh_strategy, source.refresh_cron);
  const [name, setName] = useState(source.name);
  const [rhythm, setRhythm] = useState<OfferedRhythm | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(source.name);
      setRhythm(savedRhythm === "custom" ? null : savedRhythm);
      setProblem(null);
    }
  }, [open, source.name, savedRhythm]);
  useEffect(() => setText(document?.content ?? ""), [document?.content]);

  const save = useMutation({
    mutationFn: async () => {
      const rhythmChanged = isAddress && rhythm !== null && rhythm !== savedRhythm;
      if (name.trim() !== source.name || rhythmChanged)
        await apiRequest(`${ENDPOINT}/${encodeURIComponent(source.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(name.trim() !== source.name ? { name: name.trim() } : {}),
            ...(rhythmChanged && rhythm ? refreshFields(rhythm) : {}),
          }),
        });
      if (document && content.data && text !== document.content)
        await apiRequest(`${ENDPOINT}/${encodeURIComponent(source.id)}/content`, {
          method: "PUT",
          body: JSON.stringify({
            expected_version: content.data.version,
            path: document.path,
            content: text,
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
      title={t("knowledge.edit.title")}
      submit={{ label: t("common.save"), pending: save.isPending, disabled: !name.trim() }}
      onSubmit={() => save.mutate()}
      testId="knowledge-edit-dialog"
    >
      <Field>
        <FieldLabel htmlFor="knowledge-edit-name">{t("common.name")}</FieldLabel>
        <Input
          id="knowledge-edit-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="knowledge-edit-name"
        />
      </Field>
      {isAddress ? (
        <RefreshField
          value={rhythm}
          onChange={setRhythm}
          current={savedRhythm === "custom" ? rhythmLabel(t, source) : undefined}
        />
      ) : null}
      {document ? (
        <Field>
          <FieldLabel htmlFor="knowledge-edit-text">{t("knowledge.field.text")}</FieldLabel>
          <Textarea
            id="knowledge-edit-text"
            rows={10}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="font-mono text-xs"
            data-testid="knowledge-edit-text"
          />
        </Field>
      ) : null}
      {problem ? <FieldError>{problem}</FieldError> : null}
    </FormDialog>
  );
}
