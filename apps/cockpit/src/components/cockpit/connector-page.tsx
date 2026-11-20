import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { apiRequest } from "@/api/client";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { CatalogCategoryChip, CatalogPurpose } from "@/components/cockpit/catalog-metadata";
import { recordCategory } from "@/components/cockpit/catalog-metadata-model";
import {
  ConnectorAccounts,
  ConnectorCredentials,
  useConnectorCredential,
} from "@/components/cockpit/connector-credentials";
import {
  ConnectorMcpTools,
  ConnectorRuntimeSection,
  ConnectorTechnicalFacts,
  ConnectorWorkflows,
  environmentName,
  useConnectorWorkflows,
} from "@/components/cockpit/connector-detail";
import { ConnectorDeleteDialog, ConnectorEditDialog } from "@/components/cockpit/connector-edit";
import { ConnectionGraphic } from "@/components/cockpit/connector-graphic";
import { connectorService } from "@/components/cockpit/connector-names";
import { serviceHost, signInChipKey, templateFor } from "@/components/cockpit/connector-view-model";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { fetchTemplates, TEMPLATES_KEY } from "@/components/cockpit/create-from-template";
import { templateSignIn } from "@/components/cockpit/create-template-model";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  CollapsibleSection,
  ConfirmDialog,
  DetailPage,
  type PageTab,
  TabBody,
} from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { connectorAuthState } from "@/lib/connector-auth-state";
import { connectorSignIn, signInFailure } from "@/lib/connector-sign-in";
import {
  CONNECTOR_STRIP_KEYS,
  type ConnectorStripAction,
  connectorExpiry,
  connectorStrip,
  connectorStripActionKey,
} from "@/lib/connector-strip";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  asInspect,
  connectorFigures,
  connectorNotice,
  connectorStatsWindow,
  type McpInspect,
  renewalWay,
  type SignInReturn,
  signInFailureLine,
} from "@/pages/connector-detail-model";

type RecordValue = Record<string, unknown>;

const text = (record: RecordValue, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
};

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
  const { t, locale, dateTime } = useI18n();
  const client = useQueryClient();
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const canWrite = permissions.includes("connector:write");
  const canTest = permissions.includes("connector:test");
  const canChat = permissions.includes("conversation:write");
  const isMcp = record.driver === "mcp";
  const authType = text(record, "auth_type");
  const slug = text(record, "slug");
  const templateSlug = text(record, "template_slug");
  const users = useConnectorWorkflows(slug && permissions.includes("workflow:read") ? slug : null);
  const userNames = (users.data?.items ?? []).flatMap((item) => (item.name ? [item.name] : []));
  const userCount = users.data?.total ?? userNames.length;
  const templates = useQuery({
    queryKey: TEMPLATES_KEY,
    enabled: templateSlug !== null,
    queryFn: fetchTemplates,
  });
  const template = templateFor(templates.data?.items ?? [], templateSlug);
  const stats = useQuery({
    queryKey: ["connector-stats", id],
    enabled: permissions.includes("stats:read"),
    queryFn: async () => {
      const bounds = connectorStatsWindow();
      return connectorFigures(
        await apiCall("get", "/v1/stats/connectors", {
          query: { bucket: "day", from: bounds.from, to: bounds.to, connector_id: id },
        }),
        bounds,
      );
    },
  });

  const probe = useMutation({
    mutationFn: () => apiCall("post", "/v1/connectors/{id}/test", { path: { id } }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] }),
        client.invalidateQueries({ queryKey: ["connector-credential", id] }),
        client.invalidateQueries({ queryKey: ["connector-runtime", id] }),
        client.invalidateQueries({ queryKey: ["connector-stats", id] }),
      ]);
    },
  });
  const [toolsReadAt, setToolsReadAt] = useState<string | null>(null);
  const inspect = useMutation({
    mutationFn: async (): Promise<McpInspect> => {
      const body = asInspect(
        await apiCall("post", "/v1/connectors/{id}/mcp/inspect", { path: { id } }),
      );
      if (!body) throw new Error("not an inspect answer");
      return body;
    },
    onSuccess: () => setToolsReadAt(new Date().toISOString()),
  });
  const runTest = () => {
    probe.mutate();
    if (isMcp) inspect.mutate();
  };
  const enable = useOptimisticAction({
    queryKey: ["catalog-detail", "connectors", id],
    mutationFn: () => apiCall("post", "/v1/connectors/{id}/enable", { path: { id } }),
    apply: (current: RecordValue | undefined) =>
      current ? { ...current, enabled: true } : current,
    fromResult: (result) => result,
    errorMessage: () => t("connectorState.enableFailed"),
    onSuccess: () => toast.success(t("connectorState.enabled")),
  });
  const disable = useOptimisticAction({
    queryKey: ["catalog-detail", "connectors", id],
    mutationFn: () => apiCall("post", "/v1/connectors/{id}/disable", { path: { id } }),
    apply: (current: RecordValue | undefined) =>
      current ? { ...current, enabled: false } : current,
    fromResult: (result) => result,
    errorMessage: () => t("connectorPage.disableFailed"),
    onSuccess: () => toast.success(t("connectorPage.disabled")),
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
    onError: (failure) => reportFailure(signInFailure(failure, t), failure),
  });
  const credential = useConnectorCredential(id);
  const connectionRenew = useMutation({
    mutationFn: (connectionId: string) =>
      apiCall("post", "/v1/connections/{id}/renew", { path: { id: connectionId } }),

    onSuccess: (result) => window.location.assign(result.authorization_url),
    onError: (failure) => reportFailure(t("connectorCredentials.renewFailed"), failure),
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
    probe: probe.data
      ? { ok: probe.data.ok, unverified: probe.data.error_code === "credential_unverified" }
      : null,
    missingScopes: credential.data?.missing_scopes?.length ?? 0,
    returned: notice === "signed_in" || notice === "signed_in_off",
    signInFailed: failedSignIn !== null,
    rights: { write: canWrite, test: canTest },
  });
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
        return setReplacing(true);
    }
  };
  const busy =
    enable.isPending || probe.isPending || oauthStart.isPending || connectionRenew.isPending;
  const expiresAt = connectorExpiry(record.credentials, record.environment);
  const testedAt = text(record, "last_tested_at");
  const latencyMs = probe.data?.ok ? probe.data.latency_ms : (stats.data?.medianMs ?? null);
  const stripLine = (() => {
    if (strip.kind === "signInFailed" && failedSignIn !== null)
      return signInFailureLine(failedSignIn, t);
    if (strip.kind === "unreachable" && probe.data && !probe.data.ok)
      return probe.data.detail ?? t("connectors.probeFailed");
    if (strip.kind === "limited") return text(record, "health_reason");
    if (strip.kind === "expired")
      return (
        [
          expiresAt ? t("connectorStrip.line.expiredSince", { when: dateTime(expiresAt) }) : null,
          users.data && userCount > 0
            ? t(
                userCount === 1
                  ? "connectorStrip.line.expired.one"
                  : "connectorStrip.line.expired.other",
                { count: userCount },
              )
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    if (strip.kind === "notSignedIn") return t("connectorStrip.line.notSignedIn");
    if (strip.kind === "unverified") return t("connectorStrip.line.unverified");
    if (strip.kind === "off") return t("connectorPage.offLine");
    if (["tested", "connected", "signedIn", "notRequired"].includes(strip.kind))
      return (
        [
          testedAt
            ? t("connectorStrip.line.testedAt", { when: formatRelativeTime(locale, testedAt) })
            : null,
          probe.data?.ok ? `${Math.round(probe.data.latency_ms)} ms` : null,
          expiresAt ? t("connectorStrip.line.validUntil", { when: dateTime(expiresAt) }) : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    return null;
  })();
  const stateLabel = t(
    strip.kind === "off" && notice === "signed_in_off"
      ? "connectorState.signedInOff"
      : CONNECTOR_STRIP_KEYS[strip.kind],
  );
  const signsInAgain =
    strip.action !== null &&
    (strip.action.kind === "retry" ||
      strip.action.kind === "renew" ||
      strip.action.kind === "complete");

  const menu: ActionMenuItem[] = [
    ...(canChat
      ? [
          {
            label: t("detail.changeInChat"),
            href: absolute(
              chatNewHref({
                connectorId: id,
                prompt: t("detail.changeRecordPrompt"),
                references: [{ type: "connector", id }],
              }),
            ),
            testId: "connector-menu-change",
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
          ...(enabled
            ? [
                {
                  label: t("connectorPage.disable"),
                  onSelect: () => setDisabling(true),
                  testId: "connector-menu-disable",
                },
              ]
            : []),
          {
            label: t("workflowPage.delete"),
            destructive: true,
            onSelect: () => setDeleting(true),
            testId: "connector-menu-delete",
          },
        ]
      : []),
  ];

  const signInWay = templateSignIn({ auth_type: authType ?? "none" });
  const category = recordCategory(record);
  const host = serviceHost(text(record, "base_url"));
  const service = connectorService({
    slug: slug ?? "",
    display_name: title,
    driver: record.driver as string | null | undefined,
    template_slug: templateSlug,
    base_url: text(record, "base_url"),
  });
  const environment = environmentName(record, t);
  const usedBy = users.data
    ? t(
        userCount === 1 ? "connectorPage.summary.usedBy.one" : "connectorPage.summary.usedBy.other",
        { count: userCount },
      )
    : null;
  const overviewSummary = [
    environment,
    usedBy,
    testedAt
      ? t("connectorPage.summary.checked", { when: formatRelativeTime(locale, testedAt) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tabs: PageTab[] = [
    {
      value: "overview",
      label: t("connectorPage.tab.overview"),
      testId: "connector-tab-overview",
      content: (
        <TabBody
          testId="connector-overview"
          summary={overviewSummary || undefined}
          more={
            <CollapsibleSection
              label={t("connectorPage.runtime")}
              testId="connector-runtime-section"
            >
              <ConnectorRuntimeSection record={record} latencyMs={latencyMs} />
            </CollapsibleSection>
          }
        >
          <ConnectionGraphic
            workspace={[session.tenant.display_name, environment].filter(Boolean).join(" · ")}
            service={service}
            serviceName={template?.name ?? title}
            serviceLine={host}
            way={signInWay}
            wayLabel={t(signInChipKey(authType))}
            tone={strip.tone}
            stateLine={stateLabel}
          />
          {auth !== "not_required" ? (
            <ConnectorCredentials
              connectorId={id}
              connectorName={title}
              authType={authType}
              headerNames={credential.data?.header_names ?? []}
              signsInAtProvider={signInRoute !== null}
              state={auth}
              canWrite={canWrite}
              replacing={replacing}
              onReplacing={setReplacing}
              providerUrl={
                probe.data && !probe.data.ok ? (probe.data.provider_action_url ?? null) : null
              }
            />
          ) : null}
          {(authType === "oauth2" || credential.data?.mode === "connection") &&
          permissions.includes("connection:read") ? (
            <ConnectorAccounts
              connectorId={id}
              canWrite={permissions.includes("connection:write")}
              emptyAction={
                signsInAgain || !canWrite || signInRoute === null ? undefined : (
                  <Button
                    variant="outline"
                    size="sm"
                    pending={oauthStart.isPending}
                    onClick={() => oauthStart.mutate()}
                    data-testid="connector-connect-account"
                  >
                    {t("connectorPage.connectAccount")}
                  </Button>
                )
              }
            />
          ) : null}
        </TabBody>
      ),
    },
    {
      value: "usage",
      label: t("connectorPage.tab.usage"),
      testId: "connector-tab-usage",
      content:
        slug && permissions.includes("workflow:read") ? (
          <ConnectorWorkflows
            slug={slug}
            connectorId={id}
            connectorName={title}
            service={service}
            template={template}
            conversations={
              permissions.includes("conversation:read") ? (
                <ConversationsAbout target={{ connector_id: id }} />
              ) : undefined
            }
          />
        ) : permissions.includes("conversation:read") ? (
          <TabBody testId="connector-usage">
            <ConversationsAbout target={{ connector_id: id }} />
          </TabBody>
        ) : null,
    },
    ...(isMcp
      ? [
          {
            value: "tools",
            label: t("connectorPage.tab.tools"),
            testId: "connector-tab-tools",
            content: (
              <ConnectorMcpTools
                connectorId={id}
                record={record}
                canWrite={canWrite}
                canTest={canTest}
                inspect={{
                  data: inspect.data ?? null,
                  readAt: toolsReadAt,
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
    <div
      className="contents"
      data-testid="connector-state"
      data-strip={strip.kind}
      data-notice={notice ?? ""}
    >
      <DetailPage
        testId="detail-connectors"
        back={{ to: "/connectors", label: t("nav.connectors") }}
        title={title}
        badge={<CatalogCategoryChip category={category} testId="catalog-metadata-chip" />}
        purpose={
          <CatalogPurpose
            record={record}
            fallback={t("connectorPage.purpose", { service: template?.name ?? title })}
          />
        }
        action={
          canTest
            ? {
                label: (
                  <>
                    <Activity data-icon="inline-start" />
                    {t("detail.test")}
                  </>
                ),
                variant: "primary",
                onClick: runTest,
                pending: probe.isPending || inspect.isPending,
                testId: "connector-test",
              }
            : undefined
        }
        menu={menu.length > 0 ? <ActionMenu items={menu} testId="connector-menu" /> : undefined}
        technical={
          <ConnectorTechnicalFacts
            record={record}
            id={id}
            headerNames={credential.data?.header_names ?? []}
            speaksAs={credential.data?.speaks_as}
          />
        }
        strip={{
          tone: strip.tone,
          testId: "connector-status-strip",
          line: (
            <>
              <span className="font-medium" data-testid="connector-strip-state">
                {stateLabel}
              </span>
              {stripLine ? (
                <>
                  {" · "}
                  <span data-testid="connector-probe-result">{stripLine}</span>
                </>
              ) : null}
            </>
          ),
          help:
            strip.lower.length > 0
              ? strip.lower.map((kind) => t(CONNECTOR_STRIP_KEYS[kind])).join(" · ")
              : undefined,
          more:
            strip.lower.length > 0
              ? t("workflowStrip.more", { count: strip.lower.length })
              : undefined,
          action: strip.action
            ? {
                label: t(connectorStripActionKey(strip.action)),
                variant: "outline",
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
            : undefined,
        }}
        tabs={tabs}
        defaultTab="overview"
      />
      {canWrite ? (
        <>
          <ConnectorEditDialog
            open={editing}
            onOpenChange={setEditing}
            id={id}
            record={record}
            headerNames={credential.data?.header_names ?? []}
          />
          <ConfirmDialog
            open={disabling}
            onOpenChange={(next) => !disable.isPending && setDisabling(next)}
            object={title}
            verb={t("connectorPage.disable")}
            consequence={
              users.data
                ? t(
                    userCount === 1
                      ? "connectorPage.disableConsequence.one"
                      : "connectorPage.disableConsequence.other",
                    { count: userCount },
                  )
                : t("connectorState.offBody")
            }
            pending={disable.isPending}
            onConfirm={async () => {
              await disable.mutateAsync(undefined).catch(() => undefined);
              setDisabling(false);
            }}
            testId="connector-disable"
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
    </div>
  );
}
