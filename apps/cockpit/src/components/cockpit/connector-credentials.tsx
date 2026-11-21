import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { ShieldCheck, ShieldExclamationPoint, UserCircle } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  ActionMenu,
  Button,
  ConfirmDialog,
  DataState,
  type DialogError,
  dialogFailure,
  FactList,
  RecordSheet,
  renderAction,
  SectionHeading,
  StatusBadge,
  TechnicalDetails,
  useErrorNotice,
} from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { type ConnectorAuthState, needsRenewal } from "@/lib/connector-auth-state";
import { useI18n } from "@/lib/i18n-context";
import { type ConnectionItem, connectionStateKey } from "@/pages/connections-model";
import {
  credentialBody,
  offersConnectionChoice,
  offersKeyReplacement,
  renewalWay,
  signInLine,
} from "@/pages/connector-detail-model";

type CredentialBody = components["schemas"]["CredentialBody"];

export function useConnectorCredential(connectorId: string | null) {
  return useQuery({
    queryKey: ["connector-credential", connectorId],
    queryFn: () =>
      apiCall("get", "/v1/connectors/{id}/credential", { path: { id: connectorId ?? "" } }),
    enabled: Boolean(connectorId),
  });
}

function useConnections(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => apiCall("get", "/v1/connections", {}),
    enabled,
  });
}

function CredentialSheet({
  open,
  onOpenChange,
  connectorId,
  connectorName,
  authType,
  headerNames,
  storedAt,
  choosesConnection,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  connectorId: string;
  connectorName: string;
  authType: string | null;
  headerNames: readonly string[];
  storedAt: string | null;
  choosesConnection: boolean;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [secret, setSecret] = useState("");
  const [typedHeader, setHeader] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<DialogError>(null);
  const failure = useErrorNotice({
    error: error && typeof error !== "string" ? error.cause : undefined,
    tone: typeof error === "string" ? "warn" : "error",
  });
  const header = typedHeader ?? headerNames[0] ?? "";
  const connections = useConnections(open && choosesConnection);
  const items = connections.data?.items ?? [];
  const replacesKey = offersKeyReplacement(authType);
  const close = () => {
    setSecret("");
    setHeader(null);
    setChosen("");
    setError(null);
    onOpenChange(false);
  };
  const save = useMutation({
    mutationFn: (body: CredentialBody) =>
      apiCall("post", "/v1/connectors/{id}/credentials", { path: { id: connectorId }, body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["connector-credential", connectorId] });
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", connectorId] });
      await client.invalidateQueries({ queryKey: ["admin", "connections"] });
      toast.success(t("connectorPage.credentials.replaced"));
      close();
    },
    onError: (failure) => setError(dialogFailure(t("connectorCredentials.saveFailed"), failure)),
  });
  const submit = () => {
    if (choosesConnection) {
      if (!chosen) return setError(t("connectorPage.credentials.chooseMissing"));
      return save.mutate({ mode: "connection", connection_id: chosen });
    }
    const body = credentialBody(authType, secret, header);
    if (!body)
      return setError(
        t(
          authType === "header" && !header.trim()
            ? "create.template.headerMissing"
            : "create.connector.secretMissing",
        ),
      );
    save.mutate(body);
  };
  return (
    <RecordSheet
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={t("connectorEdit.secret")}
      subtitle={connectorName}
      testId="connector-credential-sheet"
      closeTestId="connector-credential-sheet-close"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {t(
            choosesConnection
              ? "connectorPage.credentials.connectionLine"
              : "connectorPage.credentials.replaceLine",
          )}
        </p>
        {choosesConnection ? (
          <SelectField
            id="connector-connection"
            label={t("connectorCredentials.choose")}
            value={chosen}
            onChange={setChosen}
            help={
              items.length === 0
                ? t("connectorCredentials.noConnections")
                : t("connectorCredentials.chooseHint")
            }
            options={[
              { value: "", label: t("connectorCredentials.choosePlaceholder") },
              ...items.map((item) => ({
                value: item.id,
                label: item.service_name ? `${item.service_name} · ${item.name}` : item.name,
              })),
            ]}
          />
        ) : null}
        {!choosesConnection && authType === "header" ? (
          <TextField
            id="connector-credential-header"
            label={t("connectorCredentials.headerName")}
            value={header}
            onChange={setHeader}
            mono
          />
        ) : null}
        {!choosesConnection && replacesKey ? (
          <TextField
            id="connector-credential-secret"
            type="password"
            label={t(
              authType === "signed_jwt"
                ? "connectorEdit.signedJwtPrivateKey"
                : "connectorPage.credentials.newKey",
            )}
            placeholder={t("create.connector.secretPlaceholder")}
            help={t("connectorDetail.connection.secretKept")}
            value={secret}
            onChange={setSecret}
          />
        ) : null}
        {error ? (
          <ErrorNotice
            {...failure}
            title={typeof error === "string" ? error : error.text}
            actions={
              typeof error === "string"
                ? undefined
                : renderAction({
                    label: t("pattern.retry"),
                    variant: "primary",
                    size: "sm",
                    onClick: submit,
                    testId: "connector-credential-error-retry",
                  })
            }
            testId="connector-credential-error"
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} data-testid="connector-credential-cancel">
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={save.isPending}
            data-testid={
              choosesConnection ? "connector-connection-apply" : "connector-credential-save"
            }
          >
            {t("connectorPage.credentials.replace")}
          </Button>
        </div>
        {headerNames.length > 0 || storedAt ? (
          <TechnicalDetails testId="connector-credential-technical">
            <FactList
              items={[
                ...(headerNames.length > 0
                  ? [
                      {
                        label: t("connectorCredentials.headerName"),
                        value: <span className="font-mono text-xs">{headerNames.join(", ")}</span>,
                      },
                    ]
                  : []),
                ...(storedAt
                  ? [{ label: t("connectorPage.credentials.storedAt"), value: dateTime(storedAt) }]
                  : []),
              ]}
            />
          </TechnicalDetails>
        ) : null}
      </div>
    </RecordSheet>
  );
}

export function ConnectorCredentials({
  connectorId,
  connectorName,
  authType,
  headerNames,
  signsInAtProvider,
  state,
  canWrite,
  replacing,
  onReplacing,
  providerUrl = null,
}: {
  connectorId: string;
  connectorName: string;
  authType: string | null;
  headerNames: readonly string[];
  signsInAtProvider: boolean;
  state: ConnectorAuthState;
  canWrite: boolean;
  replacing: boolean;
  onReplacing(open: boolean): void;
  providerUrl?: string | null;
}) {
  const { t, dateTime } = useI18n();
  const summary = useConnectorCredential(connectorId);
  const current = summary.data ?? null;
  const choosesConnection = offersConnectionChoice(authType, current?.mode ?? null);
  const replaceable = canWrite && (choosesConnection || offersKeyReplacement(authType));
  const way = renewalWay({
    authType,
    signsInAtProvider,
    usesConnection: Boolean(current?.connection),
    canWrite,
  });
  const hint = signInLine(state, way);
  const lost = needsRenewal(state);
  const missingScopes = current?.missing_scopes ?? [];
  const line = current?.connection
    ? t("connectorCredentials.viaConnectionState", {
        name: current.connection.name,
        state: t(connectionStateKey(current.connection.state)),
      })
    : current
      ? t("connectorCredentials.stored", { date: dateTime(current.updated_at) })
      : t("connectorPage.credentials.none");
  return (
    <section
      id="connector-credentials"
      className="flex scroll-mt-6 flex-col gap-2"
      data-testid="connector-credentials"
    >
      <SectionHeading>{t("connectorCredentials.credentials")}</SectionHeading>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 text-sm"
        data-testid="connector-credential"
      >
        {current && !lost ? (
          <ShieldCheck aria-hidden="true" className="size-4 text-emerald-600" />
        ) : (
          <ShieldExclamationPoint aria-hidden="true" className="size-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1" data-testid="connector-credential-stored">
          {line}
        </span>
        {lost && providerUrl ? (
          <ActionMenu
            items={[
              {
                label: t("connectorCredentials.openProvider"),
                href: providerUrl,
                testId: "connector-provider-page",
              },
            ]}
          />
        ) : null}
        {replaceable ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReplacing(true)}
            data-testid="connector-credential-replace"
          >
            {t("connectorPage.credentials.replace")}
          </Button>
        ) : null}
      </div>
      <p
        className="min-h-4 text-xs text-muted-foreground"
        data-testid={hint && state !== "unproven" ? "connector-credential-hint" : undefined}
        data-slot="connector-credential-hint"
      >
        {hint && state !== "unproven" ? t(hint, { name: current?.connection?.name ?? "" }) : null}
      </p>
      {missingScopes.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="connector-missing-scopes">
          {t(
            missingScopes.length === 1
              ? "connectorPage.credentials.missingScopes.one"
              : "connectorPage.credentials.missingScopes.other",
            { count: missingScopes.length },
          )}
        </p>
      ) : null}
      {replaceable ? (
        <CredentialSheet
          open={replacing}
          onOpenChange={onReplacing}
          connectorId={connectorId}
          connectorName={connectorName}
          authType={authType}
          headerNames={headerNames}
          storedAt={current?.updated_at ?? null}
          choosesConnection={choosesConnection}
        />
      ) : null}
    </section>
  );
}

const CONNECTION_BADGE: Record<ConnectionItem["state"], string> = {
  valid: "ok",
  expiring: "expiring",
  expired: "expired",
  unreadable: "error",
};

export function ConnectorAccounts({
  connectorId,
  canWrite,
  emptyAction,
}: {
  connectorId: string;
  canWrite: boolean;
  emptyAction?: ReactNode;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [disconnect, setDisconnect] = useState<ConnectionItem | null>(null);
  const query = useConnections(true);
  const rows = (query.data?.items ?? []).filter((item) =>
    item.used_by.some((user) => user.connector_id === connectorId),
  );
  const remove = useMutation({
    mutationFn: (id: string) => apiCall("delete", "/v1/connections/{id}", { path: { id } }),

    onSuccess: async () => {
      const name = disconnect?.name ?? "";
      setDisconnect(null);
      await client.invalidateQueries({ queryKey: ["admin", "connections"] });
      await client.invalidateQueries({ queryKey: ["connector-credential", connectorId] });
      toast.success(t("connections.disconnected", { name }));
    },
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
  });
  return (
    <section className="flex flex-col gap-2" data-testid="connector-account-connections">
      <SectionHeading>{t("connectorPage.accounts")}</SectionHeading>
      {query.error ? (
        <DataState
          state="error"
          line={t("connections.loadFailed")}
          error={query.error}
          onRetry={() => void query.refetch()}
          testId="connector-accounts"
        />
      ) : query.isPending ? null : rows.length === 0 ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-sm"
          data-testid="connector-accounts-empty"
        >
          <span className="flex-1 text-muted-foreground">{t("connectorPage.accountsEmpty")}</span>
          {emptyAction}
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
              data-testid={`connector-account-${index}`}
            >
              <UserCircle aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{row.service_name ?? row.name}</span>
              {row.expires_at ? (
                <span className="text-xs text-muted-foreground">
                  {t(
                    row.state === "expired"
                      ? "connectorPage.accountExpiredAt"
                      : "connectorPage.accountValidUntil",
                    { when: dateTime(row.expires_at) },
                  )}
                </span>
              ) : null}
              <StatusBadge
                state={CONNECTION_BADGE[row.state]}
                label={t(connectionStateKey(row.state))}
              />
              {canWrite ? (
                <span data-action-scope="connection">
                  <ActionMenu
                    items={[
                      {
                        label: t("connections.disconnect"),
                        onSelect: () => setDisconnect(row),
                        destructive: true,
                        testId: `connector-account-${index}-disconnect`,
                      },
                    ]}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={disconnect !== null}
        onOpenChange={(next) => !next && !remove.isPending && setDisconnect(null)}
        object={t("connectorPage.accountConnection")}
        verb={t("connections.disconnect")}
        consequence={t("connectorPage.disconnectConsequence")}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (disconnect) await remove.mutateAsync(disconnect.id).catch(() => undefined);
        }}
        testId="connector-account-disconnect"
      />
    </section>
  );
}
