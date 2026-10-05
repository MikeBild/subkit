import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { ActionMenu, type Fact, FactList, StatusBadge } from "@/components/cockpit/patterns";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { offersConnectionChoice, renewalWay, signInLine } from "@/pages/connector-detail-model";

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
  providerUrl = null,
  stateInStrip = false,
}: {
  connectorId: string;
  authType: string | null;
  signsInAtProvider: boolean;
  state: ConnectorAuthState;
  canWrite: boolean;
  providerUrl?: string | null;
  stateInStrip?: boolean;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string>("");

  const summary = useConnectorCredential(connectorId);
  const current = summary.data ?? null;
  const choice = offersConnectionChoice(authType, current?.mode ?? null);
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
  const where = current?.connection
    ? t("connectorCredentials.viaConnectionState", {
        name: current.connection.name,
        state: t(connectionStateKey(current.connection.state)),
      })
    : current
      ? t("connectorCredentials.stored", { date: dateTime(current.updated_at) })
      : null;
  const help = [
    line ? t(line, { name: current?.connection?.name ?? "" }) : null,
    current && !current.connection ? t("connectorCredentials.neverShown") : null,
  ]
    .filter(Boolean)
    .join(" ");

  const facts: Fact[] = [
    {
      label: t("connectorCredentials.credentials"),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          {stateInStrip ? null : (
            <StatusBadge
              state={BADGE_STATE[state]}
              label={t(authStateLabel(state))}
              testId="connector-auth-state"
            />
          )}
          {where ? <span data-testid="connector-credential-stored">{where}</span> : null}
        </span>
      ),
      ...(help ? { help } : {}),
      testId: "connector-credential",
    },
    ...(missingScopes.length > 0
      ? [
          {
            label: t("connectorCredentials.missingScopes"),
            value: <span className="font-mono text-xs">{missingScopes.join(", ")}</span>,
            testId: "connector-missing-scopes",
          },
        ]
      : []),
  ];

  return (
    <div
      id="connector-credentials"
      className="flex scroll-mt-6 flex-col gap-3"
      data-testid="connector-credentials"
    >
      <FactList items={facts} testId="connector-credential-facts" />
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
      {canWrite && choice ? (
        <Field>
          <FieldLabel htmlFor="connector-connection">{t("connectorCredentials.choose")}</FieldLabel>
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
    </div>
  );
}
