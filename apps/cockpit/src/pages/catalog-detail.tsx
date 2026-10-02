import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest, apiText } from "@/api/client";
import type { components } from "@/api/schema";
import { useRecordCrumb } from "@/app/record-crumb";
import {
  ConnectorCredentials,
  useConnectorCredential,
} from "@/components/cockpit/connector-credentials";
import {
  ConnectorConnectionFacts,
  ConnectorMcpTools,
  ConnectorRuntimeSection,
  ConnectorTechnicalFacts,
  ConnectorWorkflows,
} from "@/components/cockpit/connector-detail";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { DetailAction } from "@/components/cockpit/detail-action";
import { MarkdownWorkspace } from "@/components/cockpit/markdown-workspace";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import { bytes, MISSING } from "@/components/cockpit/table-columns";
import { WorkflowPage } from "@/components/cockpit/workflow-page";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  authStateLabel,
  type ConnectorAuthState,
  connectorAuthState,
  connectorHealthLabel,
  needsRenewal,
} from "@/lib/connector-auth-state";
import { type DetailEntry, detailEntries, SCOPE_KEYS, SIDE_EFFECT_KEYS } from "@/lib/detail-fields";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { asInspect, type McpInspect } from "@/pages/connector-detail-model";

type DetailResource = "workflows" | "connectors" | "knowledge" | "skills" | "files";
type RecordValue = Record<string, unknown>;
type ProbeResult = components["schemas"]["ConnectorProbeResult"];

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
 * A connector's own state, in place of a lifecycle it does not have: whether
 * it signs in (§11), whether a person switched it off, and the engine's
 * health verdict when that is not ok. The bar used to fall back to "Aktiv"
 * here — a word about a lifecycle, said about a connector whose sign-in had
 * expired.
 */
function ConnectorStateBadges({
  record,
  authState,
}: {
  record: RecordValue;
  authState: ConnectorAuthState;
}) {
  const { t } = useI18n();
  const lost = needsRenewal(authState);
  const health = typeof record.health_state === "string" ? record.health_state : null;
  const healthKey = health && health !== "ok" ? connectorHealthLabel(health) : null;
  return (
    <>
      <Badge variant={lost ? "destructive" : "outline"} data-testid="detail-connector-auth-state">
        {t(authStateLabel(authState))}
      </Badge>
      {record.enabled === false ? (
        <Badge variant="outline" data-testid="detail-connector-disabled">
          {t("connectors.disabled")}
        </Badge>
      ) : null}
      {healthKey && health !== "needs_reauth" ? (
        <Badge variant="outline" data-testid="detail-connector-health">
          {t(healthKey)}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * The state row under a record's title. A workflow has none: its version and
 * whether it may run stand in its automation panel (`workflow-page.tsx`).
 */
function GovernanceBar({
  record,
  canWrite,
  connectorAuth = null,
}: {
  record: RecordValue;
  canWrite: boolean;
  /** Set for a connector: its sign-in state replaces the lifecycle word. */
  connectorAuth?: ConnectorAuthState | null;
}) {
  const { t } = useI18n();
  const status =
    typeof record.status === "string"
      ? record.status
      : typeof record.lifecycle === "string"
        ? record.lifecycle
        : "active";
  const version = record.version ?? record.current_version;
  return (
    <div
      data-family-slot="detail-context"
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs"
    >
      <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
      <span className="font-medium">{t("detail.governance")}</span>
      {connectorAuth ? (
        <ConnectorStateBadges record={record} authState={connectorAuth} />
      ) : (
        <Badge variant="outline">{statusLabel(t, status)}</Badge>
      )}
      {version !== undefined && <Badge variant="secondary">v{String(version)}</Badge>}
      <span className="text-muted-foreground">
        {t(canWrite ? "detail.canEdit" : "detail.readOnly")}
      </span>
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
  const access = PERMISSIONS[resource];
  const canRead = permissions.includes(access.read);
  const canWrite = permissions.includes(access.write);
  const query = useQuery({
    queryKey: ["catalog-detail", resource, id],
    queryFn: () => apiRequest<RecordValue>(`${ENDPOINTS[resource]}/${encodeURIComponent(id)}`),
    enabled: canRead && Boolean(id),
  });
  const record = query.data;
  // The breadcrumb names the record once it has one; an id never stands in.
  useRecordCrumb(record ? recordTitle(record) : null);
  // A probe result is a paragraph that names latency or the missing scopes,
  // not a cell in a list. It belongs on the connector it describes.
  const probe = useMutation({
    mutationFn: () =>
      apiRequest<ProbeResult>(`/v1/connectors/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSuccess: (result) => {
      if (result.ok) toast.success(t("detail.testPassed"));
    },
  });
  // For an MCP server "Verbindung testen" also reads what the server serves:
  // one handshake, on the reader's click — never on page open.
  const inspect = useMutation({
    mutationFn: async (): Promise<McpInspect> => {
      const body = asInspect(
        await apiRequest<unknown>(`/v1/connectors/${encodeURIComponent(id)}/mcp/inspect`, {
          method: "POST",
        }),
      );
      if (!body) throw new Error("not an inspect answer");
      return body;
    },
  });
  const isMcp = resource === "connectors" && record?.driver === "mcp";
  const canTest = resource === "connectors" && permissions.includes("connector:test");
  const runTest = () => {
    probe.mutate();
    if (isMcp) inspect.mutate();
  };
  // The connector's sign-in, from its record, its credential read and — once
  // run — the manual test. One verdict for the bar and the Anmeldung card.
  const credential = useConnectorCredential(resource === "connectors" && canRead ? id : null);
  const connectorAuth =
    resource === "connectors" && record
      ? connectorAuthState(
          {
            auth_type: typeof record.auth_type === "string" ? record.auth_type : null,
            driver: typeof record.driver === "string" ? record.driver : null,
            health_state: typeof record.health_state === "string" ? record.health_state : null,
            needs_reauth: record.needs_reauth === true,
            auth_failed_at:
              typeof record.auth_failed_at === "string" ? record.auth_failed_at : null,
          },
          probe.data
            ? {
                ok: probe.data.ok,
                ...(probe.data.error_code ? { error_code: probe.data.error_code } : {}),
              }
            : null,
          credential.data,
        )
      : null;

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
      <div className="p-6">
        {/* It used to hand the route key to the sentence, so the reader was
            told "workflows konnten nicht geladen werden" — a machine word in
            the one line meant to explain. The way back is the breadcrumb. */}
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

  return (
    <main
      data-family-surface="detail"
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid={`detail-${resource}`}
    >
      <header
        data-family-slot="detail-header"
        className="flex flex-wrap items-center justify-between gap-4 border-b p-6"
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {recordTitle(record)}
            </h1>
          </div>
          {/* The record's OWN description when it has one — what this thing is
              for, in the words of whoever built it. Where it has none the line
              is absent: the fallback was the catalogue's sentence, the same on
              every record, which told a reader who opened one workflow to
              decide about it nothing specific. */}
          {recordPurpose(record) ? (
            <p className="mt-1 text-sm text-muted-foreground">{recordPurpose(record)}</p>
          ) : null}
        </div>
        <div data-family-slot="detail-actions" className="flex flex-wrap gap-2">
          {resource !== "files" && canWrite && (
            <MetadataDialog
              resource={resource}
              id={id}
              title={recordTitle(record)}
              version={record.version}
            />
          )}
          {canTest && (
            <Button
              variant="outline"
              disabled={probe.isPending || inspect.isPending}
              onClick={runTest}
              data-testid="connector-test"
            >
              <RefreshCw data-icon="inline-start" />
              {t("detail.test")}
            </Button>
          )}
          <DetailAction
            resource={resource}
            id={id}
            name={recordTitle(record)}
            connectorAuth={connectorAuth}
            permissions={permissions}
          />
        </div>
      </header>
      <GovernanceBar record={record} canWrite={canWrite} connectorAuth={connectorAuth} />
      {resource === "connectors" && probe.data && (
        <div className="border-b px-6 py-4" data-testid="connector-probe-result">
          <p
            className={
              probe.data.ok ? "text-sm text-success" : "text-sm font-medium text-destructive"
            }
          >
            {probe.data.ok
              ? t("connectors.probeOk", { ms: String(Math.round(probe.data.latency_ms)) })
              : (probe.data.detail ?? t("connectors.probeFailed"))}
          </p>
          {probe.data.missing_scopes && probe.data.missing_scopes.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t("connectors.missingScopes", { scopes: probe.data.missing_scopes.join(", ") })}
            </p>
          )}
          {!probe.data.ok && probe.data.provider_action_url && (
            <Button variant="outline" size="sm" className="mt-3" asChild>
              <a
                href={probe.data.provider_action_url}
                target="_blank"
                rel="noreferrer"
                data-testid="connector-renew"
              >
                {t("connectors.renew")}
              </a>
            </Button>
          )}
        </div>
      )}
      {/* A connector's page is a stack of sections taller than the screen: each
          keeps its own height and the page scrolls, instead of the column
          squeezing the last card to a sliver. */}
      <div
        data-family-slot="detail-main"
        className={`flex min-h-0 flex-1 flex-col gap-5 p-6${resource === "connectors" ? " [&>*]:shrink-0" : ""}`}
      >
        {resource === "skills" ? <SkillBody id={id} record={record} canWrite={canWrite} /> : null}
        {resource === "knowledge" ? <KnowledgeBody id={id} canWrite={canWrite} /> : null}
        {resource === "files" ? <FileBody id={id} record={record} /> : null}
        {resource === "connectors" ? (
          <ConnectorConnectionFacts
            record={record}
            headerNames={credential.data?.header_names ?? []}
          />
        ) : null}
        {resource === "connectors" ? (
          <ConnectorRuntimeSection
            connectorId={id}
            driver={typeof record.driver === "string" ? record.driver : null}
            canReadStats={permissions.includes("stats:read")}
            onTest={canTest ? runTest : null}
          />
        ) : null}
        {isMcp ? (
          <ConnectorMcpTools
            connectorId={id}
            record={record}
            canWrite={canWrite}
            inspect={{
              data: inspect.data ?? null,
              pending: inspect.isPending,
              failed: inspect.isError,
            }}
          />
        ) : null}
        {resource === "connectors" && connectorAuth ? (
          <ConnectorCredentials
            connectorId={id}
            authType={typeof record.auth_type === "string" ? record.auth_type : null}
            state={connectorAuth}
            canWrite={canWrite}
          />
        ) : null}
        {resource === "connectors" &&
        typeof record.slug === "string" &&
        permissions.includes("workflow:read") ? (
          <ConnectorWorkflows slug={record.slug} />
        ) : null}
        {resource === "connectors" && permissions.includes("conversation:read") ? (
          <ConversationsAbout target={{ connector_id: id }} />
        ) : null}
        {resource === "connectors" ? <ConnectorTechnicalFacts record={record} id={id} /> : null}
      </div>
    </main>
  );
}

export type { DetailResource };
