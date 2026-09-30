import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest, apiText, listConversationsAbout } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, conversationHref } from "@/app/links";
import { useRecordCrumb } from "@/app/record-crumb";
import { AgentPanel } from "@/components/cockpit/agent-panel";
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
import { MarkdownWorkspace } from "@/components/cockpit/markdown-workspace";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { bytes, MISSING } from "@/components/cockpit/table-columns";
import { WorkflowAuthorities } from "@/components/cockpit/workflow-authorities";
import { WorkflowGallery } from "@/components/cockpit/workflow-gallery";
import { RecentRuns, WorkflowCause, WorkflowHealthBadge } from "@/components/cockpit/workflow-runs";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  authStateLabel,
  type ConnectorAuthState,
  connectorAuthState,
  connectorHealthLabel,
  needsRenewal,
} from "@/lib/connector-auth-state";
import { type DetailEntry, detailEntries, SCOPE_KEYS, SIDE_EFFECT_KEYS } from "@/lib/detail-fields";
import { formatRelativeTime } from "@/lib/i18n";
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
 * The conversations people had about this object. Provenance is structural
 * here, as in the reference model: you see them where the object is, and the
 * global chat list stays a way back into your own work.
 */
function ConversationsAbout({
  target,
}: {
  target: { workflow_id?: string; connector_id?: string };
}) {
  const { t, locale } = useI18n();
  const query = useQuery({
    queryKey: ["conversations", "about", target.workflow_id, target.connector_id],
    queryFn: () => listConversationsAbout(target),
  });
  const items = query.data?.items ?? [];
  return (
    <section className="grid gap-2" data-testid="detail-conversations">
      <h2 className="text-sm font-semibold">{t("catalog.conversations.title")}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="detail-conversations-empty">
          {t("catalog.conversations.empty")}
        </p>
      ) : (
        <ul className="grid gap-1">
          {items.map((conversation, index) => (
            <li key={conversation.id}>
              <a
                className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                href={absolute(conversationHref(conversation.id))}
                aria-label={t("catalog.conversations.open")}
                data-testid={`detail-conversation-${index}`}
              >
                <span className="min-w-0 truncate">{conversation.title || t("chat.untitled")}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTime(
                    locale,
                    conversation.last_activity_at ?? conversation.updated_at,
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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

function GovernanceBar({
  record,
  canWrite,
  workflow = false,
  connectorAuth = null,
}: {
  record: RecordValue;
  canWrite: boolean;
  workflow?: boolean;
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
        <Badge variant="outline">
          {workflow && status === "active" ? t("authority.versionActive") : statusLabel(t, status)}
        </Badge>
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

function WorkflowBody({
  id,
  record,
  canRun,
}: {
  id: string;
  record: RecordValue;
  canRun: boolean;
}) {
  const { t } = useI18n();
  const steps = Array.isArray(record.steps)
    ? record.steps.filter((step): step is RecordValue => Boolean(step) && typeof step === "object")
    : [];
  return (
    <Tabs defaultValue="steps">
      <TabsList>
        <TabsTrigger value="steps" data-testid="workflow-tab-dag">
          {t("detail.workflow")}
        </TabsTrigger>
        <TabsTrigger value="overview" data-testid="workflow-tab-overview">
          {t("detail.overview")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="steps" className="pt-4">
        <WorkflowGallery
          key={`${id}:${String(record.current_version_id ?? "none")}`}
          workflowId={id}
          versionId={
            typeof record.current_version_id === "string" ? record.current_version_id : null
          }
          steps={steps}
          definition={workflowDraftDefinition(record, steps)}
          canRun={canRun}
        />
      </TabsContent>
      <TabsContent value="overview" className="pt-4">
        <Overview record={record} />
      </TabsContent>
    </Tabs>
  );
}

/** The saved workflow replayed as a draft, so a test run never touches the stored version. */
function workflowDraftDefinition(
  record: RecordValue,
  steps: readonly RecordValue[],
): Record<string, unknown> {
  return {
    name: typeof record.name === "string" ? record.name : "Test run",
    ...(typeof record.slug === "string" ? { slug: record.slug } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    steps,
  };
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

function MetadataDialog({
  resource,
  id,
  record,
}: {
  resource: Exclude<DetailResource, "files">;
  id: string;
  record: RecordValue;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(recordTitle(record));
  const mutation = useMutation({
    mutationFn: () => {
      const path =
        resource === "workflows"
          ? `/v1/workflows/${encodeURIComponent(id)}/metadata`
          : `${ENDPOINTS[resource]}/${encodeURIComponent(id)}`;
      const body =
        resource === "skills" ? { title: name, expected_version: record.version } : { name };
      return apiRequest<RecordValue>(path, { method: "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setOpen(false);
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["catalog-detail", resource, id] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="detail-edit-metadata">
        <Pencil data-icon="inline-start" />
        {t("detail.editMetadata")}
      </Button>
      <DialogContent data-testid="detail-metadata-dialog">
        <DialogHeader>
          <DialogTitle>{t("detail.editMetadata")}</DialogTitle>
          <DialogDescription>{t("detail.editMetadataDescription")}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="detail-record-name">{t("common.name")}</FieldLabel>
          <Input
            id="detail-record-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="detail-metadata-name"
          />
        </Field>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="detail-metadata-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || name === recordTitle(record) || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="detail-metadata-save"
          >
            {t("common.saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const chatHref = useMemo(
    () =>
      absolute(
        chatNewHref({
          prompt: `${t("detail.continueInChat")}: ${recordTitle(record)}`,
          workflowId: resource === "workflows" ? id : null,
          connectorId: resource === "connectors" ? id : null,
        }),
      ),
    [record, t, resource, id],
  );
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
            {resource === "workflows" ? (
              <WorkflowHealthBadge
                state={typeof record.health_state === "string" ? record.health_state : null}
              />
            ) : null}
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
          {resource === "workflows" && permissions.includes("workflow:run") && (
            <RunWorkflowDialog
              workflowId={id}
              workflowName={recordTitle(record)}
              version={record.current_version === undefined ? null : String(record.current_version)}
            />
          )}
          {resource === "workflows" && permissions.includes("conversation:write") && (
            <AgentPanel workflowId={id} workflowName={recordTitle(record)} />
          )}
          {resource !== "files" && canWrite && (
            <MetadataDialog resource={resource} id={id} record={record} />
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
          <Button asChild variant="outline">
            <a href={chatHref} data-testid="detail-chat-action">
              <Bot data-icon="inline-start" />
              {t("detail.continueInChat")}
            </a>
          </Button>
        </div>
      </header>
      <GovernanceBar
        record={record}
        canWrite={canWrite}
        workflow={resource === "workflows"}
        connectorAuth={connectorAuth}
      />
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
      <div data-family-slot="detail-main" className="flex min-h-0 flex-1 flex-col gap-5 p-6">
        {resource === "workflows" ? (
          <WorkflowCause
            workflowId={id}
            healthState={typeof record.health_state === "string" ? record.health_state : null}
            healthReason={typeof record.health_reason === "string" ? record.health_reason : null}
            healthChangedAt={
              typeof record.health_changed_at === "string" ? record.health_changed_at : null
            }
            permissions={permissions}
          />
        ) : null}
        {resource === "workflows" && permissions.includes("execution:read") ? (
          <RecentRuns workflowId={id} />
        ) : null}
        {resource === "workflows" ? (
          <WorkflowAuthorities
            workflowId={id}
            workflow={{
              current_version_id:
                typeof record.current_version_id === "string" ? record.current_version_id : null,
              draft_version_id:
                typeof record.draft_version_id === "string" ? record.draft_version_id : null,
              current_version:
                typeof (record.version ?? record.current_version) === "number"
                  ? ((record.version as number) ?? (record.current_version as number))
                  : null,
            }}
            canWrite={canWrite}
          />
        ) : null}
        {resource === "workflows" ? (
          <WorkflowBody id={id} record={record} canRun={permissions.includes("workflow:run")} />
        ) : null}
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
        {(resource === "workflows" || resource === "connectors") &&
        permissions.includes("conversation:read") ? (
          <ConversationsAbout
            target={resource === "workflows" ? { workflow_id: id } : { connector_id: id }}
          />
        ) : null}
        {resource === "connectors" ? <ConnectorTechnicalFacts record={record} id={id} /> : null}
      </div>
    </main>
  );
}

export type { DetailResource };
