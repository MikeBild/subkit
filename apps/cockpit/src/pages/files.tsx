import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  BookOpen,
  Cable,
  Download,
  FileText,
  ImageIcon,
  MessageSquare,
  Play,
  ScrollText,
  Search,
  Sheet,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError, apiText, apiUpload } from "@/api/client";
import { tenantContentHref } from "@/api/tenant-context";
import { useActorDirectory } from "@/app/actor-directory";
import { cockpitApiHref } from "@/app/installation-context";
import { exportInstallationFile } from "@/app/installation-export";
import { useInstallation } from "@/app/installation-provider";
import { conversationHref, recordHref, workflowHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { CatalogSummary, useCatalogCreatedBy } from "@/components/cockpit/catalog-categories";
import {
  CatalogCategoryChips,
  catalogCategoryGrouping,
  categoryCounts,
} from "@/components/cockpit/catalog-grouping";
import {
  CatalogCategoryChip,
  CatalogMetadataDialog,
  CatalogNameCell,
  CatalogPurpose,
  useCatalogMetadataActions,
  useCategoryFilter,
} from "@/components/cockpit/catalog-metadata";
import { recordCategory } from "@/components/cockpit/catalog-metadata-model";
import { FileVersionsSection, useFileVersions } from "@/components/cockpit/file-versions";
import { IconButton } from "@/components/cockpit/icon-button";
import { InstallationInputActions } from "@/components/cockpit/installation-dialogs";
import { type UsageCard, UsageCards } from "@/components/cockpit/knowledge-usage";
import { usePackageActions } from "@/components/cockpit/package-dialogs";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  ConfirmDialog,
  ContextHelp,
  CopyField,
  DataState,
  DataTable,
  DetailPage,
  FactList,
  FileDrop,
  FilePreview,
  FilterBar,
  FormDialog,
  formatBytes,
  GroupingTabs,
  IconTile,
  OnboardingFrame,
  Page,
  PageHeader,
  previewKind,
  SectionHeading,
  TabBody,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { LOCALE_TAGS, pluralKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { cn } from "@/lib/utils";
import {
  fileKindKey,
  fileOtherLinkCard,
  fileUploaderName,
  fileUsageLine,
  fileUsageParts,
  hasEarlierVersions,
} from "@/pages/file-versions-model";

type StoredFile = components["schemas"]["File"];
type ListedFile = components["schemas"]["FileListItem"];
type FileUsage = components["schemas"]["FileUsage"];

const OTHER_LINK_ICONS: Record<FileUsage["other_links"][number]["resource_type"], ReactNode> = {
  conversation: <MessageSquare />,
  knowledge_source: <BookOpen />,
  skill: <ScrollText />,
  connector: <Cable />,
  workflow_run: <Play />,
  discovery_run: <Search />,
};

const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const LIST_PATH = "/v1/files";
const LIST_PARAMS = { sort: "created_at", order: "desc" } as const;

export function fileReference(file: Pick<StoredFile, "id" | "reference">): string {
  return file.reference ?? JSON.stringify({ $file: file.id });
}

function sizeText(bytes: unknown, locale: string): string {
  return typeof bytes === "number" ? formatBytes(bytes, locale) : "—";
}

function fileKindLabel(t: ReturnType<typeof useI18n>["t"], file: StoredFile): string {
  return t(fileKindKey(file.filename, file.content_type));
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function uploadFailure(t: ReturnType<typeof useI18n>["t"], name: string, error: unknown): string {
  if (error instanceof ApiError && error.code === "duplicate_content") return t("files.duplicate");
  return t("files.failed", { name });
}

function usePageDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setOver(false);
      return;
    }
    const carriesFiles = (event: DragEvent) =>
      [...(event.dataTransfer?.types ?? [])].includes("Files");
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setOver(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(false);
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (dropped.length > 0) onFiles(dropped);
    };
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [enabled, onFiles]);
  return over;
}

export function FilesPage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const canWrite = session.permissions.includes("file:write");
  const canIntakeWrite = session.permissions.includes("intake:write");
  const installation = useInstallation();
  const [search, setSearch] = useSearchParamState("q", "");
  const [groupMode, setGroupMode] = useSearchParamState("group", "category");
  const [upload, setUpload] = useState<{ files: File[]; replace: StoredFile | null } | null>(null);
  const categoryFilter = useCategoryFilter("file");
  const packages = usePackageActions({
    permissions: session.permissions,
    kind: "file",
    category: categoryFilter.category,
  });
  const origin = useCatalogCreatedBy();
  const list = useInfiniteList<ListedFile>(LIST_PATH, {
    ...LIST_PARAMS,
    q: search.trim() || undefined,
    category: categoryFilter.category,
    description_source: origin.descriptionSource,
    group_by: groupMode === "category" ? "category" : undefined,
  });
  const { query, items } = list;
  const total = list.total ?? items.length;
  const unfiltered = search.trim() === "" && !categoryFilter.category && !origin.active;
  const hasFiles = items.length > 0 || !unfiltered;

  const dropOnPage = useMemo(() => (files: File[]) => setUpload({ files, replace: null }), []);
  const dragging = usePageDrop(canWrite && upload === null && !packages.open, dropOnPage);

  const columns = useMemo<CockpitColumn<ListedFile>[]>(() => {
    const column = tableColumns<ListedFile>({ t, dateTime });
    return [
      column.custom(
        "filename",
        (row) => row.filename,
        t("files.column.name"),
        (row) => {
          const used = fileUsageLine(t, row.usage);
          return (
            <span className="block min-w-0">
              <CatalogNameCell
                name={row.filename}
                record={row}
                hideCategory={groupMode === "category"}
              />
              {used ? (
                <span
                  className="block truncate text-xs text-muted-foreground"
                  data-testid="file-row-usage"
                >
                  {used}
                </span>
              ) : null}
            </span>
          );
        },
        { width: "w-[50%]" },
      ),
      column.custom(
        "kind",
        (row) => row.content_type,
        t("files.column.kind"),
        (row) => `${fileKindLabel(t, row)} · ${sizeText(row.size_bytes, LOCALE_TAGS[locale])}`,
        { width: "w-[25%]" },
      ),
      column.date("created_at", (row) => row.created_at, t("files.column.uploaded"), {
        width: "w-[25%]",
      }),
    ];
  }, [t, dateTime, locale, groupMode]);

  const uploadAction = canWrite ? (
    <Button data-testid="files-upload" onClick={() => setUpload({ files: [], replace: null })}>
      {t("files.upload")}
    </Button>
  ) : null;
  const installationActions =
    installation.available && canWrite && canIntakeWrite ? (
      <InstallationInputActions
        onFiles={(files) => installation.stageIncoming({ title: "", text: "", url: "", files })}
        onClipboard={() => {
          void navigator.clipboard
            .readText()
            .then((text) => installation.stageIncoming({ title: "", text, url: "", files: [] }))
            .catch(() => {});
        }}
      />
    ) : null;
  const fileActions =
    uploadAction || installationActions ? (
      <div className="flex flex-wrap gap-2">
        {installationActions}
        {uploadAction}
      </div>
    ) : null;
  const allLoaded = !list.infinite.hasNextPage;
  const onboarding = unfiltered && items.length === 0 && query.isSuccess && allLoaded;
  const totalBytes = items.reduce(
    (sum, file) => sum + (typeof file.size_bytes === "number" ? file.size_bytes : 0),
    0,
  );

  return (
    <Page
      kind="list"
      surface="collection"
      testId="files-page"
      scroll="content"
      header={
        <PageHeader
          title={t("files.title")}
          action={(onboarding ? installationActions : fileActions) ?? undefined}
          menu={
            packages.items.length > 0 ? (
              <ActionMenu alwaysMenu testId="files-page-actions" items={packages.items} />
            ) : undefined
          }
        />
      }
    >
      {onboarding ? (
        <FilesOnboarding canWrite={canWrite} onFiles={dropOnPage} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {dragging ? (
            <FileDrop
              multiple
              maxBytes={UPLOAD_MAX_BYTES}
              label={t("files.drop")}
              onFiles={dropOnPage}
              testId="files-page-drop"
            />
          ) : null}
          {items.length > 0 || !unfiltered ? (
            <CatalogSummary
              testId="files-summary"
              kind="file"
              text={
                allLoaded
                  ? t(pluralKey("files.summary", total), {
                      count: total,
                      size: formatBytes(totalBytes, LOCALE_TAGS[locale]),
                    })
                  : t(pluralKey("files.summaryCount", total), { count: total })
              }
              help={t("files.summaryHelp")}
            />
          ) : null}
          <DataTable
            collectionId="files"
            columns={columns}
            data={items}
            groupingTabs={
              <>
                <GroupingTabs
                  label={t("common.groupBy")}
                  value={groupMode}
                  onChange={setGroupMode}
                  options={[
                    { value: "all", label: t("common.all") },
                    { value: "category", label: t("resource.field.category") },
                    { value: "kind", label: t("files.column.kind") },
                    { value: "date", label: t("files.column.uploaded") },
                  ]}
                  testId="files-grouping"
                  note={
                    groupMode === "all" || groupMode === "category"
                      ? undefined
                      : t("common.loadedOnly")
                  }
                />
                <CatalogCategoryChips
                  usage={categoryFilter.usage}
                  value={categoryFilter.value}
                  onChange={categoryFilter.setValue}
                />
              </>
            }
            grouping={
              groupMode === "all"
                ? undefined
                : groupMode === "category"
                  ? catalogCategoryGrouping<ListedFile>({
                      getCategory: (row) => recordCategory(row),
                      otherLabel: t("catalog.categoryOther"),
                      ...(search.trim() || origin.active
                        ? {}
                        : { counts: categoryCounts(categoryFilter.usage) }),
                      needsAttention: (row) => row.status === "failed",
                    })
                  : {
                      getKey: (row) =>
                        groupMode === "kind"
                          ? fileKindLabel(t, row)
                          : new Intl.DateTimeFormat("sv-SE", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                            }).format(new Date(row.created_at)),
                      label: (key) =>
                        groupMode === "date"
                          ? new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
                              dateStyle: "medium",
                            }).format(new Date(`${key}T12:00:00`))
                          : key,
                      compareKeys:
                        groupMode === "date"
                          ? (left, right) => right.localeCompare(left)
                          : undefined,
                    }
            }
            getRowId={(row) => row.id}
            infinite={list.infinite}
            total={list.total}
            toolbar={
              hasFiles ? (
                <>
                  <FilterBar
                    search={{
                      value: search,
                      onChange: setSearch,
                      placeholder: t("files.search"),
                      testId: "files-search",
                    }}
                    selects={[
                      ...(categoryFilter.select ? [categoryFilter.select] : []),
                      origin.select,
                    ]}
                    reset={{
                      label: t("catalog.clearFilters"),
                      onClick: () => {
                        setSearch("");
                        categoryFilter.select?.onChange("all");
                        origin.setValue("all");
                      },
                    }}
                  />
                  {origin.chip}
                </>
              ) : undefined
            }
            pending={query.isPending && !query.failureReason}
            error={
              query.error
                ? {
                    title: t("resource.loadFailed", { resource: t("files.title") }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void query.refetch(),
                  }
                : null
            }
            emptyState={{
              zero: { title: t("files.empty"), action: uploadAction },
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
            hasActiveFilters={!unfiltered}
            sorting={[]}
            onSortingChange={() => {}}
            onOpen={(row) => void navigate({ to: recordHref("files", row.id) })}
            rowHref={(row) => recordHref("files", row.id)}
            columnsLabel={t("catalog.columns")}
            recordsLabel={t("catalog.records")}
            actionsLabel={t("common.actions")}
          />
        </div>
      )}
      {upload ? (
        <UploadDialog
          initial={upload.files}
          replace={upload.replace}
          onClose={() => setUpload(null)}
        />
      ) : null}
      {packages.dialogs}
    </Page>
  );
}

interface QueuedFile {
  key: string;
  file: File;
  progress: number;
  failed: string | null;
}

function UploadDialog({
  initial,
  replace,
  onClose,
}: {
  initial: File[];
  replace: StoredFile | null;
  onClose(): void;
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const single = replace !== null;
  const [queue, setQueue] = useState<QueuedFile[]>(() =>
    toQueue(initial.slice(0, single ? 1 : undefined)),
  );
  const [busy, setBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const previewed = queue.find((item) => item.key === previewKey) ?? queue[0] ?? null;

  function toQueue(files: File[]): QueuedFile[] {
    return files.map((file, index) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${index}-${Date.now()}`,
      file,
      progress: 0,
      failed: null,
    }));
  }
  const add = (files: File[]) =>
    setQueue((current) => (single ? toQueue(files.slice(0, 1)) : [...current, ...toQueue(files)]));
  const setOne = (key: string, change: Partial<QueuedFile>) =>
    setQueue((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );

  const submit = async () => {
    if (queue.length === 0 || busy) return;
    setBusy(true);
    const done: StoredFile[] = [];
    for (const item of queue) {
      if (item.progress >= 1 && !item.failed) continue;
      setOne(item.key, { progress: 0, failed: null });
      try {
        const body = {
          filename: item.file.name,
          content_type: item.file.type || undefined,
          content_base64: await readBase64(item.file),
        };
        const path = replace
          ? `/v1/files/${encodeURIComponent(replace.id)}/replace`
          : "/v1/files/inline";
        const stored = await apiUpload<StoredFile>(path, body, (progress) =>
          setOne(item.key, { progress }),
        );
        done.push(stored);
      } catch (error) {
        setOne(item.key, { failed: uploadFailure(t, item.file.name, error) });
      }
    }
    setBusy(false);
    void client.invalidateQueries({ queryKey: ["catalog"] });
    if (replace) void client.invalidateQueries({ queryKey: ["file", replace.id] });
    const failed = done.length < queue.length;
    if (done.length > 0)
      toast.success(
        replace
          ? t("files.replaced", { name: done[0]?.filename ?? replace.filename })
          : done.length === 1
            ? t("files.uploaded", { name: done[0]?.filename ?? "" })
            : t("files.uploadedMany", { count: done.length }),
      );
    if (!failed) onClose();
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={replace ? t("files.replaceTitle", { name: replace.filename }) : t("files.uploadTitle")}
      submit={{
        label: replace ? t("files.replace") : t("files.upload"),
        pending: busy,
        disabled: queue.length === 0,
      }}
      onSubmit={submit}
      testId="files-upload-dialog"
    >
      {replace ? <p className="text-sm text-muted-foreground">{t("files.replaceLine")}</p> : null}
      <FileDrop
        multiple={!single}
        maxBytes={UPLOAD_MAX_BYTES}
        label={single ? t("files.dropReplace") : t("files.drop")}
        onFiles={add}
        disabled={busy}
        testId="files-upload-drop"
      />
      {queue.length > 0 ? (
        <ul
          aria-label={t("files.queued")}
          className="flex flex-col gap-2"
          data-testid="files-upload-queue"
        >
          {queue.map((item, index) => (
            <li
              key={item.key}
              className="flex min-w-0 items-center gap-3 text-sm"
              data-testid={`files-upload-item-${index}`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  {queue.length > 1 ? (
                    <button
                      type="button"
                      className={cn(
                        "truncate text-left underline-offset-4 hover:underline",
                        item.key === previewed?.key && "font-medium",
                      )}
                      aria-pressed={item.key === previewed?.key}
                      onClick={() => setPreviewKey(item.key)}
                      data-testid={`files-upload-show-${index}`}
                    >
                      {item.file.name}
                    </button>
                  ) : (
                    <span className="truncate">{item.file.name}</span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(item.file.size, LOCALE_TAGS[locale])}
                  </span>
                </span>
                {item.failed ? (
                  <span className="text-xs text-destructive">{item.failed}</span>
                ) : (
                  <span
                    role="progressbar"
                    aria-label={t("files.progress", { name: item.file.name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progress * 100)}
                    className="h-1 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full bg-primary transition-[width] duration-(--sk-dur-fast) motion-reduce:transition-none"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </span>
                )}
              </span>
              <IconButton
                type="button"
                variant="ghost"
                size="icon-sm"
                label={t("files.remove", { name: item.file.name })}
                disabled={busy}
                onClick={() =>
                  setQueue((current) => current.filter((entry) => entry.key !== item.key))
                }
                data-testid={`files-upload-remove-${index}`}
              >
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      {previewed ? (
        <FilePreview
          key={previewed.key}
          name={previewed.file.name}
          file={previewed.file}
          testId="files-upload-preview"
        />
      ) : null}
    </FormDialog>
  );
}

const FILE_USES = [
  { key: "templates", icon: FileText },
  { key: "tables", icon: Sheet },
  { key: "images", icon: ImageIcon },
] as const;

function FilesOnboarding({
  canWrite,
  onFiles,
}: {
  canWrite: boolean;
  onFiles(files: File[]): void;
}) {
  const { t, locale } = useI18n();
  return (
    <OnboardingFrame lead={t("files.onboarding.lead")} testId="files-onboarding">
      {canWrite ? (
        <FileDrop
          multiple
          maxBytes={UPLOAD_MAX_BYTES}
          label={t("files.onboarding.drop")}
          hint={t("files.onboarding.dropHint", {
            max: formatBytes(UPLOAD_MAX_BYTES, LOCALE_TAGS[locale]),
          })}
          onFiles={onFiles}
          testId="files-onboarding-drop"
        />
      ) : null}
      <section className="flex flex-col gap-2" aria-labelledby="files-onboarding-uses">
        <SectionHeading id="files-onboarding-uses">{t("files.onboarding.uses")}</SectionHeading>
        <ul className="grid gap-3 sm:grid-cols-3">
          {FILE_USES.map((use) => (
            <li key={use.key} className="flex items-start gap-3 rounded-lg border p-4">
              <IconTile>
                <use.icon />
              </IconTile>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t(`files.onboarding.${use.key}.title`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(`files.onboarding.${use.key}.line`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </OnboardingFrame>
  );
}

function Mono({ children }: { children: string }) {
  return <span className="font-mono text-xs [overflow-wrap:anywhere]">{children}</span>;
}

export function FilePage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const canWrite = session.permissions.includes("file:write");
  const canDelete = session.permissions.includes("file:delete");
  const [replacing, setReplacing] = useState<StoredFile | null>(null);
  const installation = useInstallation();
  const directory = useActorDirectory(true);
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileQuery = useQuery({
    queryKey: ["file", id],
    queryFn: () => apiCall("get", "/v1/files/{id}", { path: { id } }),
    ...live,
  });
  const metadataActions = useCatalogMetadataActions({
    kind: "file",
    id,
    record: fileQuery.data,
    queryKey: ["file", id],
    onEdit: () => setEditing(true),
    label: t("files.edit"),
  });
  const versionsQuery = useFileVersions(id);
  const usageQuery = useQuery({
    queryKey: ["file", id, "usage"],
    queryFn: () => apiCall("get", "/v1/files/{id}/usage", { path: { id } }),
    ...live,
  });
  const file = fileQuery.data;
  const kind = file ? previewKind(file.filename, file.content_type) : "other";
  const textual = kind === "markdown" || kind === "text" || kind === "csv";
  const contentPath = tenantContentHref(`/v1/files/${encodeURIComponent(id)}/content`);
  const textQuery = useQuery({
    queryKey: ["file", id, "content", file?.updated_at],
    queryFn: () => apiText(contentPath),
    enabled: Boolean(file) && textual,
  });

  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/files/{id}", { path: { id } }),
    onSuccess: () => {
      toast.success(t("files.deleted", { name: file?.filename ?? "" }));
      void client.invalidateQueries({ queryKey: ["catalog"] });
      setDeleting(false);
      void navigate({ to: "/files" });
    },
    onError: () => toast.error(t("common.actionFailed")),
  });

  const usage = usageQuery.data;
  const workflowNames = usage?.workflows.map((workflow) => workflow.name) ?? [];
  const consequence =
    workflowNames.length > 1
      ? t("files.deleteUsed", { count: workflowNames.length, names: workflowNames.join(", ") })
      : workflowNames.length === 1
        ? t("files.deleteUsedOne", { names: workflowNames[0] ?? "" })
        : (usage?.conversations.length ?? 0) > 0
          ? t("files.deleteInConversations")
          : t("files.deletePlain");

  const menuItems = [
    ...(canWrite && file
      ? [{ label: t("files.replace"), onSelect: () => setReplacing(file), testId: "file-replace" }]
      : []),
    ...(canWrite ? metadataActions : []),
    ...(canDelete
      ? [
          {
            label: t("files.delete"),
            onSelect: () => setDeleting(true),
            destructive: true,
            testId: "file-delete",
          },
        ]
      : []),
  ];

  const exportFile = async () => {
    if (!file) return;
    setExporting(true);
    try {
      const result = await exportInstallationFile(
        file.filename,
        async () => await fetch(cockpitApiHref(contentPath), { credentials: "same-origin" }),
      );
      if (result === "unsupported") {
        const anchor = document.createElement("a");
        anchor.href = contentPath;
        anchor.download = file.filename;
        anchor.click();
      }
    } finally {
      setExporting(false);
    }
  };

  const download = file ? (
    <Button asChild>
      {installation.available ? (
        <button
          type="button"
          disabled={exporting}
          onClick={() => void exportFile()}
          data-testid="file-download"
        >
          <Download aria-hidden="true" />
          {t("files.download")}
        </button>
      ) : (
        <a href={contentPath} download={file.filename} data-testid="file-download">
          <Download aria-hidden="true" />
          {t("files.download")}
        </a>
      )}
    </Button>
  ) : null;
  const failed = fileQuery.error ? (
    <DataState
      state="error"
      line={
        fileQuery.error instanceof ApiError && fileQuery.error.status === 404
          ? t("files.notFound")
          : t("resource.loadFailed", { resource: t("files.title") })
      }
      onRetry={() => void fileQuery.refetch()}
      testId="file-page-error"
    />
  ) : null;
  const uploader = file ? fileUploaderName(file, directory, t) : t("runs.caller.unknown");
  const kindLabel = file ? fileKindLabel(t, file) : "";
  const size = file ? sizeText(file.size_bytes, LOCALE_TAGS[locale]) : "";
  const usedLine = usage
    ? fileUsageParts(t, {
        workflows: usage.workflows.length,
        conversations: usage.conversations.length,
        other: usage.other,
      })
    : null;
  const usageCards: UsageCard[] = [
    ...(usage?.workflows ?? []).map((workflow) => ({
      id: `workflow-${workflow.id}`,
      title: workflow.name,
      line: t("files.usage.workflowLine"),
      href: workflowHref(workflow.id),
      icon: <Workflow />,
    })),
    ...(usage?.conversations ?? []).map((conversation) => ({
      id: `conversation-${conversation.id}`,
      title: conversation.title ?? t("files.untitledConversation"),
      line: t("files.usage.conversationLine"),
      href: conversationHref(conversation.id),
      icon: <MessageSquare />,
    })),
    ...(usage?.other_links ?? []).map((link) => ({
      ...fileOtherLinkCard(link, t),
      icon: OTHER_LINK_ICONS[link.resource_type],
    })),
  ];

  return (
    <>
      <DetailPage
        testId="file-page"
        back={{ to: "/files", label: t("files.title") }}
        title={file?.filename ?? ""}
        badge={file ? <CatalogCategoryChip category={recordCategory(file)} /> : undefined}
        purpose={file ? <CatalogPurpose record={file} /> : undefined}
        loading={fileQuery.isPending}
        action={download}
        menu={
          menuItems.length > 0 ? (
            <ActionMenu alwaysMenu items={menuItems} testId="file-menu" />
          ) : null
        }
        tabs={
          file
            ? [
                {
                  value: "preview",
                  label: t("files.tab.preview"),
                  testId: "file-tab-preview",
                  content: (
                    <TabBody
                      testId="file-preview-tab"
                      summary={t("files.summaryLine", {
                        kind: kindLabel,
                        size,
                        when: dateTime(file.created_at),
                        name: uploader,
                      })}
                      technical={
                        <>
                          <div className="flex flex-col gap-2" data-testid="file-reference">
                            <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                              {t("files.reference")}
                              <ContextHelp
                                label={t("files.reference")}
                                testId="file-reference-help"
                              >
                                {t("files.referenceHelp")}
                              </ContextHelp>
                            </span>
                            <CopyField
                              labelled
                              value={fileReference(file)}
                              label={t("files.reference")}
                              testId="file-reference-value"
                            />
                          </div>
                          <FactList
                            testId="file-technical"
                            items={[
                              { label: t("files.fact.id"), value: <Mono>{file.id}</Mono> },
                              { label: t("files.fact.format"), value: file.content_type ?? "—" },
                              {
                                label: t("files.fact.checksum"),
                                value: file.sha256 ? <Mono>{file.sha256}</Mono> : "—",
                              },
                            ]}
                          />
                        </>
                      }
                    >
                      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
                        <FilePreview
                          name={file.filename}
                          mimeType={file.content_type}
                          size={typeof file.size_bytes === "number" ? file.size_bytes : undefined}
                          url={textual ? undefined : contentPath}
                          text={textual ? (textQuery.data ?? undefined) : undefined}
                          testId="file-preview"
                        />
                        <FactList
                          testId="file-facts"
                          layout="stacked"
                          items={[
                            { label: t("files.fact.kind"), value: kindLabel },
                            { label: t("files.fact.size"), value: size },
                            { label: t("files.fact.uploaded"), value: dateTime(file.created_at) },
                            { label: t("files.fact.by"), value: uploader },
                            ...(file.replaced_at
                              ? [
                                  {
                                    label: t("files.fact.replaced"),
                                    value: dateTime(file.replaced_at),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </div>
                    </TabBody>
                  ),
                },
                {
                  value: "usage",
                  label: t("files.tab.usage"),
                  count: usageCards.length || undefined,
                  loading: usageQuery.isPending,
                  testId: "file-tab-usage",
                  content: (
                    <TabBody
                      testId="file-usage-tab"
                      more={
                        versionsQuery.error || hasEarlierVersions(versionsQuery.data?.items) ? (
                          <FileVersionsSection
                            fileId={file.id}
                            fileName={file.filename}
                            canWrite={canWrite}
                          />
                        ) : undefined
                      }
                      summary={
                        usedLine
                          ? t("files.usage.summary", { uses: usedLine })
                          : usage
                            ? t("files.usage.none")
                            : undefined
                      }
                    >
                      <UsageCards items={usageCards} testId="file-usage" />
                    </TabBody>
                  ),
                },
              ]
            : undefined
        }
      >
        {failed}
      </DetailPage>
      {file && canWrite ? (
        <CatalogMetadataDialog
          kind="file"
          id={file.id}
          record={file}
          open={editing}
          onOpenChange={setEditing}
          queryKey={["file", id]}
          nameKey="filename"
          title={t("files.edit")}
        />
      ) : null}
      {file ? (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          object={file.filename}
          verb={t("files.delete")}
          consequence={consequence}
          destructive
          pending={remove.isPending}
          onConfirm={() => remove.mutateAsync().then(() => undefined)}
          testId="file-delete-dialog"
        />
      ) : null}
      {replacing ? (
        <UploadDialog initial={[]} replace={replacing} onClose={() => setReplacing(null)} />
      ) : null}
    </>
  );
}
