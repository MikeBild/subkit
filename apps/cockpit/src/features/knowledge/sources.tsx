import { extOf, formatBytes, parseCsv } from "@shared/file-kinds.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconTile } from "@ui/atoms/icon-tile";
import { listPageFailure } from "@ui/lib/errors";
import { cn } from "@ui/lib/utils";
import { DropZone } from "@ui/molecules/drop-zone";
import { DropdownMenuItem } from "@ui/molecules/dropdown-menu";
import { ErrorState, FieldError } from "@ui/molecules/error-notice";
import { PageHeader } from "@ui/molecules/page-header";
import { SegmentedControl } from "@ui/molecules/segmented-control";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { dialogWidthClass } from "@ui/organisms/dialog-frame";
import { MarkdownDocument, CodeBlock as SourceCode } from "@ui/organisms/markdown-document";
import { MarkdownEditor } from "@ui/organisms/markdown-editor";
import {
  ArrowLeft,
  BookOpen,
  Braces,
  ChevronRight,
  File,
  FileText,
  Globe,
  Inbox,
  Layers,
  Link2,
  type LucideIcon,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall, apiMultipart } from "@/api/call";
import { ApiError } from "@/api/client";
import { loadKnowledgeChunks } from "@/api/knowledge";
import { useActorDirectory } from "@/app/actor-directory";
import { absolute, chatNewHref, recordHref } from "@/app/links";
import { useSession } from "@/app/session";
import { CodeBlock } from "@/components/cockpit/patterns/code-block";
import { Button, Input, Label } from "@/components/cockpit/patterns/controls";
import { CopyField } from "@/components/cockpit/patterns/copy-field";
import { usePageFailure } from "@/components/cockpit/patterns/use-error-detail";
import { CatalogPurpose } from "@/features/catalog";
import { urlSourceBody } from "@/features/knowledge/api/knowledge-source-request";
import {
  failedSourceRemedy,
  groupBy,
  MAX_FILE,
  matches,
  SOURCE_EXT,
  SOURCE_TONE,
  type SourceKindView,
  type SourceView,
  sectionTarget,
  sourceView,
} from "@/features/knowledge/model/knowledge";
import {
  type ApiEndpoint,
  matchesEndpoint,
  openApiEndpoints,
  rawPreview,
  refreshFields,
  refreshRhythm,
  type SourceSection,
  sourceKind,
  sourcePrimaryAction,
  sourceSections,
} from "@/features/knowledge/model/knowledge-sources-model";
import {
  authorName,
  versionText,
  versionWhy,
} from "@/features/knowledge/model/knowledge-versions-model";
import { humanizeCategory } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { plural } from "@/lib/plural";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { categoryCounts, createdByMatches, sortRows } from "./list-model";
import { KEYS, useMarkdownRefs, useRefreshKnowledge, useSources } from "./queries";
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
  StatusCell,
  Toolbar,
  UsageList,
  useColumnChoice,
  useListState,
  useMetadataMenu,
  usePageMenu,
  useRel,
  VersionsTab,
} from "./shell";
import { useRecordUses } from "./uses";

type Source = NonNullable<ReturnType<typeof useSources>["data"]>["items"][number];
export const KIND_ICON: Record<SourceKindView, LucideIcon> = {
  url: Globe,
  file: File,
  text: FileText,
  collection: Layers,
  api: Braces,
};
const KIND_KEY = {
  url: "kn.sources.kind.url",
  file: "kn.sources.kind.file",
  text: "kn.sources.kind.text",
  collection: "kn.sources.kind.collection",
  api: "kn.sources.kind.api",
} as const;
const STATUS_KEY = {
  active: "kn.status.active",
  ingesting: "kn.sources.status.ingesting",
  failed: "kn.sources.status.failed",
  off: "kn.status.off",
} as const;
const METHOD: Record<string, string> = {
  GET: "text-success-ink",
  POST: "text-info-ink",
  PATCH: "text-warning-ink",
  PUT: "text-warning-ink",
  DELETE: "text-destructive-ink",
};
const PROMPTS = [
  "kn.sources.prompt.stale",
  "kn.sources.prompt.ask",
  "kn.sources.prompt.summarize",
] as const;
type Rhythm = "never" | "daily" | "weekly";
const RHYTHMS: Rhythm[] = ["never", "daily", "weekly"];

const SOURCE_SORT: Record<string, (x: SourceView) => string | number> = {
  name: (x) => x.name,
  status: (x) => x.status,
  kind: (x) => x.kind,
  sections: (x) => x.sections,
  ingested: (x) => x.ingested,
};
const STARTERS = ["handbook", "product", "faq", "api", "prices"] as const;
const ONBOARD_MODES: [AddMode, LucideIcon][] = [
  ["url", Link2],
  ["file", File],
  ["text", FileText],
];

export function SourcesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const session = useSession();
  const canWrite = session.permissions.includes("knowledge:write");
  const st = useListState();
  const rel = useRel();
  const menu = usePageMenu({ pkg: "knowledge", categories: "knowledge_source", category: st.cat });
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [starter, setStarter] = useState("");
  const query = useSources();
  const views = useMemo(() => (query.data?.items ?? []).map(sourceView), [query.data]);
  const other = t("catalog.categoryOther");
  const items = sortRows(
    views.filter(
      (x) =>
        (st.cat === "all" || x.category === st.cat) &&
        createdByMatches(x.describedBy, st.createdBy) &&
        matches(st.q, x.name, x.url, t(KIND_KEY[x.kind]), x.category),
    ),
    SOURCE_SORT[st.sort.key] ?? null,
    st.sort.order,
  );
  const key =
    st.group === "category"
      ? (x: SourceView) => humanizeCategory(x.category, other)
      : st.group === "status"
        ? (x: SourceView) => t(STATUS_KEY[x.status])
        : st.group === "kind"
          ? (x: SourceView) => t(KIND_KEY[x.kind])
          : null;
  const sections = items.reduce((n, x) => n + x.sections, 0);
  const head: Head[] = [
    { label: t("kn.sources.col.source"), sort: "name" },
    { label: t("kn.col.status"), sort: "status" },
    { label: t("kn.col.kind"), sort: "kind" },
    { label: t("kn.sources.col.size"), sort: "sections", priority: "low" },
    { label: t("kn.sources.col.ingested"), sort: "ingested", priority: "low" },
  ];
  const columns = useColumnChoice(head);
  const add = (mode: AddMode, name = "") => {
    setStarter(name);
    setAdding(mode);
  };
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
      <PageHeader
        title={t("kn.sources.title")}
        lead={t("kn.sources.lead")}
        actions={
          <div className="flex items-center gap-2">
            <ChatMenu items={menu.items} prompts={PROMPTS.map((k) => t(k))} />
            {canWrite && (
              <Button data-testid="kn-sources-add" onClick={() => add("url")}>
                <Plus className="size-4" aria-hidden />
                {t("kn.sources.add")}
              </Button>
            )}
          </div>
        }
      />
      {query.data && views.length === 0 && (
        <OnboardingCard
          icon={BookOpen}
          title={t("kn.sources.onboardTitle")}
          text={t("kn.sources.onboardText")}
        >
          {canWrite &&
            ONBOARD_MODES.map(([mode, Icon]) => (
              <Button
                key={mode}
                data-testid={`kn-sources-kind-${mode}`}
                size="sm"
                variant="outline"
                onClick={() => add(mode)}
              >
                <Icon className="size-4" aria-hidden />
                {t(KIND_KEY[mode])}
              </Button>
            ))}
          {canWrite && (
            <div className="flex basis-full flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("knowledge.onboarding.starters")}
              </span>
              {STARTERS.map((k) => (
                <Button
                  key={k}
                  data-testid={`kn-sources-starter-${k}`}
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => add("text", t(`knowledge.onboarding.starter.${k}`))}
                >
                  {t(`knowledge.onboarding.starter.${k}`)}
                </Button>
              ))}
            </div>
          )}
          <Button
            data-testid="kn-inbox-title"
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/intake" })}
          >
            <Inbox className="size-4" aria-hidden />
            {t("kn.inbox.title")}
          </Button>
        </OnboardingCard>
      )}
      <Loaded query={query}>
        {() => (
          <>
            <Toolbar
              st={st}
              groups={["category", "status", "kind"]}
              categories={categoryCounts(views)}
              createdBy
              columns={columns}
            />
            <ListSummary
              testId="kn-sources-summary"
              kind="knowledge_source"
              parts={[
                plural(t, "kn.sources.count", items.length, {
                  sections: plural(t, "kn.sources.sections", sections),
                }),
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
                    onOpen={() => void navigate({ to: recordHref("knowledge", x.id) })}
                    label={x.name}
                  >
                    <td>
                      <NameCell
                        icon={<IconTile icon={KIND_ICON[x.kind]} size="sm" />}
                        title={x.name}
                        sub={x.url ?? humanizeCategory(x.category, other)}
                      />
                    </td>
                    <td>
                      <StatusCell tone={SOURCE_TONE[x.status]} label={t(STATUS_KEY[x.status])} />
                    </td>
                    <td>{t(KIND_KEY[x.kind])}</td>
                    <td className="whitespace-nowrap">
                      {x.status === "ingesting"
                        ? "—"
                        : plural(t, "kn.sources.sections", x.sections)}
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{rel(x.ingested)}</td>
                  </Row>
                )}
              />
            ) : views.length ? (
              <NoMatch onReset={st.reset} />
            ) : null}
          </>
        )}
      </Loaded>
      {canWrite && (
        <AddSourceDialog
          open={adding !== null}
          initialMode={adding ?? "url"}
          initialName={starter}
          onOpenChange={(v) => !v && setAdding(null)}
        />
      )}
      {menu.dialogs}
    </div>
  );
}

function RhythmChips({ value, onChange }: { value: Rhythm | null; onChange: (r: Rhythm) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="m-0 min-w-0">
      <legend className="text-sm font-medium">{t("kn.sources.schedule")}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {RHYTHMS.map((x) => (
          <Button
            data-testid="kn-sources-rhythm"
            key={x}
            type="button"
            size="sm"
            variant={value === x ? "secondary" : "outline"}
            aria-pressed={value === x}
            className="rounded-full"
            onClick={() => onChange(x)}
          >
            {t(`kn.sources.rhythm.${x}`)}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

type AddMode = "url" | "file" | "text";
const URL_OK = /^https?:\/\/\S+\.\S+/;

function AddSourceDialog({
  open,
  initialMode = "url",
  initialName = "",
  onOpenChange,
}: {
  open: boolean;
  initialMode?: AddMode;
  initialName?: string;
  onOpenChange: (v: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const refresh = useRefreshKnowledge();
  const refs = useMarkdownRefs();
  const [mode, setMode] = useState<AddMode>("url");
  const [url, setUrl] = useState("https://");
  const [rhythm, setRhythm] = useState<Rhythm>("weekly");
  const [file, setFile] = useState<{ file: File; text: string | null } | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState("");
  const reset = (start: AddMode = initialMode) => {
    setMode(start);
    setUrl("https://");
    setRhythm("weekly");
    setFile(null);
    setFileErr("");
    setName(initialName);
    setText("");
    setTried(false);
    setProblem("");
  };
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) reset();
  }
  const urlOk = URL_OK.test(url.trim());
  const create = useMutation({
    mutationFn: async (): Promise<Source> => {
      if (mode === "url")
        return apiCall("post", "/v1/knowledge-sources/url", { body: urlSourceBody(url, rhythm) });
      if (mode === "text")
        return apiCall("post", "/v1/knowledge-sources/inline", {
          body: { name: name.trim(), content: text, mime_type: "text/markdown" },
        });
      const f = file?.file as File;
      return apiMultipart("/v1/knowledge-sources", {
        body: { file: f, metadata: JSON.stringify({ name: f.name }) },
      });
    },
    onSuccess: (source) => {
      toast.success(t("kn.sources.added", { name: source.name }));
      void refresh();
      onOpenChange(false);
      void navigate({ to: recordHref("knowledge", source.id) });
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 422
          ? t("kn.sources.unreadable")
          : error instanceof ApiError && error.status === 413
            ? t("kn.up.tooBig", { name: file?.file.name ?? "" })
            : t("common.actionFailed"),
      ),
  });
  const submit = () => {
    setTried(true);
    setProblem("");
    if (mode === "url" && !urlOk) return;
    if (mode === "file" && !file) return;
    if (mode === "text" && (!name.trim() || !text.trim())) return;
    create.mutate();
  };
  const pickFile = async (fl: FileList | readonly File[]) => {
    const f = fl[0];
    if (!f) return;
    if (!SOURCE_EXT.includes(extOf(f.name))) {
      setFile(null);
      setFileErr(t("kn.sources.unsupported", { name: f.name }));
      return;
    }
    if (f.size > MAX_FILE) {
      setFile(null);
      setFileErr(t("kn.up.tooBig", { name: f.name }));
      return;
    }
    setFileErr("");
    setFile({
      file: f,
      text: ["md", "txt", "csv", "json", "html"].includes(extOf(f.name)) ? await f.text() : null,
    });
  };
  const MODES: readonly AddMode[] = ["url", "file", "text"];
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className={cn(mode === "text" && dialogWidthClass("document"))}>
        <DialogHeader>
          <DialogTitle>{t("kn.sources.add")}</DialogTitle>
          <DialogDescription>{t(`kn.sources.hint.${mode}`)}</DialogDescription>
        </DialogHeader>
        <SegmentedControl
          label={t("kn.sources.add")}
          value={mode}
          onValueChange={(next) => {
            const chosen = MODES.find((x) => x === next);
            if (!chosen) return;
            setMode(chosen);
            setTried(false);
          }}
          testId="kn-sources-mode"
          options={MODES.map((x) => ({
            value: x,
            label: t(`kn.sources.mode.${x}`),
            testId: `kn-sources-mode-${x}`,
          }))}
        />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {mode === "url" && (
            <>
              <div>
                <Label htmlFor="src-url">{t("kn.sources.address")}</Label>
                <Input
                  data-testid="src-url"
                  id="src-url"
                  className="mt-2 font-mono"
                  value={url}
                  aria-invalid={(tried && !urlOk) || undefined}
                  onChange={(e) => setUrl(e.target.value)}
                />
                {tried && !urlOk && <FieldError>{t("kn.sources.errUrl")}</FieldError>}
              </div>
              <RhythmChips value={rhythm} onChange={setRhythm} />
            </>
          )}
          {mode === "file" && (
            <>
              {!file ? (
                <DropZone
                  title={t("kn.sources.dropFile")}
                  hint={`${t("kn.sources.orPick")} · ${SOURCE_EXT.map((x) => `.${x}`).join(" ")}`}
                  accept={SOURCE_EXT.map((x) => `.${x}`).join(",")}
                  onFiles={(f) => void pickFile(f)}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3 rounded-lg border p-3">
                    <IconTile icon={File} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{file.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(file.file.size, locale)}
                      </p>
                    </div>
                    <Button
                      data-testid="kn-sources-other"
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setFile(null)}
                    >
                      {t("kn.sources.other")}
                    </Button>
                  </div>
                  <div className="rounded-lg border p-4">
                    <FilePreview name={file.file.name} text={file.text} />
                  </div>
                </div>
              )}
              {fileErr && <FieldError>{fileErr}</FieldError>}
              {tried && !file && !fileErr && <FieldError>{t("kn.sources.dropFile")}</FieldError>}
            </>
          )}
          {mode === "text" && (
            <>
              <div>
                <Label htmlFor="src-name">{t("kn.name")}</Label>
                <Input
                  data-testid="src-name"
                  id="src-name"
                  className="mt-2"
                  placeholder={t("kn.sources.namePh")}
                  value={name}
                  aria-invalid={(tried && !name.trim()) || undefined}
                  onChange={(e) => setName(e.target.value)}
                />
                {tried && !name.trim() && <FieldError>{t("kn.sources.errName")}</FieldError>}
              </div>
              <div>
                <Label htmlFor="src-text" className="mb-2 block">
                  {t("kn.content")}
                </Label>
                <MarkdownEditor
                  id="src-text"
                  value={text}
                  onChange={setText}
                  invalid={tried && !text.trim()}
                  refs={refs}
                />
                {tried && !text.trim() && <FieldError>{t("kn.sources.errText")}</FieldError>}
              </div>
            </>
          )}
          {problem && <FieldError>{problem}</FieldError>}
          <DialogFooter>
            <Button
              data-testid="common-cancel"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-add" type="submit" disabled={create.isPending}>
              {t("kn.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FilePreview({ name, text }: { name: string; text: string | null }) {
  const { t } = useI18n();
  const e = extOf(name);
  if (text === null)
    return <p className="text-sm text-muted-foreground">{t("kn.sources.noPreview")}</p>;
  if (e === "md")
    return <MarkdownDocument text={text.slice(0, 4000)} toolbar={false} toc={false} compact />;
  if (e === "csv") {
    const rows = parseCsv(text, 6);
    return (
      <div className="md-doc">
        <div className="md-table">
          <table>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${i}-${r.join()}`}>
                  {r.map((c, j) =>
                    i === 0 ? <th key={`${j}-${c}`}>{c}</th> : <td key={`${j}-${c}`}>{c}</td>,
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return (
    <SourceCode
      code={text.split("\n").slice(0, 12).join("\n")}
      lang={e === "html" ? "xml" : e === "json" ? "json" : "text"}
    />
  );
}

export function SourcePage({ id }: { id: string }) {
  const query = useQuery({
    queryKey: KEYS.source(id),
    queryFn: () => apiCall("get", "/v1/knowledge-sources/{id}", { path: { id } }),
    refetchInterval: (q) => (q.state.data?.status === "processing" ? 2000 : false),
  });
  if (!query.data && !query.isError) return <ListSkeleton />;
  return <Loaded query={query}>{(src) => <SourceDetail key={src.id} src={src} />}</Loaded>;
}

function BackTo({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      data-testid="kn-sources-back"
      variant="ghost"
      size="sm"
      className="-ml-3 self-start"
      onClick={onClick}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {label}
    </Button>
  );
}

function RawText({ text, label }: { text: string; label: string }) {
  return <CodeBlock fit code={text} label={label} testId="knowledge-raw" />;
}

function EndpointDetail({ endpoint, onBack }: { endpoint: ApiEndpoint; onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4" data-testid="knowledge-endpoint">
      <BackTo label={t("kn.sources.allEndpoints")} onClick={onBack} />
      <p className="flex flex-wrap items-baseline gap-3">
        <span className={cn("font-mono text-xs font-semibold", METHOD[endpoint.method])}>
          {endpoint.method}
        </span>
        <span className="break-all font-mono text-sm">{endpoint.path}</span>
      </p>
      {endpoint.purpose && <p className="text-sm text-muted-foreground">{endpoint.purpose}</p>}
      <RawText
        text={JSON.stringify(endpoint.operation, null, 2)}
        label={t("knowledge.raw.label")}
      />
    </div>
  );
}

function Endpoints({
  endpoints,
  onOpen,
}: {
  endpoints: ApiEndpoint[];
  onOpen: (key: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const list = endpoints.filter((e) => matchesEndpoint(e, q));
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          data-testid="kn-sources-endpointSearch"
          aria-label={t("kn.sources.endpointSearch")}
          placeholder={t("kn.sources.endpointSearch")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t("kn.sources.endpointsOf", { n: list.length, total: endpoints.length })}
      </p>
      {list.length ? (
        <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                {[
                  t("kn.sources.ep.method"),
                  t("kn.sources.ep.path"),
                  t("kn.sources.ep.purpose"),
                ].map((h) => (
                  <th
                    key={h}
                    className="h-10 px-3 text-left text-xs font-medium text-muted-foreground first:pl-4 last:pr-4"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <Row
                  key={e.key}
                  testId="kn-sources-endpoint"
                  label={`${e.method} ${e.path}`}
                  onOpen={() => onOpen(e.key)}
                >
                  <td className={cn("w-24 font-mono text-xs font-semibold", METHOD[e.method])}>
                    {e.method}
                  </td>
                  <td className="font-mono text-xs">{e.path}</td>
                  <td className="text-muted-foreground">{e.purpose}</td>
                </Row>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <NoMatch />
      )}
    </div>
  );
}

function Sections({
  sections,
  onOpen,
}: {
  sections: SourceSection[];
  onOpen: (key: string) => void;
}) {
  return (
    <ol className="divide-y rounded-xl border">
      {sections.map((x, i) => (
        <li key={x.key}>
          <button
            data-testid="kn-sources-section"
            type="button"
            onClick={() => onOpen(x.key)}
            className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/40"
          >
            <span className="w-6 font-mono text-xs text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex-1 font-medium">{x.title}</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </button>
        </li>
      ))}
    </ol>
  );
}

function SourceContent({ src }: { src: Source }) {
  const { t } = useI18n();
  const [picked, setPicked] = useSearchParamState("section", "");
  const [raw, setRaw] = useState(false);
  const chunks = useQuery({
    queryKey: [...KEYS.source(src.id), "chunks", src.version],
    queryFn: () => loadKnowledgeChunks(src.id),
    enabled: src.status !== "processing",
  });
  const sections = useMemo(() => sourceSections(chunks.data?.items ?? []), [chunks.data]);
  const contents = useMemo(() => sections.map((s) => s.content), [sections]);
  const endpoints = useMemo(() => openApiEndpoints(contents) ?? [], [contents]);
  const rawText = useMemo(() => rawPreview(contents), [contents]);
  if (src.status === "processing" || (!chunks.data && !chunks.isError)) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="size-4 animate-spin" aria-hidden />
        {t("kn.sources.noSections")}
      </p>
    );
  }
  if (!sections.length)
    return <p className="text-sm text-muted-foreground">{t("kn.sources.empty")}</p>;
  const open = sectionTarget(picked, endpoints, sections);
  const close = () => setPicked("");
  if (open?.kind === "endpoint") return <EndpointDetail endpoint={open.endpoint} onBack={close} />;
  const only = sections.length === 1 ? sections[0] : undefined;
  const section = open?.kind === "section" ? open.section : only;
  return (
    <div className="flex flex-col gap-4">
      <Button
        data-testid="kn-sources-raw"
        variant="ghost"
        size="sm"
        className="-ml-3 self-start"
        aria-pressed={raw}
        onClick={() => setRaw((v) => !v)}
      >
        <Braces className="size-4" aria-hidden />
        {t("knowledge.raw.label")}
      </Button>
      {raw ? (
        <RawText
          text={rawText.text}
          label={t(rawText.truncated ? "knowledge.raw.truncated" : "knowledge.raw.label")}
        />
      ) : endpoints.length ? (
        <Endpoints endpoints={endpoints} onOpen={setPicked} />
      ) : section ? (
        <>
          {sections.length > 1 && <BackTo label={t("kn.sources.allSections")} onClick={close} />}
          <div className="rounded-xl border p-6" data-testid="knowledge-section">
            <MarkdownDocument text={section.content} underTitle={section.title} />
          </div>
        </>
      ) : (
        <Sections sections={sections} onOpen={setPicked} />
      )}
    </div>
  );
}

function SourceDetail({ src }: { src: Source }) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const session = useSession();
  const refreshAll = useRefreshKnowledge();
  const rel = useRel();
  const directory = useActorDirectory(true);
  const canWrite = session.permissions.includes("knowledge:write");
  const canDelete = session.permissions.includes("knowledge:delete");
  const v = sourceView(src);
  const meta = useMetadataMenu({
    kind: "knowledge_source",
    id: src.id,
    record: src,
    queryKey: KEYS.source(src.id),
  });
  const [addr, setAddr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [del, setDel] = useState(false);
  const fail = (error: unknown) => reportFailure(t("common.actionFailed"), error);
  const saved = (next: Source) => {
    client.setQueryData(KEYS.source(src.id), next);
    void refreshAll();
  };
  const ingest = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/knowledge-sources/{id}/refresh", { path: { id: src.id } }),
    onSuccess: (n) => {
      toast.success(t("kn.sources.ingestStarted", { name: src.name }));
      saved(n);
    },
    onError: fail,
  });
  const on = v.status !== "off";
  const toggle = useMutation({
    mutationFn: () =>
      apiCall("patch", "/v1/knowledge-sources/{id}", {
        path: { id: src.id },
        body: { status: on ? "inactive" : "active" },
      }),
    onSuccess: (n) => {
      toast.success(t(on ? "kn.turnedOff" : "kn.turnedOn", { name: src.name }));
      saved(n);
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/knowledge-sources/{id}", { path: { id: src.id } }),
    onSuccess: () => {
      toast.success(t("kn.deleted", { name: src.name }));
      void refreshAll();
      void navigate({ to: "/knowledge" });
    },
    onError: fail,
  });
  const history = useQuery({
    queryKey: [...KEYS.source(src.id), "history"],
    queryFn: () =>
      apiCall("get", "/v1/knowledge-sources/{id}/history", {
        path: { id: src.id },
        query: { limit: 50 },
      }),
  });
  const restore = useMutation({
    mutationFn: (version: number) =>
      apiCall("post", "/v1/knowledge-sources/{id}/restore/{version}", {
        path: { id: src.id, version },
      }),
    onSuccess: (_r, version) => {
      toast.success(t("kn.restored", { n: version }));
      void client.invalidateQueries({ queryKey: KEYS.source(src.id) });
    },
    onError: fail,
  });
  const uses = useRecordUses({
    binding: { scope: src.scope, workflowId: src.workflow_id },
    target: { kind: "knowledge", id: src.id },
  });
  const editable = v.kind === "url";
  const remedy = failedSourceRemedy(sourcePrimaryAction(sourceKind(src.source_type)), {
    write: canWrite,
    chat: session.permissions.includes("conversation:write"),
  });
  const stripText =
    v.status === "active"
      ? t("kn.sources.stripActive", { when: rel(v.ingested) })
      : v.status === "failed" && v.error
        ? `${t(STATUS_KEY.failed)} · ${v.error}`
        : t(STATUS_KEY[v.status]);
  const versions = (history.data?.items ?? []).map((h) => ({
    key: String(h.version),
    v: h.version,
    by: authorName(h.author, directory, t),
    at: h.created_at,
    current: h.current,
    note: versionWhy(h.note, directory, t),
  }));
  return (
    <>
      <DetailShell
        back={t("kn.sources.title")}
        onBack={() => void navigate({ to: "/knowledge" })}
        icon={<IconTile icon={KIND_ICON[v.kind]} size="lg" />}
        title={src.name}
        sub={<CatalogPurpose record={src} />}
        strip={{
          tone: SOURCE_TONE[v.status],
          text: stripText,
          ...(v.status === "failed" && remedy === "retry"
            ? {
                action: (
                  <Button
                    data-testid="kn-retry"
                    size="sm"
                    variant="outline"
                    onClick={() => ingest.mutate()}
                  >
                    {t("kn.retry")}
                  </Button>
                ),
              }
            : v.status === "failed" && remedy === "chat"
              ? {
                  action: (
                    <Button asChild size="sm" variant="outline">
                      <a
                        data-testid="knowledge-error-chat"
                        href={absolute(
                          chatNewHref({
                            prompt: t("knowledge.errorPrompt", { name: src.name }),
                            references: [{ type: "knowledge_source", id: src.id }],
                          }),
                        )}
                      >
                        {t("remedy.chat")}
                      </a>
                    </Button>
                  ),
                }
              : v.status === "off" && canWrite
                ? {
                    action: (
                      <Button
                        data-testid="kn-sources-activate"
                        size="sm"
                        variant="outline"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate()}
                      >
                        {t("kn.turnOn")}
                      </Button>
                    ),
                  }
                : {}),
        }}
        actions={
          editable && canWrite ? (
            <Button
              data-testid="kn-sources-ingestNow"
              variant="outline"
              disabled={v.status === "ingesting" || !on || ingest.isPending}
              onClick={() => ingest.mutate()}
            >
              <RefreshCw
                className={cn("size-4", v.status === "ingesting" && "animate-spin")}
                aria-hidden
              />
              {t("kn.sources.ingestNow")}
            </Button>
          ) : undefined
        }
        menu={
          <ChatMenu
            label={t("kn.detailMenu")}
            references={[{ type: "knowledge_source", id: src.id }]}
            prompts={[t("kn.editInChat"), t("kn.sources.prompt.ask")]}
            extra={
              canWrite || canDelete ? (
                <>
                  {canWrite && meta.items}
                  {canWrite && editable && (
                    <DropdownMenuItem
                      data-testid="kn-sources-addressSchedule"
                      onSelect={() => setAddr(true)}
                    >
                      <Link2 className="size-4" aria-hidden />
                      {t("kn.sources.addressSchedule")}
                    </DropdownMenuItem>
                  )}
                  {canWrite && v.kind === "text" && (
                    <DropdownMenuItem
                      data-testid="kn-sources-editText"
                      onSelect={() => setEditing(true)}
                    >
                      <Pencil className="size-4" aria-hidden />
                      {t("kn.sources.editText")}
                    </DropdownMenuItem>
                  )}
                  {canWrite && (
                    <DropdownMenuItem
                      data-testid="kn-sources-toggle"
                      onSelect={() => toggle.mutate()}
                    >
                      <Power className="size-4" aria-hidden />
                      {t(on ? "kn.turnOff" : "kn.turnOn")}
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <DropdownMenuItem
                      data-testid="kn-sources-delete"
                      className="text-destructive-ink"
                      onSelect={() => setDel(true)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {t("kn.delete")}
                    </DropdownMenuItem>
                  )}
                </>
              ) : undefined
            }
          />
        }
        tabs={[
          { id: "content", label: t("kn.tab.content"), content: <SourceContent src={src} /> },
          {
            id: "usage",
            label: t("kn.tab.usage"),
            content: <UsageList uses={uses} empty={t("kn.sources.usedEverywhere")} />,
          },
          {
            id: "versions",
            label: t("kn.tab.versions"),
            content: (
              <VersionsTab
                versions={versions}
                busy={restore.isPending}
                canRestore={canWrite}
                onRestore={(k) => restore.mutate(Number(k))}
                load={async (k) =>
                  versionText(
                    (
                      await apiCall("get", "/v1/knowledge-sources/{id}/history/{version}", {
                        path: { id: src.id, version: Number(k) },
                      })
                    ).documents,
                  )
                }
              />
            ),
          },
        ]}
        facts={[
          { label: t("kn.fact.ref"), value: `@source:${src.slug}`, mono: true },
          ...(v.url
            ? [
                {
                  label: t("kn.fact.address"),
                  value: <CopyField value={v.url} label={t("kn.fact.address")} />,
                },
              ]
            : []),
          { label: t("kn.col.kind"), value: t(KIND_KEY[v.kind]) },
          {
            label: t("kn.sources.col.size"),
            value: [
              plural(t, "kn.sources.sections", v.sections),
              typeof src.bytes_total === "number" ? formatBytes(src.bytes_total, locale) : null,
            ]
              .filter(Boolean)
              .join(" · "),
          },
          ...(src.mime_type
            ? [{ label: t("kn.files.format"), value: src.mime_type, mono: true }]
            : []),
          { label: t("kn.fact.version"), value: `v${src.version}` },
          {
            label: t("kn.col.category"),
            value: humanizeCategory(src.category, t("catalog.categoryOther")),
          },
          { label: t("kn.fact.created"), value: dateTime(src.created_at) },
          { label: t("kn.fact.id"), value: src.id, mono: true },
        ]}
      />
      {editable && <AddressDialog open={addr} onOpenChange={setAddr} src={src} onSaved={saved} />}
      {v.kind === "text" && <TextDialog open={editing} onOpenChange={setEditing} src={src} />}
      {canWrite && meta.dialog}
      <ConfirmDelete
        open={del}
        onOpenChange={setDel}
        name={src.name}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function AddressDialog({
  open,
  onOpenChange,
  src,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  src: Source;
  onSaved: (s: Source) => void;
}) {
  const { t } = useI18n();
  const saved = refreshRhythm(src.refresh_strategy, src.refresh_cron);
  const [url, setUrl] = useState(src.source_uri);
  const [rhythm, setRhythm] = useState<Rhythm | null>(saved === "custom" ? null : saved);
  const save = useMutation({
    mutationFn: () =>
      apiCall("patch", "/v1/knowledge-sources/{id}", {
        path: { id: src.id },
        body: {
          ...(rhythm !== null && rhythm !== saved ? refreshFields(rhythm) : {}),
          ...(url.trim() !== src.source_uri ? { source_uri: url.trim() } : {}),
        },
      }),
    onSuccess: (n) => {
      toast.success(t("kn.sources.savedAddress", { name: src.name }));
      onSaved(n);
      onOpenChange(false);
    },
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
  const ok = URL_OK.test(url.trim());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("kn.sources.addressSchedule")}</DialogTitle>
          <DialogDescription>{t("kn.sources.hint.url")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <div>
            <Label htmlFor="src-url-edit">{t("kn.sources.address")}</Label>
            <Input
              data-testid="src-url-edit"
              id="src-url-edit"
              className="mt-2 font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {!ok && <FieldError>{t("kn.sources.errUrl")}</FieldError>}
          </div>
          <RhythmChips value={rhythm} onChange={setRhythm} />
          {rhythm === null && src.refresh_cron && (
            <p className="text-sm text-muted-foreground" data-testid="kn-sources-custom-cron">
              {t("kn.sources.customRhythm")} <span className="font-mono">{src.refresh_cron}</span>
            </p>
          )}
          <DialogFooter>
            <Button
              data-testid="common-cancel-2"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-save" type="submit" disabled={!ok || save.isPending}>
              {t("kn.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TextDialog({
  open,
  onOpenChange,
  src,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  src: Source;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const refs = useMarkdownRefs();
  const content = useQuery({
    queryKey: [...KEYS.source(src.id), "content"],
    queryFn: () => apiCall("get", "/v1/knowledge-sources/{id}/content", { path: { id: src.id } }),
    enabled: open,
  });
  const doc =
    content.data?.editable && content.data.documents.length === 1
      ? content.data.documents[0]
      : undefined;
  const [body, setBody] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const value = body ?? doc?.content ?? "";
  const save = useMutation({
    mutationFn: async () => {
      if (!doc || !content.data) return;
      await apiCall("put", "/v1/knowledge-sources/{id}/content", {
        path: { id: src.id },
        body: {
          expected_version: content.data.version,
          path: doc.path,
          content: value,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
    },
    onSuccess: () => {
      toast.success(t("kn.savedVersion", { name: src.name }));
      void client.invalidateQueries({ queryKey: KEYS.source(src.id) });
      setBody(null);
      setNote("");
      onOpenChange(false);
    },
    onError: (error) =>
      reportFailure(
        error instanceof ApiError && error.status === 409
          ? t("kn.conflict")
          : t("common.actionFailed"),
        error,
      ),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setBody(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className={dialogWidthClass("document")}>
        <DialogHeader>
          <DialogTitle>{t("kn.sources.editText")}</DialogTitle>
          <DialogDescription>{src.name}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {doc ? (
            <MarkdownEditor id="src-body" value={value} onChange={setBody} refs={refs} />
          ) : (
            <ListSkeleton />
          )}
          <div>
            <Label htmlFor="src-note">{t("kn.sources.why")}</Label>
            <Input
              data-testid="src-note"
              id="src-note"
              className="mt-2"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              data-testid="common-cancel-3"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-save-2" type="submit" disabled={!doc || save.isPending}>
              {t("kn.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
