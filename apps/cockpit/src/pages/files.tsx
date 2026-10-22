import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest, apiText, apiUpload } from "@/api/client";
import type { components } from "@/api/schema";
import { tenantContentHref } from "@/api/tenant-context";
import { useActorDirectory } from "@/app/actor-directory";
import { actorDirectoryName } from "@/app/actor-directory-model";
import { cockpitApiHref } from "@/app/installation-context";
import { exportInstallationFile } from "@/app/installation-export";
import { useInstallation } from "@/app/installation-provider";
import { absolute, conversationHref, recordHref, workflowHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { CatalogOriginSummary, useCatalogOrigin } from "@/components/cockpit/catalog-categories";
import {
  CatalogMetadataDialog,
  CatalogMetadataSummary,
  CatalogNameCell,
  useCatalogMetadataActions,
  useCategoryFilter,
} from "@/components/cockpit/catalog-metadata";
import { IconButton } from "@/components/cockpit/icon-button";
import { InstallationInputActions } from "@/components/cockpit/installation-dialogs";
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
  Field,
  FieldLabel,
  FileDrop,
  FilePreview,
  FilterBar,
  FormDialog,
  formatBytes,
  GroupingTabs,
  Input,
  Page,
  PageHeader,
  previewKind,
  TabBody,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { LOCALE_TAGS, pluralKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { cn } from "@/lib/utils";

type StoredFile = components["schemas"]["File"] & {
  creator?: { kind: "user" | "system_account"; id: string } | null;
};
type ListedFile = components["schemas"]["FileListItem"];
type FileUsage = components["schemas"]["FileUsage"];

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const LIST_PATH = "/v1/files";
const LIST_PARAMS = { sort: "created_at", order: "desc" } as const;

export function fileReference(file: Pick<StoredFile, "id" | "reference">): string {
  return file.reference ?? JSON.stringify({ $file: file.id });
}

export function fileUsageLine(
  t: ReturnType<typeof useI18n>["t"],
  usage: ListedFile["usage"] | undefined,
): string | null {
  if (!usage) return null;
  const parts = [
    usage.workflows > 0
      ? usage.workflows === 1
        ? t("files.usage.workflow")
        : t("files.usage.workflows", { count: usage.workflows })
      : null,
    usage.conversations > 0
      ? usage.conversations === 1
        ? t("files.usage.conversation")
        : t("files.usage.conversations", { count: usage.conversations })
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? t("files.usage.line", { uses: parts.join(" · ") }) : null;
}

const KIND_KEYS = {
  image: "files.kind.image",
  pdf: "files.kind.pdf",
  csv: "files.kind.csv",
  markdown: "files.kind.markdown",
  text: "files.kind.text",
  other: "files.kind.other",
} as const;

function sizeText(bytes: unknown, locale: string): string {
  return typeof bytes === "number" ? formatBytes(bytes, locale) : "—";
}

function fileKindLabel(t: ReturnType<typeof useI18n>["t"], file: StoredFile): string {
  return t(KIND_KEYS[previewKind(file.filename, file.content_type)]);
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
  const [search, setSearch] = useState("");
  const [groupMode, setGroupMode] = useState("all");
  const [upload, setUpload] = useState<{ files: File[]; replace: StoredFile | null } | null>(null);
  const categoryFilter = useCategoryFilter("file");
  const origin = useCatalogOrigin();
  const list = useInfiniteList<ListedFile>(LIST_PATH, {
    ...LIST_PARAMS,
    q: search.trim() || undefined,
    category: categoryFilter.category,
    description_source: origin.descriptionSource,
  });
  const { query, items } = list;
  const total = list.total ?? items.length;
  const unfiltered = search.trim() === "" && !categoryFilter.category && !origin.active;
  const hasFiles = items.length > 0 || !unfiltered;

  const dropOnPage = useMemo(() => (files: File[]) => setUpload({ files, replace: null }), []);
  const dragging = usePageDrop(canWrite && upload === null, dropOnPage);

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
              <CatalogNameCell name={row.filename} record={row} />
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
  }, [t, dateTime, locale]);

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
          eyebrow={t("nav.group.knowledge")}
          title={t("files.title")}
          action={hasFiles ? fileActions : undefined}
        />
      }
    >
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
          <CatalogOriginSummary
            testId="files-summary"
            kind="file"
            origin={origin}
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
            <GroupingTabs
              label={t("common.groupBy")}
              value={groupMode}
              onChange={setGroupMode}
              options={[
                { value: "all", label: t("common.all") },
                { value: "kind", label: t("files.column.kind") },
                { value: "date", label: t("files.column.uploaded") },
              ]}
              testId="files-grouping"
              note={groupMode === "all" ? undefined : t("common.loadedOnly")}
            />
          }
          grouping={
            groupMode === "all"
              ? undefined
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
                    groupMode === "date" ? (left, right) => right.localeCompare(left) : undefined,
                }
          }
          getRowId={(row) => row.id}
          infinite={list.infinite}
          total={list.total}
          toolbar={
            hasFiles ? (
              <FilterBar
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: t("files.search"),
                  testId: "files-search",
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
            zero: { title: t("files.empty"), action: fileActions },
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
      {upload ? (
        <UploadDialog
          initial={upload.files}
          replace={upload.replace}
          onClose={() => setUpload(null)}
        />
      ) : null}
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

export function FilePage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const canWrite = session.permissions.includes("file:write");
  const canDelete = session.permissions.includes("file:delete");
  const [replacing, setReplacing] = useState<StoredFile | null>(null);
  const onClose = () => void navigate({ to: "/files" });
  const onReplace = (file: StoredFile) => setReplacing(file);
  const installation = useInstallation();
  const directory = useActorDirectory(true);
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileQuery = useQuery({
    queryKey: ["file", id],
    queryFn: () => apiRequest<StoredFile>(`/v1/files/${encodeURIComponent(id)}`),
    ...live,
  });
  const metadataActions = useCatalogMetadataActions({
    kind: "file",
    id,
    record: fileQuery.data,
    queryKey: ["file", id],
    onEdit: () => setDescribing(true),
  });
  const usageQuery = useQuery({
    queryKey: ["file", id, "usage"],
    queryFn: () => apiRequest<FileUsage>(`/v1/files/${encodeURIComponent(id)}/usage`),
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
    mutationFn: () => apiRequest(`/v1/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("files.deleted", { name: file?.filename ?? "" }));
      void client.invalidateQueries({ queryKey: ["catalog"] });
      setDeleting(false);
      onClose();
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
    ...(canWrite ? metadataActions : []),
    ...(canWrite && file
      ? [
          { label: t("files.replace"), onSelect: () => onReplace(file), testId: "file-replace" },
          { label: t("files.rename"), onSelect: () => setRenaming(true), testId: "file-rename" },
        ]
      : []),
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

  const usedBy = usage ? (
    usage.workflows.length + usage.conversations.length + usage.other === 0 ? (
      <span className="text-muted-foreground">{t("files.notUsed")}</span>
    ) : (
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {usage.workflows.map((workflow) => (
          <a
            key={workflow.id}
            href={absolute(workflowHref(workflow.id))}
            className="underline-offset-4 hover:underline"
            data-testid="file-used-by-workflow"
          >
            {workflow.name}
          </a>
        ))}
        {usage.conversations.map((conversation) => (
          <a
            key={conversation.id}
            href={absolute(conversationHref(conversation.id))}
            className="underline-offset-4 hover:underline"
            data-testid="file-used-by-conversation"
          >
            {conversation.title ?? t("files.untitledConversation")}
          </a>
        ))}
        {usage.other > 0 ? (
          <span className="text-muted-foreground">
            {t("files.otherUses", { count: usage.other })}
          </span>
        ) : null}
      </span>
    )
  ) : null;

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
          {t("files.download")}
        </button>
      ) : (
        <a href={contentPath} download={file.filename} data-testid="file-download">
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

  return (
    <>
      <DetailPage
        testId="file-page"
        back={{ to: "/files", label: t("files.title") }}
        title={file?.filename ?? ""}
        purpose={file ? <CatalogMetadataSummary record={file} /> : undefined}
        loading={fileQuery.isPending}
        action={download}
        menu={menuItems.length > 0 ? <ActionMenu items={menuItems} testId="file-menu" /> : null}
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
                      technical={
                        <div className="flex flex-col gap-2" data-testid="file-reference">
                          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                            {t("files.reference")}
                            <ContextHelp label={t("files.reference")} testId="file-reference-help">
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
                      }
                    >
                      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
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
                            { label: t("files.fact.kind"), value: fileKindLabel(t, file) },
                            {
                              label: t("files.fact.size"),
                              value: sizeText(file.size_bytes, LOCALE_TAGS[locale]),
                            },
                            {
                              label: t("files.fact.uploaded"),
                              value: t("files.uploadedBy", {
                                date: dateTime(file.created_at),
                                name: file.creator
                                  ? (actorDirectoryName(
                                      directory,
                                      file.creator.kind,
                                      file.creator.id,
                                    ) ?? t("runs.caller.unknown"))
                                  : t("runs.caller.unknown"),
                              }),
                            },
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
                  testId: "file-tab-usage",
                  content: (
                    <TabBody testId="file-usage-tab">
                      <FactList
                        testId="file-usage"
                        items={[{ label: t("files.fact.usedBy"), value: usedBy ?? "…" }]}
                      />
                    </TabBody>
                  ),
                },
              ]
            : undefined
        }
      >
        {failed}
      </DetailPage>
      {file && renaming ? <RenameDialog file={file} onClose={() => setRenaming(false)} /> : null}
      {file && canWrite ? (
        <CatalogMetadataDialog
          kind="file"
          id={file.id}
          record={file}
          open={describing}
          onOpenChange={setDescribing}
          queryKey={["file", id]}
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

function RenameDialog({ file, onClose }: { file: StoredFile; onClose(): void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [name, setName] = useState(file.filename);
  const rename = useMutation({
    mutationFn: (filename: string) =>
      apiRequest<StoredFile>(`/v1/files/${encodeURIComponent(file.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ filename }),
      }),
    onSuccess: (updated) => {
      client.setQueryData(["file", file.id], updated);
      void client.invalidateQueries({ queryKey: ["catalog"] });
      toast.success(t("files.renamed"));
      onClose();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  const trimmed = name.trim();
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("files.renameTitle")}
      submit={{
        label: t("files.rename"),
        pending: rename.isPending,
        disabled: trimmed === "" || trimmed === file.filename,
      }}
      onSubmit={() => rename.mutate(trimmed)}
      testId="file-rename-dialog"
    >
      <Field>
        <FieldLabel htmlFor="file-rename-name">{t("common.name")}</FieldLabel>
        <Input
          id="file-rename-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          data-testid="file-rename-name"
        />
      </Field>
      <p className="text-sm text-muted-foreground">
        {file.reference
          ? t("files.renameKeeps", { reference: file.reference })
          : t("files.replaceLine")}
      </p>
    </FormDialog>
  );
}
