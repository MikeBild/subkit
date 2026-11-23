import { csvPreview, fileKindOf, formatBytes } from "@shared/file-kinds.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconTile } from "@ui/atoms/icon-tile";
import { listPageFailure } from "@ui/lib/errors";
import { FILE_ICON } from "@ui/lib/files";
import { DropZone } from "@ui/molecules/drop-zone";
import { DropdownMenuItem } from "@ui/molecules/dropdown-menu";
import { ErrorNotice, ErrorState } from "@ui/molecules/error-notice";
import { IconButton } from "@ui/molecules/icon-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { CodeBlock, MarkdownDocument } from "@ui/organisms/markdown-document";
import { AlertTriangle, Download, FileText, FileType2, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError, apiText, apiUpload } from "@/api/client";
import { tenantContentHref } from "@/api/tenant-context";
import { useActorDirectory } from "@/app/actor-directory";
import { actorDirectoryName } from "@/app/actor-directory-model";
import { cockpitApiHref } from "@/app/installation-context";
import { exportInstallationFile } from "@/app/installation-export";
import { useInstallation } from "@/app/installation-provider";
import { conversationHref, recordHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import type { ActionMenuItem } from "@/components/cockpit/patterns/action-menu";
import { CodeBlock as PatternCode } from "@/components/cockpit/patterns/code-block";
import { Button } from "@/components/cockpit/patterns/controls";
import { TopPageHeader } from "@/components/cockpit/patterns/page-header";
import { SectionHeading } from "@/components/cockpit/patterns/section";
import { usePageFailure } from "@/components/cockpit/patterns/use-error-detail";
import { CatalogPurpose, fileOtherLinkCard } from "@/features/catalog";
import {
  checkUploads,
  dropQueued,
  type FileView,
  fileView,
  groupBy,
  type Incoming,
  matches,
  previewedUpload,
} from "@/features/knowledge/model/knowledge";
import { humanizeCategory } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { plural } from "@/lib/plural";
import { categoryCounts, createdByMatches, dayGroup, sortRows, sortValueOf } from "./list-model";
import { LocalImagePreview } from "./local-image-preview";
import { KEYS, useFiles, useRefreshKnowledge } from "./queries";
import {
  ChatMenu,
  ConfirmDelete,
  DetailShell,
  GroupedTable,
  type Head,
  ListSkeleton,
  ListSummary,
  Loaded,
  NameCell,
  NoMatch,
  OnboardingCard,
  Row,
  Toolbar,
  UsageList,
  type Use,
  useColumnChoice,
  useListState,
  useMetadataMenu,
  usePageMenu,
  useRel,
  VersionsTab,
} from "./shell";

type StoredFile = NonNullable<ReturnType<typeof useFiles>["data"]>["items"][number];
const KIND_KEY = {
  image: "kn.files.kind.image",
  pdf: "kn.files.kind.pdf",
  csv: "kn.files.kind.csv",
  md: "kn.files.kind.md",
  text: "kn.files.kind.text",
} as const;
const PROMPTS = [
  "kn.files.prompt.summarize",
  "kn.files.prompt.analyze",
  "kn.files.prompt.workflow",
] as const;
const contentPath = (id: string) => `/v1/files/${encodeURIComponent(id)}/content`;

function readBase64(file: Blob): Promise<string> {
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

async function sha256(file: Blob): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface QItem {
  key: string;
  file: File;
  name: string;
  size: number;
  progress: number;
  error?: "tooBig" | "duplicate" | "failed";
  existingId?: string | undefined;
}

function useUploads(stored: readonly StoredFile[]) {
  const { t } = useI18n();
  const refresh = useRefreshKnowledge();
  const [queue, setQueue] = useState<QItem[]>([]);
  const dropped = useRef(new Set<string>());
  const add = async (list: FileList | File[]) => {
    const files = Array.from(list);
    const incoming: Incoming[] = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        size: f.size,
        hash: f.size > 5_000_000 ? `big-${f.name}` : await sha256(f),
      })),
    );
    const checks = checkUploads(
      incoming,
      stored.flatMap((f) => (f.sha256 ? [f.sha256] : [])),
    );
    const stamp = crypto.randomUUID();
    const rows: QItem[] = incoming.map((it, i) => {
      const c = checks[i];
      const bad = c && !c.ok ? c.reason : undefined;
      return {
        key: `${it.name}-${stamp}-${i}`,
        file: files[i] as File,
        name: it.name,
        size: it.size,
        progress: bad ? 1 : 0,
        ...(bad ? { error: bad, existingId: stored.find((f) => f.sha256 === it.hash)?.id } : {}),
      };
    });
    setQueue((q) => [...rows, ...q]);
    const set = (key: string, change: Partial<QItem>) =>
      setQueue((q) => q.map((r) => (r.key === key ? { ...r, ...change } : r)));
    let done = 0;
    for (const [i, f] of files.entries()) {
      const row = rows[i];
      if (!row || row.error || dropped.current.has(row.key)) continue;
      try {
        await apiUpload(
          "/v1/files/inline",
          {
            filename: f.name,
            content_type: f.type || undefined,
            content_base64: await readBase64(f),
          },
          (p) => set(row.key, { progress: p }),
        );
        set(row.key, { progress: 1 });
        done++;
      } catch (error) {
        set(row.key, {
          progress: 1,
          error: error instanceof ApiError && error.status === 413 ? "tooBig" : "failed",
        });
      }
    }
    if (done) {
      toast.success(plural(t, "kn.up.done", done));
      void refresh();
    }
  };
  return {
    queue,
    add: (f: FileList | File[]) => void add(f),
    clear: () => setQueue([]),
    remove: (key: string) => {
      dropped.current.add(key);
      setQueue((q) => dropQueued(q, key));
    },
  };
}

function UploadButton({
  variant = "default",
  size,
  onFiles,
  inputRef,
}: {
  variant?: "default" | "outline";
  size?: "sm";
  onFiles: (f: FileList) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const { t } = useI18n();
  return (
    <Button asChild variant={variant} {...(size ? { size } : {})}>
      <label className="cursor-pointer">
        <Upload className="size-4" aria-hidden />
        {t("kn.files.upload")}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
    </Button>
  );
}

function LocalPreview({ file }: { file: File }) {
  const { t, locale } = useI18n();
  const kind = fileKindOf(file.name);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (kind === "image" || kind === "pdf") return;
    let live = true;
    void file
      .slice(0, 4000)
      .text()
      .then((v) => live && setText(v.split("\n").slice(0, 40).join("\n")));
    return () => {
      live = false;
    };
  }, [file, kind]);
  const noPreview = (
    <p data-testid="kn-up-preview" className="text-sm text-muted-foreground">
      {file.name} · {formatBytes(file.size, locale)} · {t("kn.files.noPreview")}
    </p>
  );
  if (kind === "image") return <LocalImagePreview file={file} fallback={noPreview} />;
  if (kind === "pdf" || text === null) return noPreview;
  return <PatternCode fit code={text || "—"} label={file.name} testId="kn-up-preview" />;
}

function UploadQueue({
  queue,
  onClear,
  onPick,
  onRemove,
}: {
  queue: QItem[];
  onClear: () => void;
  onPick: () => void;
  onRemove: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [shown, setShown] = useState<string | null>(null);
  const previewed = previewedUpload(queue, shown);
  if (!queue.length) return null;
  return (
    <section aria-label={t("kn.up.queue")} className="mb-6 rounded-xl border">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <SectionHeading className="text-sm font-semibold">{t("kn.up.queue")}</SectionHeading>
        <Button
          data-testid="kn-up-clear"
          size="sm"
          variant="ghost"
          className="-mr-2"
          onClick={onClear}
        >
          {t("kn.up.clear")}
        </Button>
      </div>
      <ul>
        {queue.map((r) => (
          <li key={r.key} className="flex items-center gap-3 border-b px-4 py-3 last:border-0">
            <IconTile
              icon={r.error ? AlertTriangle : FILE_ICON[fileKindOf(r.name)]}
              size="sm"
              {...(r.error ? { tone: "danger" as const } : {})}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  data-testid="kn-up-show"
                  aria-pressed={previewed?.key === r.key}
                  className="min-w-0 truncate text-left text-sm font-medium underline-offset-4 hover:underline"
                  onClick={() => setShown(previewed?.key === r.key ? null : r.key)}
                >
                  {r.name}
                </button>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {formatBytes(r.size, locale)}
                  <IconButton
                    data-testid="kn-up-remove"
                    label={t("files.remove", { name: r.name })}
                    onClick={() => onRemove(r.key)}
                  >
                    <X className="size-4" aria-hidden />
                  </IconButton>
                </span>
              </div>
              {r.error ? (
                <ErrorNotice
                  className="mt-2"
                  kind={r.error === "failed" ? "upload_failed" : r.error}
                  rows={[]}
                  {...(r.error === "failed" ? { title: t("kn.up.failed") } : {})}
                  primary={
                    r.error === "duplicate" && r.existingId
                      ? {
                          label: t("kn.up.openExisting"),
                          onClick: () =>
                            void navigate({ to: recordHref("files", r.existingId ?? "") }),
                        }
                      : { label: t("kn.up.chooseOther"), onClick: onPick }
                  }
                />
              ) : (
                <div className="mt-2 flex items-center gap-3">
                  <div
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={r.name}
                    aria-valuenow={Math.round(r.progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-150"
                      style={{ width: `${Math.round(r.progress * 100)}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                    {r.progress >= 1
                      ? t("kn.up.ready")
                      : `${t("kn.up.uploading")} ${Math.round(r.progress * 100)} %`}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {previewed && (
        <div className="border-t p-4">
          <LocalPreview key={previewed.key} file={previewed.file} />
        </div>
      )}
    </section>
  );
}

export function FilesPage() {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const session = useSession();
  const installation = useInstallation();
  const canWrite = session.permissions.includes("file:write");
  const canStage =
    installation.available && canWrite && session.permissions.includes("intake:write");
  const st = useListState();
  const menu = usePageMenu({ pkg: "file", categories: "file", category: st.cat });
  const query = useFiles();
  const stored = query.data?.items ?? [];
  const up = useUploads(stored);
  const picker = useRef<HTMLInputElement>(null);
  const views = useMemo(() => stored.map(fileView), [stored]);
  const items = sortRows(
    views.filter(
      (x) =>
        (st.cat === "all" || x.category === st.cat) &&
        createdByMatches(x.describedBy, st.createdBy) &&
        matches(st.q, x.name, t(KIND_KEY[x.kind]), x.category),
    ),
    sortValueOf(FILE_SORT, st.sort.key),
    st.sort.order,
  );
  const other = t("catalog.categoryOther");
  const key =
    st.group === "kind"
      ? (x: FileView) => t(KIND_KEY[x.kind])
      : st.group === "category"
        ? (x: FileView) => humanizeCategory(x.category, other)
        : st.group === "date"
          ? (x: FileView) => dayGroup(x.uploaded, LOCALE_TAGS[locale])
          : null;
  const total = items.reduce((n, x) => n + x.size, 0);
  const head: Head[] = [
    { label: t("kn.files.col.file"), sort: "name" },
    { label: t("kn.col.category"), sort: "category" },
    { label: t("kn.col.kind"), sort: "kind" },
    { label: t("kn.files.col.uploaded"), sort: "uploaded", priority: "low" },
  ];
  const columns = useColumnChoice(head);
  const stage = (files: File[], text = "") =>
    installation.stageIncoming({ title: "", text, url: "", files });
  const stageItems: ActionMenuItem[] = canStage
    ? [
        {
          label: t("installation.openFile"),
          onSelect: () => pickInstallationFiles(stage),
          testId: "installation-import-file",
        },
        {
          label: t("installation.clipboard"),
          disabled: !installation.capabilities.clipboard,
          onSelect: () =>
            void navigator.clipboard
              .readText()
              .then((text) => stage([], text))
              .catch(() => {}),
          testId: "installation-import-clipboard",
        },
      ]
    : [];
  const failure = usePageFailure(
    listPageFailure({
      failed: query.isError,
      loaded: query.data !== undefined,
      onRetry: () => void query.refetch(),
      error: query.error,
      collectionId: "kn",
    }),
  );
  if (failure) return <ErrorState {...failure} heading="h1" />;
  return (
    <div>
      <TopPageHeader
        title={t("nav.files")}
        help={t("kn.files.help")}
        action={
          <div className="flex items-center gap-2">
            <ChatMenu items={[...stageItems, ...menu.items]} prompts={PROMPTS.map((k) => t(k))} />
            {canWrite && <UploadButton inputRef={picker} onFiles={up.add} />}
          </div>
        }
      />
      {query.data && views.length === 0 && (
        <OnboardingCard
          icon={FileText}
          title={t("kn.files.onboardTitle")}
          text={t("kn.files.onboardText")}
        />
      )}
      {canWrite && (
        <div className="mb-6">
          <DropZone
            title={t("kn.up.drop")}
            hint={t("kn.up.pick")}
            multiple
            compact
            onFiles={up.add}
          />
        </div>
      )}
      <UploadQueue
        queue={up.queue}
        onClear={up.clear}
        onRemove={up.remove}
        onPick={() => picker.current?.click()}
      />
      <Loaded query={query}>
        {() => (
          <>
            <Toolbar
              st={st}
              groups={["category", "kind", "date"]}
              categories={categoryCounts(views)}
              createdBy
              columns={columns}
            />
            <ListSummary
              testId="kn-files-summary"
              kind="file"
              parts={[
                plural(t, "kn.files.count", items.length, { size: formatBytes(total, locale) }),
              ]}
            />
            {items.length ? (
              <GroupedTable
                head={head}
                hidden={columns.hidden}
                sort={st.sort}
                onSort={st.sortBy}
                groups={groupBy(items, key)}
                row={(x) => (
                  <Row
                    key={x.id}
                    onOpen={() => void navigate({ to: recordHref("files", x.id) })}
                    label={x.name}
                  >
                    <td>
                      <NameCell
                        icon={<IconTile icon={FILE_ICON[x.kind]} size="sm" />}
                        title={x.name}
                        sub={[
                          formatBytes(x.size, locale),
                          x.usedBy ? plural(t, "kn.files.usedIn", x.usedBy) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    </td>
                    <td>{humanizeCategory(x.category, other)}</td>
                    <td>{t(KIND_KEY[x.kind])}</td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {dateTime(x.uploaded)}
                      {x.by ? ` · ${x.by}` : ""}
                    </td>
                  </Row>
                )}
              />
            ) : views.length ? (
              <NoMatch onReset={st.reset} />
            ) : null}
          </>
        )}
      </Loaded>
      {menu.dialogs}
    </div>
  );
}

const FILE_SORT: Record<string, (x: FileView) => string | number> = {
  name: (x) => x.name,
  category: (x) => x.category,
  kind: (x) => x.kind,
  uploaded: (x) => x.uploaded,
};

function pickInstallationFiles(onFiles: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,.md,.csv,.json,.pdf";
  input.multiple = true;
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

function PreviewBody({ f, file }: { f: FileView; file: StoredFile }) {
  const { t } = useI18n();
  const href = tenantContentHref(`${contentPath(f.id)}?v=${file.version}`);
  const text = useQuery({
    queryKey: [...KEYS.file(f.id), "content", file.version],
    queryFn: () => apiText(contentPath(f.id)),
    enabled: f.kind === "md" || f.kind === "text" || f.kind === "csv",
  });
  if (f.kind === "image")
    return <img src={href} alt={f.name} className="w-full rounded-lg border bg-background" />;
  if (f.kind === "pdf") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border p-8 text-center">
        <IconTile icon={FileType2} size="lg" />
        <Button asChild variant="outline">
          <a data-testid="kn-files-openPdf" href={href} target="_blank" rel="noreferrer noopener">
            {t("kn.files.openPdf")}
          </a>
        </Button>
      </div>
    );
  }
  if (!text.data)
    return text.isError ? (
      <p className="text-sm text-muted-foreground">{t("kn.files.noPreview")}</p>
    ) : (
      <ListSkeleton />
    );
  if (f.kind === "md")
    return (
      <div className="rounded-xl border p-6">
        <MarkdownDocument text={text.data} underTitle={f.name} />
      </div>
    );
  if (f.kind === "csv") {
    const preview = csvPreview(text.data, 21);
    const [head, ...rows] = preview.rows;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t("kn.files.firstRows", { n: rows.length, total: Math.max(0, preview.total - 1) })}
        </p>
        <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                {head?.map((h) => (
                  <th
                    key={h}
                    className="h-10 px-3 text-left text-xs font-medium text-muted-foreground first:pl-4"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${i}-${r.join()}`} className="border-b last:border-0">
                  {r.map((c, j) => (
                    <td key={`${j}-${c}`} className="h-10 px-3 font-mono text-xs first:pl-4">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return <CodeBlock code={text.data || "—"} lang={f.name.endsWith(".json") ? "json" : "text"} />;
}

export function FilePage({ id }: { id: string }) {
  const query = useQuery({
    queryKey: KEYS.file(id),
    queryFn: () => apiCall("get", "/v1/files/{id}", { path: { id } }),
  });
  if (!query.data && !query.isError) return <ListSkeleton />;
  return (
    <Loaded query={query}>
      {(file) => <FileDetail key={file.id} file={file as StoredFile} />}
    </Loaded>
  );
}

function FileDetail({ file }: { file: StoredFile }) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const session = useSession();
  const refresh = useRefreshKnowledge();
  const rel = useRel();
  const directory = useActorDirectory(true);
  const canWrite = session.permissions.includes("file:write");
  const canDelete = session.permissions.includes("file:delete");
  const installation = useInstallation();
  const f = fileView(file);
  const meta = useMetadataMenu({
    kind: "file",
    id: f.id,
    record: file,
    queryKey: KEYS.file(f.id),
    nameKey: "filename",
  });
  const [del, setDel] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<File | null>(null);
  const usage = useQuery({
    queryKey: [...KEYS.file(f.id), "usage"],
    queryFn: () => apiCall("get", "/v1/files/{id}/usage", { path: { id: f.id } }),
  });
  const versions = useQuery({
    queryKey: [...KEYS.file(f.id), "versions"],
    queryFn: () => apiCall("get", "/v1/files/{id}/versions", { path: { id: f.id } }),
  });
  const uses: Use[] = [
    ...(usage.data?.workflows ?? []).map((w) => ({
      kind: "workflow" as const,
      name: w.name,
      href: workflowHref(w.id),
    })),
    ...(usage.data?.conversations ?? []).map((c) => ({
      kind: "chat" as const,
      name: c.title ?? t("kn.use.chat"),
      href: conversationHref(c.id),
    })),
    ...(usage.data?.other_links ?? []).flatMap((link) => {
      const card = fileOtherLinkCard(link, t);
      return card.href
        ? [{ kind: "other" as const, name: card.title, href: card.href, line: card.line }]
        : [];
    }),
  ];
  const used = usage.data
    ? usage.data.workflows.length + usage.data.conversations.length
    : f.usedBy;
  const after = () => {
    void client.invalidateQueries({ queryKey: KEYS.file(f.id) });
    void refresh();
  };
  const replace = async (next: File) => {
    setReplacing(null);
    try {
      await apiUpload(
        `/v1/files/${encodeURIComponent(f.id)}/replace`,
        {
          filename: next.name,
          content_type: next.type || undefined,
          content_base64: await readBase64(next),
        },
        () => undefined,
      );
      toast.success(t("kn.files.replaced", { name: f.name }));
      after();
    } catch (error) {
      reportFailure(t("common.actionFailed"), error);
    }
  };
  const remove = async () => {
    try {
      await apiCall("delete", "/v1/files/{id}", { path: { id: f.id } });
      toast.success(t("kn.deleted", { name: f.name }));
      void refresh();
      void navigate({ to: "/files" });
    } catch (error) {
      reportFailure(t("common.actionFailed"), error);
    }
  };
  const restore = async (version: string) => {
    try {
      await apiCall("post", "/v1/files/{id}/versions/{version}/restore", {
        path: { id: f.id, version: Number(version) },
      });
      toast.success(t("kn.restored", { n: Number(version) }));
      after();
    } catch (error) {
      reportFailure(t("common.actionFailed"), error);
    }
  };
  const textual = f.kind === "md" || f.kind === "text" || f.kind === "csv";
  const saveCopy = async () => {
    const result = await exportInstallationFile(
      f.name,
      async () => await fetch(cockpitApiHref(contentPath(f.id)), { credentials: "same-origin" }),
    );
    if (result === "unsupported") window.location.assign(tenantContentHref(contentPath(f.id)));
  };
  const download = installation.available ? (
    <button data-testid="kn-files-download" type="button" onClick={() => void saveCopy()}>
      <Download className="size-4" aria-hidden />
      {t("kn.files.download")}
    </button>
  ) : (
    <a
      data-testid="kn-files-download"
      href={tenantContentHref(contentPath(f.id))}
      download={f.name}
    >
      <Download className="size-4" aria-hidden />
      {t("kn.files.download")}
    </a>
  );
  const strip =
    used === 0
      ? t("kn.files.stripUnused", { when: rel(f.uploaded) })
      : plural(t, "kn.files.stripUsed", used, { when: rel(f.uploaded) });
  return (
    <>
      <DetailShell
        back={t("kn.files.title")}
        onBack={() => void navigate({ to: "/files" })}
        icon={<IconTile icon={FILE_ICON[f.kind]} size="lg" />}
        title={f.name}
        sub={<CatalogPurpose record={file} />}
        strip={{ tone: f.ready ? "success" : "info", text: strip }}
        actions={
          <Button asChild variant="outline">
            {download}
          </Button>
        }
        menu={
          <ChatMenu
            label={t("kn.detailMenu")}
            prompts={[t("kn.files.prompt.summarize"), t("kn.files.prompt.analyze")]}
            extra={
              <>
                {canWrite && meta.items}
                {canWrite && (
                  <DropdownMenuItem
                    data-testid="kn-files-replace"
                    onSelect={() => replaceInput.current?.click()}
                    className="flex-col items-start gap-0"
                  >
                    <span className="flex items-center gap-2">
                      <Upload className="size-4" aria-hidden />
                      {t("kn.files.replace")}
                    </span>
                    <span className="pl-6 text-xs text-muted-foreground">
                      {t("kn.files.replaceHint")}
                    </span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>{download}</DropdownMenuItem>
                {canDelete && (
                  <DropdownMenuItem
                    data-testid="kn-files-delete"
                    className="text-destructive-ink"
                    onSelect={() => setDel(true)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {t("kn.delete")}
                  </DropdownMenuItem>
                )}
              </>
            }
          />
        }
        tabs={[
          { id: "preview", label: t("kn.tab.preview"), content: <PreviewBody f={f} file={file} /> },
          { id: "usage", label: t("kn.tab.usage"), content: <UsageList uses={uses} /> },
          ...(versions.data && versions.data.items.length > 1
            ? [
                {
                  id: "versions",
                  label: t("kn.tab.versions"),
                  content: (
                    <VersionsTab
                      versions={versions.data.items.map((v) => ({
                        key: String(v.version),
                        v: v.version,
                        by:
                          (v.uploaded_by &&
                            actorDirectoryName(directory, v.uploaded_by.kind, v.uploaded_by.id)) ||
                          t("kn.someone"),
                        at: v.uploaded_at,
                        current: v.current,
                        note: v.restored_from ? t("kn.restoredFrom", { n: v.restored_from }) : null,
                      }))}
                      canRestore={canWrite}
                      onRestore={(k) => void restore(k)}
                      load={(k) =>
                        textual
                          ? apiText(`/v1/files/${encodeURIComponent(f.id)}/versions/${k}/content`)
                          : Promise.resolve("")
                      }
                    />
                  ),
                },
              ]
            : []),
        ]}
        facts={[
          { label: t("kn.col.kind"), value: t(KIND_KEY[f.kind]) },
          { label: t("kn.files.size"), value: formatBytes(f.size, locale) },
          {
            label: t("kn.col.category"),
            value: humanizeCategory(f.category, t("catalog.categoryOther")),
          },
          ...(file.content_type
            ? [{ label: t("kn.files.format"), value: file.content_type, mono: true }]
            : []),
          ...(file.replaced_at
            ? [{ label: t("kn.files.replacedAt"), value: dateTime(file.replaced_at) }]
            : []),
          { label: t("kn.files.col.uploaded"), value: dateTime(f.uploaded) },
          ...(f.by ? [{ label: t("kn.files.by"), value: f.by }] : []),
          ...(f.checksum ? [{ label: t("kn.files.checksum"), value: f.checksum, mono: true }] : []),
          { label: t("kn.fact.ref"), value: f.reference, mono: true },
          { label: t("kn.fact.id"), value: f.id, mono: true },
        ]}
      />
      <input
        ref={replaceInput}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const next = e.target.files?.[0];
          if (next) setReplacing(next);
          e.target.value = "";
        }}
      />
      <Dialog open={replacing !== null} onOpenChange={(v) => !v && setReplacing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("files.replaceTitle", { name: f.name })}</DialogTitle>
            <DialogDescription>{t("files.replaceLine")}</DialogDescription>
          </DialogHeader>
          {replacing && <LocalPreview file={replacing} />}
          <DialogFooter>
            <Button data-testid="common-cancel" variant="ghost" onClick={() => setReplacing(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="kn-files-replace-confirm"
              onClick={() => replacing && void replace(replacing)}
            >
              {t("files.replace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {canWrite && meta.dialog}
      <ConfirmDelete
        open={del}
        onOpenChange={setDel}
        name={f.name}
        warning={
          used
            ? plural(t, "kn.files.deleteWarn", used, {
                names: [
                  ...(usage.data?.workflows ?? []).map((w) => w.name),
                  ...(usage.data?.conversations ?? []).map((c) => c.title ?? t("kn.use.chat")),
                ].join(", "),
              })
            : undefined
        }
        onConfirm={() => void remove()}
      />
    </>
  );
}
