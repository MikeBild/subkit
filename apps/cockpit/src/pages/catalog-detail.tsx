import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest, apiText } from "@/api/client";
import { navigationItem } from "@/app/navigation";
import { ConnectorPage } from "@/components/cockpit/connector-page";
import { DetailAction } from "@/components/cockpit/detail-action";
import { MarkdownWorkspace } from "@/components/cockpit/markdown-workspace";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import { BackLink, PageHeader } from "@/components/cockpit/patterns";
import { bytes, MISSING } from "@/components/cockpit/table-columns";
import { WorkflowPage } from "@/components/cockpit/workflow-page";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type DetailEntry,
  detailEntries,
  recordBarFacts,
  SCOPE_KEYS,
  SIDE_EFFECT_KEYS,
} from "@/lib/detail-fields";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { returnedFromSignIn, withoutSignInReturn } from "@/pages/connector-detail-model";

type DetailResource = "workflows" | "connectors" | "knowledge" | "skills" | "files";
type RecordValue = Record<string, unknown>;

const ENDPOINTS: Record<DetailResource, string> = {
  workflows: "/v1/workflows",
  connectors: "/v1/connectors",
  knowledge: "/v1/knowledge-sources",
  skills: "/v1/skills",
  files: "/v1/files",
};

const PERMISSIONS: Record<DetailResource, { read: string; write: string }> = {
  workflows: { read: "workflow:read", write: "workflow:write" },
  connectors: { read: "connector:read", write: "connector:write" },
  knowledge: { read: "knowledge:read", write: "knowledge:write" },
  skills: { read: "skill:read", write: "skill:write" },
  files: { read: "file:read", write: "file:write" },
};

/** What this record is FOR, as its author wrote it. Never a slug and never an
 *  id: a fallback that prints an identifier answers a different question than
 *  the one the reader asked. */
export function recordPurpose(record: RecordValue | undefined): string | null {
  const value = record?.description;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function recordTitle(record: RecordValue | undefined): string {
  for (const key of ["name", "display_name", "title", "filename", "slug"]) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "—";
}

/**
 * One curated field as the reader sees it.
 *
 * The value goes through the same helpers the list cells use — a state word
 * through `statusLabel`, a byte count through `bytes`, a timestamp through the
 * locale's own formatter. Passing `String(value)` straight through is how a
 * raw ISO instant and a bare `true` ended up on the page beside labels nobody
 * had chosen either.
 */
function renderDetailValue(
  entry: DetailEntry,
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
): string {
  const { value, format } = entry;
  if (value === null || value === undefined || value === "") return MISSING;
  switch (format) {
    case "date":
      return typeof value === "string" ? dateTime(value) : MISSING;
    case "boolean":
      return t(value === true ? "common.yes" : "common.no");
    case "status":
      return typeof value === "string" ? statusLabel(t, value) : MISSING;
    case "bytes":
      return bytes(value);
    case "scope": {
      const key = typeof value === "string" ? SCOPE_KEYS[value] : undefined;
      return key ? t(key) : String(value);
    }
    case "sideEffects": {
      const key = typeof value === "string" ? SIDE_EFFECT_KEYS[value] : undefined;
      return key ? t(key) : String(value);
    }
    case "maturity":
      return t(
        value === "experimental" ? "catalog.maturity.experimental" : "catalog.maturity.stable",
      );
    default:
      return String(value);
  }
}

/**
 * The row under a record's title: what is a state of this record, and that
 * the reader may only look. No label, no icon, no sentence about where things
 * are edited — and with nothing to say, no row.
 *
 * A connector's states have their own homes — the sign-in in the sign-in
 * card, switched off in the state notice — so its row carries the engine's
 * health verdict only when that is neither ok nor the sign-in again. Every
 * other record carries its lifecycle word and its version, when it has them
 * (`recordBarFacts`). A workflow has no row: its version and whether it may
 * run stand in its automation panel (`workflow-page.tsx`).
 */
function RecordBar({ record, canWrite }: { record: RecordValue; canWrite: boolean }) {
  const { t } = useI18n();
  const { status, version } = recordBarFacts(record);
  if (status === null && version === null && canWrite) return null;
  return (
    <div
      data-family-slot="detail-context"
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs"
      data-testid="detail-record-bar"
    >
      {status !== null ? (
        <Badge variant="outline" data-testid="detail-record-status">
          {statusLabel(t, status)}
        </Badge>
      ) : null}
      {version !== null ? (
        <Badge variant="secondary" data-testid="detail-record-version">
          v{version}
        </Badge>
      ) : null}
      {canWrite ? null : (
        <span className="text-muted-foreground" data-testid="detail-read-only">
          {t("detail.readOnly")}
        </span>
      )}
    </div>
  );
}

function Overview({ record }: { record: RecordValue }) {
  const { t, dateTime } = useI18n();
  const entries = detailEntries(record);
  // A record with nothing curated to show draws no frame. An empty grid is not
  // a state, it is a leftover.
  if (entries.length === 0) return null;
  return (
    <dl
      className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-3"
      data-testid="detail-overview"
    >
      {entries.map((entry) => (
        <div key={entry.key} className="min-w-0 bg-background p-4">
          <dt className="text-xs text-muted-foreground">{t(entry.labelKey)}</dt>
          <dd className="mt-1 truncate text-sm font-medium">
            {renderDetailValue(entry, t, dateTime)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SkillBody({
  id,
  record,
  canWrite,
}: {
  id: string;
  record: RecordValue;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const initial = typeof record.body === "string" ? record.body : "";
  const [body, setBody] = useState(initial);
  useEffect(() => setBody(initial), [initial]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest<RecordValue>(`/v1/skills/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ body, expected_version: record.version }),
      }),
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["catalog-detail", "skills", id] });
    },
  });
  return (
    <MarkdownWorkspace
      value={body}
      onChange={setBody}
      onSave={() => save.mutate()}
      saving={save.isPending}
      dirty={body !== initial}
      readOnly={!canWrite}
      label={recordTitle(record)}
    />
  );
}

interface KnowledgeContent {
  knowledge_source_id: string;
  version: string;
  editable: boolean;
  documents: { path: string; content: string }[];
}

function KnowledgeBody({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const content = useQuery({
    queryKey: ["knowledge-content", id],
    queryFn: () =>
      apiRequest<KnowledgeContent>(`/v1/knowledge-sources/${encodeURIComponent(id)}/content`),
  });
  const [documentIndex, setDocumentIndex] = useState(0);
  // The optional chain used to stop after `.data?`, so an answer without a
  // `documents` array did not render a failure — it threw, and the router's
  // catch-all replaced the whole cockpit. A guard that covers the first half of
  // a path is not a guard.
  const documents = Array.isArray(content.data?.documents) ? content.data.documents : [];
  const document = documents[documentIndex];
  const [value, setValue] = useState("");
  useEffect(() => setValue(document?.content ?? ""), [document]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest<KnowledgeContent>(`/v1/knowledge-sources/${encodeURIComponent(id)}/content`, {
        method: "PUT",
        body: JSON.stringify({
          expected_version: content.data?.version,
          path: document?.path,
          content: value,
        }),
      }),
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["knowledge-content", id] });
    },
  });
  if (content.isPending) return <Skeleton className="h-96 w-full" />;
  // Two different facts, and the page used to answer both with a one-cell
  // table reading "editable false". A source that could not be read is an
  // error with a way out (§4); a source that carries no document yet is an
  // empty state and says so.
  if (content.error)
    return (
      <Alert variant="destructive" data-testid="knowledge-load-failed">
        <AlertTitle>{t("knowledge.contentFailed")}</AlertTitle>
        <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          data-testid="knowledge-content-retry"
          onClick={() => void content.refetch()}
        >
          {t("session.retry")}
        </Button>
      </Alert>
    );
  if (!document)
    return (
      <Alert data-testid="knowledge-empty">
        <AlertTitle>{t("knowledge.noDocuments")}</AlertTitle>
        <AlertDescription>{t("knowledge.noDocumentsDescription")}</AlertDescription>
      </Alert>
    );
  return (
    <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-xl border">
      {documents.length > 1 && (
        <div className="flex flex-wrap gap-2 border-b p-2">
          {documents.map((item, index) => (
            <Button
              key={item.path}
              size="sm"
              variant={index === documentIndex ? "secondary" : "ghost"}
              onClick={() => setDocumentIndex(index)}
              data-testid={`knowledge-document-${index}`}
            >
              {item.path}
            </Button>
          ))}
        </div>
      )}
      <MarkdownWorkspace
        value={value}
        onChange={setValue}
        onSave={() => save.mutate()}
        saving={save.isPending}
        dirty={value !== document.content}
        readOnly={!canWrite || content.data?.editable !== true}
        label={document.path}
      />
    </div>
  );
}

function FileBody({ id, record }: { id: string; record: RecordValue }) {
  const contentType = typeof record.content_type === "string" ? record.content_type : "";
  const isText =
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("markdown");
  const content = useQuery({
    queryKey: ["file-content", id],
    queryFn: () => apiText(`/v1/files/${encodeURIComponent(id)}/content`),
    enabled: isText,
  });
  if (!isText) return <Overview record={record} />;
  if (content.isPending) return <Skeleton className="h-96 w-full" />;
  return (
    <div className="min-h-[34rem] overflow-hidden rounded-xl border">
      <MarkdownWorkspace
        value={content.data ?? ""}
        onChange={() => undefined}
        readOnly
        label={recordTitle(record)}
      />
    </div>
  );
}

export function CatalogDetailPage({
  resource,
  permissions,
}: {
  resource: DetailResource;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) ?? "");
  // The engine's sign-in callback sends the browser back here with a flag.
  // Read it once and drop it from the address, so a reload does not repeat
  // the sentence. The return is a full page load: connector, credential and
  // runtime are all read fresh, and what the page then says comes from them.
  const [returned] = useState(
    () => resource === "connectors" && returnedFromSignIn(window.location.search),
  );
  useEffect(() => {
    if (!returned) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${withoutSignInReturn(window.location.search)}${window.location.hash}`,
    );
  }, [returned]);
  const access = PERMISSIONS[resource];
  const canRead = permissions.includes(access.read);
  const canWrite = permissions.includes(access.write);
  const query = useQuery({
    queryKey: ["catalog-detail", resource, id],
    queryFn: () => apiRequest<RecordValue>(`${ENDPOINTS[resource]}/${encodeURIComponent(id)}`),
    enabled: canRead && Boolean(id),
  });
  const record = query.data;
  // The way back is the list this record belongs to — for sources, skills and
  // files that is their tab of Wissen.
  const list = navigationItem(`/${resource}`);
  const back = { to: `/${resource}`, label: list ? t(list.labelKey) : t(`nav.${resource}`) };
  if (!canRead)
    return (
      <Alert className="m-6">
        <AlertTitle>{t("resource.permission.title")}</AlertTitle>
        <AlertDescription>{t("resource.permission.description")}</AlertDescription>
      </Alert>
    );
  // `record` is narrowed below by the view, not by a second test of it: a 200
  // that carries no object is a failed read, the same as a 500.
  const view = queryView(query, () => false);
  if (view === "loading")
    return (
      <div className="grid gap-4 p-6">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (view === "error" || !record)
    return (
      <div className="grid gap-4 p-6">
        {/* It used to hand the route key to the sentence, so the reader was
            told "workflows konnten nicht geladen werden" — a machine word in
            the one line meant to explain. */}
        <BackLink to={back.to} label={back.label} />
        <LoadFailed
          title={t("detail.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="detail-load-failed"
        />
      </div>
    );

  // A workflow has a page of its own: its state, how it is called, what it
  // takes and does. The frame below is for the records that are one document.
  if (resource === "workflows")
    return (
      <WorkflowPage
        id={id}
        record={record}
        title={recordTitle(record)}
        purpose={recordPurpose(record)}
        permissions={permissions}
      />
    );
  // A connector has a page of its own as well: its sign-in, its uses, its tools.
  if (resource === "connectors")
    return (
      <ConnectorPage
        id={id}
        record={record}
        title={recordTitle(record)}
        purpose={recordPurpose(record)}
        permissions={permissions}
        returned={returned}
      />
    );

  return (
    <main
      data-family-surface="detail"
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid={`detail-${resource}`}
    >
      <div className="shrink-0 px-6">
        <PageHeader
          back={back}
          title={recordTitle(record)}
          // The record's OWN description when it has one — what this thing is
          // for, in the words of whoever built it. Where it has none the line
          // is absent: a catalogue sentence, the same on every record, would
          // tell a reader who opened one record nothing specific.
          purpose={recordPurpose(record) || undefined}
          secondary={
            resource !== "files" && canWrite ? (
              <MetadataDialog
                resource={resource}
                id={id}
                title={recordTitle(record)}
                version={record.version}
              />
            ) : undefined
          }
          action={
            <DetailAction
              resource={resource}
              name={recordTitle(record)}
              permissions={permissions}
            />
          }
        />
      </div>
      <RecordBar record={record} canWrite={canWrite} />
      <div data-family-slot="detail-main" className="flex min-h-0 flex-1 flex-col gap-5 p-6">
        {resource === "skills" ? <SkillBody id={id} record={record} canWrite={canWrite} /> : null}
        {resource === "knowledge" ? <KnowledgeBody id={id} canWrite={canWrite} /> : null}
        {resource === "files" ? <FileBody id={id} record={record} /> : null}
      </div>
    </main>
  );
}

export type { DetailResource };
