import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { type ApiAccessSection, apiAccessSectionFromUrl } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { ListTable } from "@/components/cockpit/list-table";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  ContextHelp,
  CopyField,
  FactList,
  Field,
  FieldGroup,
  FieldLabel,
  FormDialog,
  Input,
  Page,
  PageHeader,
  type PageTab,
  PageTabs,
  RecordSheet,
  RowName,
  SegmentedControl,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  API_KEYS_QUERY,
  type ApiKeyItem,
  apiKeyCreatorLabel,
  apiKeyOwnerLabel,
  type ConnectedClientItem,
  connectedClientActiveSummary,
  connectedClientHistory,
  groupApiKeys,
  groupConnectedClients,
  type KeyScopePreset,
  keyPresetScopes,
  keyState,
  keyStateText,
  keysNeedingAction,
  openApiAccessSection,
  ROTATE_OVERLAP_MINUTES,
  readableSections,
  scopeLabel,
  scopeRisk,
  scopeRiskKey,
} from "@/pages/api-access-model";

type IssuedApiKey = ApiKeyItem & { plaintext_key: string };
type Translate = ReturnType<typeof useI18n>["t"];

const CLIENTS_QUERY = ["admin", "oauth-clients"] as const;

const SECTION_TITLE_KEYS = {
  keys: "apiAccess.section.keys",
  apps: "apiAccess.section.clients",
} as const;

function KeyBadge({ apiKey, now }: { apiKey: ApiKeyItem; now: number }) {
  const { t } = useI18n();
  if (apiKey.revoked_at) return <StatusBadge state="revoked" label={t("apiKeys.revokedBadge")} />;
  const state = keyState(apiKey, now);
  return state ? (
    <StatusBadge state={state.kind} label={keyStateText(state, t)} />
  ) : (
    <StatusBadge state="active" />
  );
}

export function ApiAccessPage() {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => session.permissions.includes(permission);
  const canKeys = can("api_key:read");
  const canClients = can("mcp_oauth_client:read");
  const live = useLiveQueryOptions();

  const keys = useQuery({
    queryKey: API_KEYS_QUERY,
    queryFn: () => apiRequest<{ items: ApiKeyItem[] }>("/v1/identity/api-keys"),
    enabled: canKeys,
    ...live,
  });
  const clients = useQuery({
    queryKey: CLIENTS_QUERY,
    queryFn: () => apiRequest<{ items: ConnectedClientItem[] }>("/v1/oauth/clients"),
    enabled: canClients,
    ...live,
  });

  const readable = useMemo(
    () => readableSections({ keys: canKeys, apps: canClients }),
    [canKeys, canClients],
  );
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const active = openApiAccessSection(apiAccessSectionFromUrl(searchStr), readable);

  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<{ secret: string; name: string | null } | null>(null);

  const nowMs = Date.now();
  const counts: Record<ApiAccessSection, number> = {
    keys: keys.data ? keysNeedingAction(keys.data.items, nowMs) : 0,
    apps: 0,
  };
  const activeKeys = groupApiKeys(keys.data?.items ?? []).active.length;

  const createKey = can("api_key:write") ? (
    <Button onClick={() => setCreateOpen(true)} data-testid="api-key-create">
      {t("apiKeys.create")}
    </Button>
  ) : null;
  const action = active === "keys" && (keys.data?.items.length ?? 0) > 0 ? createKey : null;

  const content: Record<ApiAccessSection, ReactNode> = {
    keys: (
      <KeysSection
        query={keys}
        activeCount={activeKeys}
        emptyAction={createKey}
        onIssued={setIssued}
      />
    ),
    apps: <ClientsSection query={clients} />,
  };
  const tabs: PageTab[] = readable.map((section) => ({
    value: section,
    label: t(SECTION_TITLE_KEYS[section]),
    count: counts[section] > 0 ? counts[section] : undefined,
    testId: `api-access-tab-${section}`,
    content: (
      <div className="flex flex-col gap-3" data-testid={`api-access-section-${section}`}>
        {content[section]}
      </div>
    ),
  }));

  return (
    <Page
      kind="list"
      testId="admin-api-access"
      scroll="page"
      surface="installation"
      header={<PageHeader title={t("resource.apiAccess.title")} action={action} />}
    >
      {readable.length === 0 ? (
        <ForbiddenState />
      ) : readable.length === 1 ? (
        tabs[0]?.content
      ) : (
        <PageTabs tabs={tabs} param="section" testId="api-access-tabs" />
      )}
      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onIssued={async (plaintext) => {
          setCreateOpen(false);
          setIssued(plaintext);
        }}
      />
      <IssuedKeyDialog issued={issued} onClose={() => setIssued(null)} />
    </Page>
  );
}

function countText(
  t: Translate,
  count: number,
  one: Parameters<Translate>[0],
  many: Parameters<Translate>[0],
): string {
  return count === 1 ? t(one) : t(many, { count: String(count) });
}

function scopeWords(scopes: readonly string[], t: Translate): string {
  return scopes
    .map((scope) => `${scopeLabel(scope, t).text} · ${t(scopeRiskKey(scopeRisk(scope)))}`)
    .join(", ");
}

function KeysSection({
  query,
  activeCount,
  emptyAction,
  onIssued,
}: {
  query: UseQueryResult<{ items: ApiKeyItem[] }>;
  activeCount: number;
  emptyAction: ReactNode;
  onIssued(issued: { secret: string; name: string | null }): void;
}) {
  const { t, tn, locale, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const directory = useActorDirectory(true);
  const canRotate = session.permissions.includes("api_key:rotate");
  const canRevoke = session.permissions.includes("api_key:revoke");
  const [rotating, setRotating] = useState<ApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null);
  const [opened, setOpened] = useState<ApiKeyItem | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: API_KEYS_QUERY });

  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ old: ApiKeyItem; new: IssuedApiKey }>(
        `/v1/identity/api-keys/${encodeURIComponent(id)}/rotate`,
        { method: "POST", body: JSON.stringify({ overlap_minutes: ROTATE_OVERLAP_MINUTES }) },
      ),
    onSuccess: async (result) => {
      setRotating(null);
      setOpened(null);
      onIssued({ secret: result.new.plaintext_key, name: result.new.name });
      await refresh();
      if (result.old.rotating_out_at)
        toast.success(t("apiKeys.rotated", { date: dateTime(result.old.rotating_out_at) }));
    },
    onError: () => toast.error(t("apiKeys.actionFailed")),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/identity/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoking(null);
      setOpened(null);
      await refresh();
      toast.success(t("apiKeys.revoked"));
    },
    onError: () => toast.error(t("apiKeys.actionFailed")),
  });

  const nowMs = Date.now();
  const columns = useMemo<CockpitColumn<ApiKeyItem>[]>(() => {
    const column = tableColumns<ApiKeyItem>({ t, dateTime });
    return [
      column.custom(
        "name",
        (key) => key.name,
        t("apiAccess.column.name"),
        (key) => (
          <span className="block truncate font-medium">
            <RowName>{key.name || t("apiKeys.unnamed")}</RowName>
            <span className="block text-xs font-normal text-muted-foreground">
              {t("apiKeys.createdOn", { date: dateTime(key.created_at) })}
            </span>
          </span>
        ),
        { width: "w-[30%]", ownsRowLink: true },
      ),
      column.custom(
        "scopes",
        (key) => key.scopes.length,
        t("apiKeys.scopes"),
        (key, index) => {
          const words = scopeWords(key.scopes, t);
          return (
            <span
              className="block truncate text-sm"
              title={words}
              data-testid={`api-key-scopes-${index}`}
            >
              {words}
            </span>
          );
        },
        { width: "w-[30%]" },
      ),
      column.custom(
        "state",
        (key) => keyState(key, nowMs)?.kind ?? "active",
        t("apiAccess.column.state"),
        (key, index) => {
          if (key.revoked_at)
            return <StatusBadge state="revoked" label={t("apiKeys.revokedBadge")} />;
          const state = keyState(key, nowMs);
          return state ? (
            <span data-testid={`api-key-${state.kind}-${index}`} data-key-state={state.kind}>
              <StatusBadge state={state.kind} label={keyStateText(state, t)} />
            </span>
          ) : (
            <StatusBadge state="active" />
          );
        },
        { width: "w-[20%]" },
      ),
      column.custom(
        "last_used_at",
        (key) => key.last_used_at,
        t("apiAccess.column.lastUsed"),
        (key, index) => (
          <span data-testid={`api-key-use-${index}`}>
            {key.last_used_at
              ? formatRelativeTime(locale, key.last_used_at)
              : t("apiKeys.neverUsed")}
          </span>
        ),
        { width: "w-[20%]" },
      ),
    ];
  }, [t, locale, nowMs]);

  const groups = groupApiKeys(query.data?.items ?? []);
  const keyMenu = (key: ApiKeyItem, prefix: string) => {
    const items: ActionMenuItem[] = [];
    if (key.revoked_at) return items;
    if (canRotate)
      items.push({
        label: t("apiKeys.rotate"),
        onSelect: () => setRotating(key),
        testId: `${prefix}-rotate`,
      });
    if (canRevoke)
      items.push({
        label: t("apiKeys.revoke"),
        onSelect: () => setRevoking(key),
        destructive: true,
        testId: `${prefix}-revoke`,
      });
    return items;
  };
  const keyActions = (key: ApiKeyItem, index: number) => {
    const items = keyMenu(key, `api-key-${index}`);
    if (items.length === 0) return null;
    return (
      <span data-action-scope="api-key">
        <ActionMenu items={items} size="sm" testId={`api-key-menu-${index}`} />
      </span>
    );
  };
  const total = query.data?.items.length ?? 0;
  const keyName = (key: ApiKeyItem | null) =>
    t("apiKeys.object", { name: key?.name || t("apiKeys.unnamed") });

  return (
    <>
      {total > 0 ? (
        <SummaryLine
          testId="api-access-total-keys"
          text={tn("apiAccess.total.keysSummary", total, { active: activeCount })}
          help={t("apiAccess.keysHelp")}
        />
      ) : null}
      <ListTable
        id="api-keys"
        columns={columns}
        rows={groups.active}
        pending={query.isPending}
        failed={query.isError}
        resource={t("apiAccess.section.keys")}
        onRetry={() => void query.refetch()}
        empty={total === 0 ? t("apiKeys.emptyTitle") : t("apiKeys.noneActive")}
        emptyAction={total === 0 ? emptyAction : undefined}
        rowActions={keyActions}
        onOpen={(key: ApiKeyItem) => setOpened(key)}
        rowLabel={(key) => t("apiKeys.openRow", { name: key.name || t("apiKeys.unnamed") })}
      />
      {groups.revoked.length > 0 ? (
        <CollapsibleSection
          label={t("apiKeys.revokedGroup")}
          count={groups.revoked.length}
          testId="api-keys-revoked"
        >
          <ListTable
            id="api-keys-revoked-list"
            columns={columns}
            rows={groups.revoked}
            pending={false}
            failed={false}
            resource={t("apiAccess.section.keys")}
            onRetry={() => void query.refetch()}
            empty={t("apiKeys.emptyTitle")}
            onOpen={(key: ApiKeyItem) => setOpened(key)}
            rowLabel={(key) => t("apiKeys.openRow", { name: key.name || t("apiKeys.unnamed") })}
          />
        </CollapsibleSection>
      ) : null}
      <RecordSheet
        dock
        open={opened !== null}
        onOpenChange={(next) => !next && setOpened(null)}
        title={opened?.name || t("apiKeys.unnamed")}
        badge={opened ? <KeyBadge apiKey={opened} now={nowMs} /> : null}
        menu={
          opened && keyMenu(opened, "api-key-sheet").length > 0 ? (
            <ActionMenu items={keyMenu(opened, "api-key-sheet")} testId="api-key-sheet-menu" />
          ) : null
        }
        testId="api-key-sheet"
      >
        {opened ? (
          <FactList
            testId="api-key-sheet-facts"
            items={[
              { label: t("apiKeys.scopes"), value: scopeWords(opened.scopes, t) },
              { label: t("apiKeys.created"), value: dateTime(opened.created_at) },
              {
                label: t("apiKeys.owner"),
                value: apiKeyOwnerLabel(opened, directory, t),
              },
              {
                label: t("apiKeys.creator"),
                value: apiKeyCreatorLabel(opened.creator, directory, t),
              },
              {
                label: t("apiAccess.column.lastUsed"),
                value: opened.last_used_at
                  ? formatRelativeTime(locale, opened.last_used_at)
                  : t("apiKeys.neverUsed"),
              },
              {
                label: t("apiAccess.column.expires"),
                value: opened.revoked_at
                  ? dateTime(opened.revoked_at)
                  : opened.rotating_out_at
                    ? dateTime(opened.rotating_out_at)
                    : opened.expires_at
                      ? dateTime(opened.expires_at)
                      : t("apiKeys.noExpiry"),
              },
              {
                label: t("apiKeys.prefix"),
                value: <span className="font-mono text-xs">{opened.prefix}</span>,
                help: t("apiKeys.prefixHelp"),
                testId: "api-key-sheet-prefix",
              },
            ]}
          />
        ) : null}
      </RecordSheet>
      <ConfirmDialog
        open={Boolean(rotating)}
        onOpenChange={(next) => !next && setRotating(null)}
        object={keyName(rotating)}
        verb={t("apiKeys.rotate")}
        consequence={t("apiKeys.rotateConsequenceHours", { hours: ROTATE_OVERLAP_MINUTES / 60 })}
        onConfirm={async () => {
          if (rotating) await rotate.mutateAsync(rotating.id).catch(() => undefined);
        }}
        testId="api-key-rotate-dialog"
      />
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(next) => !next && setRevoking(null)}
        object={keyName(revoking)}
        verb={t("apiKeys.revoke")}
        consequence={t("apiKeys.revokeConsequence")}
        destructive
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id).catch(() => undefined);
        }}
        testId="api-key-revoke-dialog"
      />
    </>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (issued: { secret: string; name: string | null }) => Promise<void>;
}) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<KeyScopePreset>("run");
  const picked = keyPresetScopes(preset, session.permissions);
  const missingIntakeScopes = ["intake:read", "intake:write"].filter(
    (scope) => !session.permissions.includes(scope),
  );
  const issue = useMutation({
    mutationFn: () =>
      apiRequest<IssuedApiKey>("/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({
          owner_kind: "user",
          owner_id: session.principal.id,
          name: name.trim(),
          scopes: picked,
        }),
      }),
    onSuccess: async (result) => {
      setName("");
      setPreset("run");
      await client.invalidateQueries({ queryKey: API_KEYS_QUERY });
      await onIssued({ secret: result.plaintext_key, name: result.name });
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("apiKeys.create")}
      submit={{
        label: t("apiKeys.createSubmit"),
        pending: issue.isPending,
        disabled: !name.trim() || picked.length === 0,
      }}
      onSubmit={() => issue.mutate()}
      error={issue.error ? t("apiKeys.actionFailed") : null}
      testId="api-key-create-dialog"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="api-key-name">{t("apiKeys.name")}</FieldLabel>
          <Input
            id="api-key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="api-key-create-name"
          />
        </Field>
        <Field>
          <span className="flex items-center gap-1">
            <FieldLabel>{t("apiKeys.scopes")}</FieldLabel>
            <ContextHelp label={t("apiKeys.scopes")} testId="api-key-scopes-help">
              {t("apiKeys.scopesHint")}
            </ContextHelp>
          </span>
          <SegmentedControl
            value={preset}
            onValueChange={(value) => {
              if (value === "read" || value === "run" || value === "manage") setPreset(value);
            }}
            label={t("apiKeys.scopes")}
            testId="api-key-create-scopes"
            options={[
              { value: "read", label: t("apiKeys.preset.read") },
              { value: "run", label: t("apiKeys.preset.run") },
              { value: "manage", label: t("apiKeys.preset.manage") },
            ]}
          />
          <p className="text-sm text-muted-foreground" data-testid="api-key-preset-permissions">
            {scopeWords(picked, t)}
          </p>
          {missingIntakeScopes.length > 0 ? (
            <p
              className="text-sm text-destructive"
              data-testid="api-key-intake-permission-missing"
              role="status"
            >
              {t("apiKeys.webClipperPermissionsMissing", {
                permissions: missingIntakeScopes.join(", "),
              })}
            </p>
          ) : null}
        </Field>
      </FieldGroup>
    </FormDialog>
  );
}

function IssuedKeyDialog({
  issued,
  onClose,
}: {
  issued: { secret: string; name: string | null } | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  return (
    <FormDialog
      open={Boolean(issued)}
      onOpenChange={(open) => !open && onClose()}
      title={issued?.name ? t("apiKeys.createdNamed", { name: issued.name }) : t("apiKeys.ready")}
      submit={{ label: t("common.done") }}
      onSubmit={onClose}
      testId="secret-dialog"
    >
      <CopyField
        labelled
        value={issued?.secret ?? ""}
        label={t("apiKeys.key")}
        testId="secret-value"
      />
      <p className="text-sm text-muted-foreground" data-testid="secret-once">
        {t("secret.once")}
      </p>
    </FormDialog>
  );
}

function ClientsSection({ query }: { query: UseQueryResult<{ items: ConnectedClientItem[] }> }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canRevoke = session.permissions.includes("mcp_oauth_client:revoke");
  const [revoking, setRevoking] = useState<ConnectedClientItem | null>(null);
  const [opened, setOpened] = useState<ConnectedClientItem | null>(null);
  const revoke = useMutation({
    mutationFn: (clientId: string) =>
      apiRequest<void>(`/v1/oauth/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
    onSuccess: async () => {
      const name = revoking?.client_name || t("connectedClients.unnamed");
      setRevoking(null);
      await client.invalidateQueries({ queryKey: CLIENTS_QUERY });
      toast.success(t("connectedClients.revokedToast", { name }));
    },
    onError: () => toast.error(t("connectedClients.revokeFailed")),
  });

  const columns = useMemo<CockpitColumn<ConnectedClientItem>[]>(() => {
    const column = tableColumns<ConnectedClientItem>({ t, dateTime });
    return [
      column.custom(
        "name",
        (item) => item.client_name,
        t("apiAccess.column.name"),
        (item) => (
          <span className="block truncate font-medium">
            {item.client_name || t("connectedClients.unnamed")}
          </span>
        ),
        { width: "w-[28%]" },
      ),
      column.custom(
        "connected_by",
        (item) => connectedClientActiveSummary(item.connected_by, t).people.join(", "),
        t("apiAccess.column.connectedBy"),
        (item) => {
          const summary = connectedClientActiveSummary(item.connected_by, t);
          return (
            <span className="block space-y-1">
              {summary.people.length ? (
                <span className="block truncate">
                  {summary.people.join(", ")}
                  {summary.moreCount > 0
                    ? ` ${t("connectedClients.moreActivePeople", { count: summary.moreCount })}`
                    : ""}
                </span>
              ) : summary.hasUnknownLegacy ? null : (
                <span className="block">—</span>
              )}
              {summary.hasUnknownLegacy ? (
                <span className="block text-xs text-muted-foreground">
                  {t("connectedClients.unknownLegacy")}
                </span>
              ) : null}
            </span>
          );
        },
        { width: "w-[38%]" },
      ),
      column.date(
        "last_used_at",
        (item) => item.last_used_at ?? null,
        t("connectedClients.lastActive"),
        {
          width: "w-[20%]",
        },
      ),
    ];
  }, [t, dateTime]);

  const groups = groupConnectedClients(query.data?.items ?? []);
  const openedHistory = opened ? connectedClientHistory(opened.connected_by, t) : [];
  const rowLabel = (item: ConnectedClientItem) =>
    t("connectedClients.openRow", { name: item.client_name || t("connectedClients.unnamed") });
  const clientTable = (id: string, rows: ConnectedClientItem[], empty: string) => (
    <ListTable<ConnectedClientItem>
      id={id}
      columns={columns}
      rows={rows}
      pending={query.isPending}
      failed={query.isError}
      resource={t("apiAccess.section.clients")}
      onRetry={() => void query.refetch()}
      empty={empty}
      rowActions={
        canRevoke
          ? (item, index) =>
              !item.disabled_at || item.retired_at ? (
                <span data-action-scope="connected-client">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevoking(item)}
                    data-testid={`connected-client-revoke-${id}-${index}`}
                  >
                    {t("connectedClients.revoke")}
                  </Button>
                </span>
              ) : null
          : undefined
      }
      onOpen={setOpened}
      rowLabel={rowLabel}
    />
  );
  const total = query.data?.items.length ?? 0;

  return (
    <>
      {groups.granted.length > 0 ? (
        <SummaryLine
          testId="api-access-total-clients"
          text={countText(
            t,
            groups.granted.length,
            "apiAccess.total.clientsOne",
            "apiAccess.total.clients",
          )}
          help={t("connectedClients.retirementRule")}
        />
      ) : null}
      {clientTable(
        "connected-clients",
        groups.granted,
        total === 0 ? t("connectedClients.emptyTitle") : t("connectedClients.noneGranted"),
      )}
      {groups.ungranted.length > 0 ? (
        <CollapsibleSection
          label={t("connectedClients.ungranted")}
          count={groups.ungranted.length}
          testId="connected-clients-ungranted"
        >
          {clientTable("connected-clients-ungranted-list", groups.ungranted, "")}
        </CollapsibleSection>
      ) : null}
      {groups.disabled.length > 0 ? (
        <CollapsibleSection
          label={t("connectedClients.disabled")}
          count={groups.disabled.length}
          testId="connected-clients-disabled"
        >
          {clientTable("connected-clients-disabled-list", groups.disabled, "")}
        </CollapsibleSection>
      ) : null}
      <RecordSheet
        dock
        open={opened !== null}
        onOpenChange={(next) => !next && setOpened(null)}
        title={opened?.client_name || t("connectedClients.unnamed")}
        testId="connected-client-sheet"
      >
        {opened ? (
          <FactList
            testId="connected-client-sheet-facts"
            items={
              openedHistory.length
                ? openedHistory.map((line) => ({
                    label: t("apiAccess.column.connectedBy"),
                    value: (
                      <span className="block space-y-1">
                        <span className="block">{line.person}</span>
                        {line.connectedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("connectedClients.connectedAt", {
                              date: dateTime(line.connectedAt),
                            })}
                          </span>
                        ) : null}
                        {line.revokedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("connectedClients.revokedAt", {
                              date: dateTime(line.revokedAt),
                            })}
                          </span>
                        ) : null}
                      </span>
                    ),
                  }))
                : [{ label: t("apiAccess.column.connectedBy"), value: "—" }]
            }
          />
        ) : null}
      </RecordSheet>
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(next) => !next && setRevoking(null)}
        object={t("connectedClients.object", {
          name: revoking?.client_name || t("connectedClients.unnamed"),
        })}
        verb={t("connectedClients.revokeVerb")}
        consequence={t("connectedClients.revokeConsequence")}
        destructive
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.client_id).catch(() => undefined);
        }}
        testId="connected-client-revoke-dialog"
      />
    </>
  );
}
