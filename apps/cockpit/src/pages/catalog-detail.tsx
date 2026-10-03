import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { navigationItem } from "@/app/navigation";
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
import { ConnectorStateNotice } from "@/components/cockpit/connector-state";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { DetailAction } from "@/components/cockpit/detail-action";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import { BackLink, PageHeader } from "@/components/cockpit/patterns";
import { WorkflowPage } from "@/components/cockpit/workflow-page";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { connectorAuthState, connectorHealthLabel, needsRenewal } from "@/lib/connector-auth-state";
import { recordBarFacts } from "@/lib/detail-fields";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { type RecordValue, recordPurpose, recordTitle } from "@/pages/catalog-model";
import {
  asInspect,
  connectorNotice,
  type McpInspect,
  renewalWay,
  returnedFromSignIn,
  withoutSignInReturn,
} from "@/pages/connector-detail-model";
import {
  isKnowledgeResource,
  KnowledgeDetailPage,
  type KnowledgeResource,
} from "@/pages/knowledge-detail";

type DetailResource = "workflows" | "connectors" | "knowledge" | "skills" | "files";
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
function RecordBar({
  record,
  canWrite,
  connector,
}: {
  record: RecordValue;
  canWrite: boolean;
  connector: boolean;
}) {
  const { t } = useI18n();
  const health = connector && typeof record.health_state === "string" ? record.health_state : null;
  const healthKey =
    health && health !== "ok" && health !== "needs_reauth" ? connectorHealthLabel(health) : null;
  const { status, version } = connector ? { status: null, version: null } : recordBarFacts(record);
  if (!healthKey && status === null && version === null && canWrite) return null;
  return (
    <div
      data-family-slot="detail-context"
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs"
      data-testid="detail-record-bar"
    >
      {healthKey ? (
        <Badge variant="outline" data-testid="detail-connector-health">
          {t(healthKey)}
        </Badge>
      ) : null}
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

/**
 * A record's page. Sources, skills and files are records of Wissen and have
 * their own (`knowledge-detail.tsx`); workflows and connectors are built here.
 */
export function CatalogDetailPage({
  resource,
  permissions,
}: {
  resource: DetailResource;
  permissions: readonly string[];
}) {
  return isKnowledgeResource(resource) ? (
    <KnowledgeDetailPage resource={resource} permissions={permissions} />
  ) : (
    <RecordDetailPage resource={resource} permissions={permissions} />
  );
}

function RecordDetailPage({
  resource,
  permissions,
}: {
  resource: Exclude<DetailResource, KnowledgeResource>;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
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
  // A probe result is a paragraph that names latency or the missing scopes,
  // not a cell in a list. It belongs on the connector it describes.
  const probe = useMutation({
    mutationFn: () =>
      apiRequest<ProbeResult>(`/v1/connectors/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSuccess: async () => {
      // The result stands on the page; a toast would say it a second time.
      // A test is a real call: a passed one clears a refused sign-in and
      // closes the breaker, and either way it is the newest call on record.
      // Read the connector again so the page says what the test changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] }),
        queryClient.invalidateQueries({ queryKey: ["connector-credential", id] }),
        queryClient.invalidateQueries({ queryKey: ["connector-runtime", id] }),
        queryClient.invalidateQueries({ queryKey: ["connector-stats", id] }),
      ]);
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

  const notice =
    connectorAuth && record
      ? connectorNotice({
          enabled: record.enabled !== false,
          authState: connectorAuth,
          returned,
        })
      : null;
  // One filled action per page: while the sign-in card offers a renewal, that
  // is it, and "Einschalten" stands beside it as the second step.
  const renewalOffered =
    connectorAuth !== null &&
    needsRenewal(connectorAuth) &&
    renewalWay({
      authType: typeof record?.auth_type === "string" ? record.auth_type : null,
      usesConnection: Boolean(credential.data?.connection),
      canWrite,
    }) !== null;

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
            <>
              {canWrite && (
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
            </>
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
      <RecordBar record={record} canWrite={canWrite} connector={resource === "connectors"} />
      {notice ? (
        <ConnectorStateNotice
          connectorId={id}
          notice={notice}
          canWrite={canWrite}
          primary={!renewalOffered}
        />
      ) : null}
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
        </div>
      )}
      {/* A connector's page is a stack of sections taller than the screen: each
          keeps its own height and the page scrolls, instead of the column
          squeezing the last card to a sliver. */}
      <div
        data-family-slot="detail-main"
        className={`flex min-h-0 flex-1 flex-col gap-5 p-6${resource === "connectors" ? " [&>*]:shrink-0" : ""}`}
      >
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
        {/* A connector that signs in with nothing has no sign-in to show: the
            connection's own "Anmeldung" fact already says so. */}
        {resource === "connectors" && connectorAuth && connectorAuth !== "not_required" ? (
          <ConnectorCredentials
            connectorId={id}
            authType={typeof record.auth_type === "string" ? record.auth_type : null}
            state={connectorAuth}
            canWrite={canWrite}
            providerUrl={
              probe.data && !probe.data.ok ? (probe.data.provider_action_url ?? null) : null
            }
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
