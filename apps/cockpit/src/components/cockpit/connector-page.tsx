import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref } from "@/app/links";
import {
  CatalogMetadataDialog,
  CatalogMetadataSummary,
} from "@/components/cockpit/catalog-metadata";
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
  useConnectorWorkflows,
} from "@/components/cockpit/connector-detail";
import { ConnectorDeleteDialog, ConnectorEditDialog } from "@/components/cockpit/connector-edit";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import {
  ActionMenu,
  type ActionMenuItem,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  Page,
  PageHeader,
  type PageTab,
  PageTabs,
  Section,
  StatusBadge,
  StatusStrip,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { tableColumns } from "@/components/cockpit/table-columns";
import { connectorAuthState } from "@/lib/connector-auth-state";
import { connectorSignIn, signInFailure } from "@/lib/connector-sign-in";
import {
  CONNECTOR_STRIP_KEYS,
  type ConnectorStripAction,
  connectorStrip,
  connectorStripActionKey,
} from "@/lib/connector-strip";
import { useI18n } from "@/lib/i18n-context";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { type ConnectionItem, connectionStateKey } from "@/pages/connections-model";
import {
  asInspect,
  connectorNotice,
  type McpInspect,
  renewalWay,
  type SignInReturn,
  signInFailureLine,
} from "@/pages/connector-detail-model";

type RecordValue = Record<string, unknown>;
type ProbeResult = components["schemas"]["ConnectorProbeResult"];

const text = (record: RecordValue, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
};

const CONNECTION_BADGE: Record<ConnectionItem["state"], string> = {
  valid: "ok",
  expiring: "expiring",
  expired: "expired",
  unreadable: "error",
};

function ConnectorAccountConnections({
  connectorId,
  canWrite,
}: {
  connectorId: string;
  canWrite: boolean;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [disconnect, setDisconnect] = useState<ConnectionItem | null>(null);
  const query = useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => apiRequest<{ items: ConnectionItem[] }>("/v1/connections"),
  });
  const rows = (query.data?.items ?? []).filter((item) =>
    item.used_by.some((user) => user.connector_id === connectorId),
  );
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      const name = disconnect?.name ?? "";
      setDisconnect(null);
      await client.invalidateQueries({ queryKey: ["admin", "connections"] });
      await client.invalidateQueries({ queryKey: ["connector-credential", connectorId] });
      toast.success(t("connections.disconnected", { name }));
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  const columns = useMemo<CockpitColumn<ConnectionItem>[]>(() => {
    const column = tableColumns<ConnectionItem>({ t, dateTime });
    return [
      column.text("name", (row) => row.service_name ?? row.name, t("connectorPage.account"), {
        width: "w-[45%]",
      }),
      column.custom(
        "state",
        (row) => row.state,
        t("resource.field.status"),
        (row) => (
          <StatusBadge
            state={CONNECTION_BADGE[row.state]}
            label={t(connectionStateKey(row.state))}
          />
        ),
        { width: "w-[25%]" },
      ),
      column.date("expires_at", (row) => row.expires_at, t("connectorPage.expires"), {
        width: "w-[30%]",
      }),
    ];
  }, [t, dateTime]);
  if (!query.isPending && !query.error && rows.length === 0) return null;
  return (
    <Section label={t("connectorPage.accounts")} testId="connector-account-connections">
      <RecordTable
        columns={columns}
        data={rows}
        collectionId="connector-account"
        emptyLine={t("connections.emptyTitle")}
        pending={query.isPending}
        error={
          query.error
            ? { line: t("connections.loadFailed"), onRetry: () => void query.refetch() }
            : null
        }
        rowActions={
          canWrite
            ? (row, index) => (
                <span data-action-scope="connection">
                  <ActionMenu
                    items={[
                      {
                        label: t("connections.disconnect"),
                        onSelect: () => setDisconnect(row),
                        testId: `connector-account-${index}-disconnect`,
                      },
                    ]}
                  />
                </span>
              )
            : undefined
        }
      />
      <ConfirmDialog
        open={disconnect !== null}
        onOpenChange={(next) => !next && !remove.isPending && setDisconnect(null)}
        object={disconnect?.name ?? ""}
        verb={t("connections.disconnect")}
        consequence={t("connectorPage.disconnectConsequence")}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (disconnect) await remove.mutateAsync(disconnect.id).catch(() => undefined);
        }}
        testId="connector-account-disconnect"
      />
    </Section>
  );
}

export function ConnectorPage({
  id,
  record,
  title,
  permissions,
  returned,
}: {
  id: string;
  record: RecordValue;
  title: string;
  permissions: readonly string[];
  returned: SignInReturn | null;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canWrite = permissions.includes("connector:write");
  const canTest = permissions.includes("connector:test");
  const canChat = permissions.includes("conversation:write");
  const isMcp = record.driver === "mcp";
  const authType = text(record, "auth_type");
  const slug = text(record, "slug");
  const users = useConnectorWorkflows(slug && permissions.includes("workflow:read") ? slug : null);
  const userNames = (users.data?.items ?? []).flatMap((item) => (item.name ? [item.name] : []));
  const userCount = users.data?.total ?? userNames.length;

  const probe = useMutation({
    mutationFn: () =>
      apiRequest<ProbeResult>(`/v1/connectors/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] }),
        client.invalidateQueries({ queryKey: ["connector-credential", id] }),
        client.invalidateQueries({ queryKey: ["connector-runtime", id] }),
        client.invalidateQueries({ queryKey: ["connector-stats", id] }),
      ]);
    },
  });
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
  const runTest = () => {
    probe.mutate();
    if (isMcp) inspect.mutate();
  };
  const enable = useOptimisticAction({
    queryKey: ["catalog-detail", "connectors", id],
    mutationFn: () =>
      apiRequest<RecordValue>(`/v1/connectors/${encodeURIComponent(id)}/enable`, {
        method: "POST",
      }),
    apply: (current: RecordValue | undefined) =>
      current ? { ...current, enabled: true } : current,
    fromResult: (result) => result,
    errorMessage: () => t("connectorState.enableFailed"),
    onSuccess: () => toast.success(t("connectorState.enabled")),
  });
  const signInRoute = connectorSignIn(record);
  const oauthStart = useMutation({
    mutationFn: () => {
      if (!signInRoute) throw new Error("no browser sign-in");
      return apiRequest<{ authorization_url: string }>(signInRoute.start, { method: "POST" });
    },
    onSuccess: async (result) => {
      if (result.authorization_url) return window.location.assign(result.authorization_url);
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] });
      await client.invalidateQueries({ queryKey: ["connector-credential", id] });
    },
    onError: (failure) => toast.error(signInFailure(failure, t)),
  });
  const credential = useConnectorCredential(id);
  const connectionRenew = useMutation({
    mutationFn: (connectionId: string) =>
      apiRequest<{ authorization_url: string }>(
        `/v1/connections/${encodeURIComponent(connectionId)}/renew`,
        { method: "POST" },
      ),
    onSuccess: (result) => window.location.assign(result.authorization_url),
    onError: () => toast.error(t("connectorCredentials.renewFailed")),
  });

  const auth = connectorAuthState(
    {
      auth_type: authType,
      driver: text(record, "driver"),
      health_state: text(record, "health_state"),
      needs_reauth: record.needs_reauth === true,
      auth_failed_at: text(record, "auth_failed_at"),
    },
    probe.data
      ? {
          ok: probe.data.ok,
          ...(probe.data.error_code ? { error_code: probe.data.error_code } : {}),
        }
      : null,
    credential.data,
  );
  const way = renewalWay({
    authType,
    signsInAtProvider: signInRoute !== null,
    usesConnection: Boolean(credential.data?.connection),
    canWrite,
  });
  const enabled = record.enabled !== false;
  const notice = connectorNotice({
    enabled,
    authState: auth,
    returned: returned?.kind === "signed_in",
  });
  const failedSignIn = returned?.kind === "signin_failed" ? returned : null;
  const strip = connectorStrip({
    auth,
    way,
    enabled,
    health: text(record, "health_state"),
    probe: probe.data ? { ok: probe.data.ok } : null,
    missingScopes: credential.data?.missing_scopes?.length ?? 0,
    returned: notice === "signed_in" || notice === "signed_in_off",
    signInFailed: failedSignIn !== null,
    rights: { write: canWrite, test: canTest },
  });
  const toConnection = () => setEditing(true);
  const act = (action: ConnectorStripAction) => {
    switch (action.kind) {
      case "enable":
        return enable.mutate(undefined);
      case "recheck":
        return runTest();
      case "retry":
      case "renew":
      case "complete":
        if (action.way === "provider") return oauthStart.mutate();
        if (action.way === "connection" && credential.data?.connection)
          return connectionRenew.mutate(credential.data.connection.id);
        return toConnection();
    }
  };
  const busy =
    enable.isPending || probe.isPending || oauthStart.isPending || connectionRenew.isPending;
  const stripLine =
    strip.kind === "signInFailed" && failedSignIn !== null
      ? signInFailureLine(failedSignIn, t)
      : strip.kind === "tested" && probe.data
        ? t("connectors.probeOk", { ms: String(Math.round(probe.data.latency_ms)) })
        : strip.kind === "unreachable" && probe.data && !probe.data.ok
          ? (probe.data.detail ?? t("connectors.probeFailed"))
          : strip.kind === "expired" && users.data
            ? t(
                userCount === 1
                  ? "connectorStrip.line.expired.one"
                  : "connectorStrip.line.expired.other",
                { count: userCount },
              )
            : strip.kind === "notSignedIn"
              ? t("connectorStrip.line.notSignedIn")
              : null;

  const menu: ActionMenuItem[] = [
    ...(canTest
      ? [
          {
            label: t("detail.test"),
            disabled: probe.isPending || inspect.isPending,
            onSelect: runTest,
            testId: "connector-test",
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            label: t("connectorEdit.edit"),
            onSelect: () => setEditing(true),
            testId: "connector-menu-edit",
          },
          {
            label: t("workflowPage.delete"),
            destructive: true,
            onSelect: () => setDeleting(true),
            testId: "connector-menu-delete",
          },
        ]
      : []),
  ];

  const tabs: PageTab[] = [
    {
      value: "usage",
      label: t("connectorPage.tab.usage"),
      content: (
        <>
          {typeof record.slug === "string" && permissions.includes("workflow:read") ? (
            <ConnectorWorkflows slug={record.slug} connectorId={id} />
          ) : null}
          {permissions.includes("conversation:read") ? (
            <ConversationsAbout target={{ connector_id: id }} />
          ) : null}
        </>
      ),
    },
    {
      value: "connection",
      label: t("connectorPage.tab.connection"),
      content: (
        <>
          <ConnectorConnectionFacts
            record={record}
            headerNames={credential.data?.header_names ?? []}
          />
          {auth !== "not_required" ? (
            <ConnectorCredentials
              connectorId={id}
              authType={authType}
              signsInAtProvider={signInRoute !== null}
              state={auth}
              canWrite={canWrite}
              stateInStrip={strip.kind === "connected"}
              providerUrl={
                probe.data && !probe.data.ok ? (probe.data.provider_action_url ?? null) : null
              }
            />
          ) : null}
          {permissions.includes("connection:read") ? (
            <ConnectorAccountConnections
              connectorId={id}
              canWrite={permissions.includes("connection:write")}
            />
          ) : null}
          <div className="flex flex-col gap-2">
            <CollapsibleSection
              label={t("connectorPage.runtime")}
              testId="connector-runtime-section"
            >
              <ConnectorRuntimeSection
                connectorId={id}
                driver={text(record, "driver")}
                canReadStats={permissions.includes("stats:read")}
              />
            </CollapsibleSection>
            <CollapsibleSection
              label={t("connectorDetail.technical.title")}
              testId="connector-technical"
            >
              <ConnectorTechnicalFacts record={record} id={id} />
            </CollapsibleSection>
          </div>
        </>
      ),
    },
    ...(isMcp
      ? [
          {
            value: "tools",
            label: t("connectorPage.tab.tools"),
            content: (
              <ConnectorMcpTools
                connectorId={id}
                record={record}
                canWrite={canWrite}
                canTest={canTest}
                inspect={{
                  data: inspect.data ?? null,
                  pending: inspect.isPending,
                  failed: inspect.isError,
                }}
                onInspect={() => inspect.mutate()}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <Page
      kind="detail"
      scroll="page"
      testId="detail-connectors"
      surface="detail"
      header={
        <PageHeader
          back={{ to: "/connectors", label: t("nav.connectors") }}
          title={title}
          purpose={
            <CatalogMetadataSummary
              record={record}
              {...(canWrite ? { onEdit: () => setDescribing(true) } : {})}
            />
          }
          secondary={
            canChat ? (
              <ActionMenu
                items={[
                  {
                    label: t("detail.changeInChat"),
                    href: absolute(
                      chatNewHref({
                        connectorId: id,
                        prompt: t("detail.changeRecordPrompt", { name: title }),
                      }),
                    ),
                    testId: "connector-menu-change",
                  },
                ]}
              />
            ) : undefined
          }
          menu={menu.length > 0 ? <ActionMenu items={menu} testId="connector-menu" /> : undefined}
        />
      }
    >
      <div className="flex flex-col gap-6">
        <div data-testid="connector-state" data-strip={strip.kind} data-notice={notice ?? ""}>
          <StatusStrip
            tone={strip.tone}
            testId="connector-status-strip"
            line={
              <>
                <span className="font-medium" data-testid="connector-strip-state">
                  {t(
                    strip.kind === "off" && notice === "signed_in_off"
                      ? "connectorState.signedInOff"
                      : CONNECTOR_STRIP_KEYS[strip.kind],
                  )}
                </span>
                {stripLine ? (
                  <>
                    {" · "}
                    <span data-testid="connector-probe-result">{stripLine}</span>
                  </>
                ) : null}
              </>
            }
            help={
              strip.lower.length > 0
                ? strip.lower.map((kind) => t(CONNECTOR_STRIP_KEYS[kind])).join(" · ")
                : undefined
            }
            more={
              strip.lower.length > 0
                ? t("workflowStrip.more", { count: strip.lower.length })
                : undefined
            }
            action={
              strip.action
                ? {
                    label: t(connectorStripActionKey(strip.action)),
                    variant: strip.tone === "ok" ? "outline" : "primary",
                    pending: busy,
                    onClick: () => strip.action && act(strip.action),
                    testId:
                      strip.action.kind === "enable"
                        ? "connector-enable"
                        : strip.action.kind === "recheck"
                          ? "connector-recheck"
                          : strip.action.kind === "retry"
                            ? "connector-signin-again"
                            : "connector-renew-signin",
                  }
                : undefined
            }
          />
        </div>
        <PageTabs tabs={tabs} param="tab" testId="connector-tabs" />
      </div>
      {canWrite ? (
        <>
          <CatalogMetadataDialog
            kind="connector"
            id={id}
            record={record}
            open={describing}
            onOpenChange={setDescribing}
            queryKey={["catalog-detail", "connectors", id]}
          />
          <ConnectorEditDialog
            open={editing}
            onOpenChange={setEditing}
            id={id}
            record={record}
            headerName={credential.data?.header_names?.[0] ?? ""}
          />
          <ConnectorDeleteDialog
            open={deleting}
            onOpenChange={setDeleting}
            id={id}
            name={title}
            users={userNames}
          />
        </>
      ) : null}
    </Page>
  );
}
