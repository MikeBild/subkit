import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { Section, StatusBadge } from "@/components/cockpit/patterns";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authStateLabel, type ConnectorAuthState, needsRenewal } from "@/lib/connector-auth-state";
import { useI18n } from "@/lib/i18n-context";
import { type ConnectionItem, connectionStateKey } from "@/pages/connections-model";
import {
  credentialBody,
  offersConnectionChoice,
  offersKeyReplacement,
  renewalWay,
  signInLine,
} from "@/pages/connector-detail-model";

export type ConnectorCredentialSummary = NonNullable<
  components["schemas"]["ConnectorCredentialSummary"]
>;

export function useConnectorCredential(connectorId: string | null) {
  return useQuery({
    queryKey: ["connector-credential", connectorId],
    queryFn: () =>
      apiRequest<ConnectorCredentialSummary | null>(
        `/v1/connectors/${encodeURIComponent(connectorId ?? "")}/credential`,
      ),
    enabled: Boolean(connectorId),
  });
}

const BADGE_STATE: Record<ConnectorAuthState, string> = {
  connected: "ok",
  expired: "expired",
  credentials_missing: "error",
  not_required: "neutral",
  unproven: "pending",
};

export function ConnectorCredentials({
  connectorId,
  authType,
  signsInAtProvider,
  state,
  canWrite,
  showKey,
  onShowKey,
  providerUrl = null,
  stateInStrip = false,
}: {
  connectorId: string;
  authType: string | null;
  signsInAtProvider: boolean;
  state: ConnectorAuthState;
  canWrite: boolean;
  showKey: boolean;
  onShowKey: (open: boolean) => void;
  providerUrl?: string | null;
  stateInStrip?: boolean;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string>("");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState<string | null>(null);

  const summary = useConnectorCredential(connectorId);
  const current = summary.data ?? null;
  const choice = offersConnectionChoice(authType, current?.mode ?? null);
  const replaceable = offersKeyReplacement(authType);
  const connections = useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => apiRequest<{ items: ConnectionItem[] }>("/v1/connections"),
    enabled: canWrite && choice,
  });
  const attach = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<{ id: string }>(`/v1/connectors/${encodeURIComponent(connectorId)}/credentials`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      setToken("");
      onShowKey(false);
      await client.invalidateQueries({ queryKey: ["connector-credential", connectorId] });
      await client.invalidateQueries({ queryKey: ["admin", "connections"] });
      toast.success(t("connectorCredentials.saved"));
    },
    onError: () => toast.error(t("connectorCredentials.saveFailed")),
  });

  const items = connections.data?.items ?? [];
  const lost = needsRenewal(state);
  const way = renewalWay({
    authType,
    signsInAtProvider,
    usesConnection: Boolean(current?.connection),
    canWrite,
  });
  const line = signInLine(state, way);
  const missingScopes = current?.missing_scopes ?? [];
  const about = current?.connection
    ? t("connectorCredentials.viaConnection", { name: current.connection.name })
    : null;
  const header = headerName ?? current?.header_names?.[0] ?? "";
  const body = credentialBody(authType, token, header);
  const muted = "text-sm text-muted-foreground";

  return (
    <div id="connector-credentials" className="scroll-mt-6" data-testid="connector-credentials">
      <Section
        label={t("connectorCredentials.title")}
        aside={
          stateInStrip ? undefined : (
            <StatusBadge
              state={BADGE_STATE[state]}
              label={t(authStateLabel(state))}
              testId="connector-auth-state"
            />
          )
        }
      >
        {lost && line ? (
          <p className={muted} data-testid="connector-credential-sentence">
            {t(line, { name: current?.connection?.name ?? "" })}
          </p>
        ) : about || line ? (
          <p className={muted} data-testid="connector-credential-sentence">
            {[about, line ? t(line) : null].filter(Boolean).join(" ")}
          </p>
        ) : null}
        {missingScopes.length > 0 ? (
          <p className="text-sm" data-testid="connector-missing-scopes">
            {t("connectorCredentials.partial", { scopes: missingScopes.join(", ") })}
          </p>
        ) : null}
        {current && !current.connection ? (
          <p className={muted} data-testid="connector-credential-stored">
            {t("connectorCredentials.stored", { date: dateTime(current.updated_at) })}
          </p>
        ) : null}
        {current?.connection ? (
          <p className={muted} data-testid="connector-connection">
            {t("connectorCredentials.connectionState", {
              state: t(connectionStateKey(current.connection.state)),
            })}
          </p>
        ) : null}
        {lost && providerUrl ? (
          <a
            href={providerUrl}
            target="_blank"
            rel="noreferrer"
            className="w-fit text-sm underline underline-offset-4"
            data-testid="connector-provider-page"
          >
            {t("connectorCredentials.openProvider")}
          </a>
        ) : null}
        {canWrite && choice ? (
          <Field>
            <FieldLabel htmlFor="connector-connection">
              {t("connectorCredentials.choose")}
            </FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={chosen} onValueChange={setChosen}>
                <SelectTrigger
                  id="connector-connection"
                  className="sm:w-72"
                  data-testid="connector-connection-select"
                >
                  <SelectValue placeholder={t("connectorCredentials.choosePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem
                      key={item.id}
                      value={item.id}
                      data-testid={`connector-connection-option-${item.name}`}
                    >
                      {item.service_name ? `${item.service_name} · ${item.name}` : item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={!chosen || attach.isPending}
                onClick={() => attach.mutate({ mode: "connection", connection_id: chosen })}
                data-testid="connector-connection-apply"
              >
                {t("connectorCredentials.use")}
              </Button>
            </div>
            <FieldDescription>
              {items.length === 0
                ? t("connectorCredentials.noConnections")
                : t("connectorCredentials.chooseHint")}
            </FieldDescription>
          </Field>
        ) : null}
        {canWrite && replaceable && showKey ? (
          <div className="flex flex-col gap-3" data-testid="connector-key-form">
            {authType === "header" ? (
              <Field>
                <FieldLabel htmlFor="connector-key-header">
                  {t("connectorCredentials.headerName")}
                </FieldLabel>
                <Input
                  id="connector-key-header"
                  autoComplete="off"
                  value={header}
                  className="font-mono sm:w-72"
                  onChange={(event) => setHeaderName(event.target.value)}
                  data-testid="connector-key-header"
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="connector-key">{t("connectorCredentials.key")}</FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="connector-key"
                  type="password"
                  autoComplete="off"
                  value={token}
                  className="sm:w-72"
                  onChange={(event) => setToken(event.target.value)}
                  data-testid="connector-key-input"
                />
                <Button
                  variant="outline"
                  disabled={!body || attach.isPending}
                  onClick={() => body && attach.mutate(body)}
                  data-testid="connector-key-save"
                >
                  {t("common.save")}
                </Button>
              </div>
              <FieldDescription>{t("connectorCredentials.keyHint")}</FieldDescription>
            </Field>
          </div>
        ) : canWrite && replaceable && !lost ? (
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => onShowKey(true)}
            data-testid="connector-key-toggle"
          >
            {t("connectorCredentials.replaceKey")}
          </Button>
        ) : null}
      </Section>
    </div>
  );
}
