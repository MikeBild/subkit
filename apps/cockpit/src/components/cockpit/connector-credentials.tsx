import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, apiAccessHref } from "@/app/links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  signInActionLabel,
  signInLine,
} from "@/pages/connector-detail-model";

export type ConnectorCredentialSummary = NonNullable<
  components["schemas"]["ConnectorCredentialSummary"]
>;

/**
 * The connector's credential as the engine describes it — mode, the header
 * names a key is sent in, and the Kontoverbindung it sends with that
 * connection's state. One query key, read by the governance bar, the
 * "Verbindung" facts and the Anmeldung card alike, so they can never disagree
 * about where the sign-in stands.
 */
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

/**
 * "Anmeldung": where the sign-in stands — the one place the page says it —
 * one line for what is the case and what the action beside it does, when the
 * credential was last changed, and the one way to change it that fits its
 * kind of sign-in. HOW the connector signs in is a fact of the connection and
 * stands there ("Verbindung"), not a second time here. "Verbindung wählen" is offered only where a connection can
 * carry the sign-in (OAuth, or a connector already linked to one); "Schlüssel
 * ersetzen" posts the key in the mode the connector signs in with — a key sent
 * in `X-API-KEY` stays a header key instead of turning into a bearer token.
 */
export function ConnectorCredentials({
  connectorId,
  authType,
  state,
  canWrite,
  providerUrl = null,
}: {
  connectorId: string;
  authType: string | null;
  state: ConnectorAuthState;
  canWrite: boolean;
  /** Where the provider renews access, when a failed test named such a page. */
  providerUrl?: string | null;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string>("");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

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
      setShowKey(false);
      await client.invalidateQueries({ queryKey: ["connector-credential", connectorId] });
      await client.invalidateQueries({ queryKey: ["admin", "connections"] });
      toast.success(t("connectorCredentials.saved"));
    },
    onError: () => toast.error(t("connectorCredentials.saveFailed")),
  });
  // The connector's own OAuth sign-in: the engine mints the authorization URL
  // and the provider brings the browser back to its callback.
  const oauthStart = useMutation({
    mutationFn: () =>
      apiRequest<{ authorization_url: string }>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/oauth/start`,
        { method: "POST" },
      ),
    onSuccess: (result) => window.location.assign(result.authorization_url),
    onError: () => toast.error(t("connectorCredentials.renewFailed")),
  });

  const items = connections.data?.items ?? [];
  const lost = needsRenewal(state);
  const way = renewalWay({ authType, usesConnection: Boolean(current?.connection), canWrite });
  const line = signInLine(state, way);
  const renewLabel = t(signInActionLabel(state));
  const missingScopes = current?.missing_scopes ?? [];
  const grantsHref = absolute(apiAccessHref("grants"));
  // The account connections page is one address: it is linked once. The
  // renewal leads there when the sign-in rides on a lost connection; otherwise
  // the connection's own line does; otherwise the chooser's hint.
  const grantsLink: "renew" | "connection" | "chooser" =
    lost && way === "connection" ? "renew" : current?.connection ? "connection" : "chooser";
  const about = current?.connection
    ? t("connectorCredentials.viaConnection", { name: current.connection.name })
    : null;
  // The header the key goes in, pre-filled with the one the engine reports.
  const header = headerName ?? current?.header_names?.[0] ?? "";
  const body = credentialBody(authType, token, header);

  return (
    // The anchor "Neu verbinden" lands on, from the run dialog.
    <Card id="connector-credentials" className="scroll-mt-6" data-testid="connector-credentials">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("connectorCredentials.title")}
          <Badge
            variant={lost ? "destructive" : state === "connected" ? "secondary" : "outline"}
            data-testid="connector-auth-state"
          >
            {t(authStateLabel(state))}
          </Badge>
        </CardTitle>
        {/* A lost sign-in says what is the case and what the button does — one
            line. A working one needs no sentence: the badge says it. */}
        {lost && line ? (
          <CardDescription data-testid="connector-credential-sentence">
            {t(line, { name: current?.connection?.name ?? "" })}
          </CardDescription>
        ) : about || line ? (
          <CardDescription data-testid="connector-credential-sentence">
            {[about, line ? t(line) : null].filter(Boolean).join(" ")}
          </CardDescription>
        ) : null}
        {missingScopes.length > 0 ? (
          <p className="text-sm" data-testid="connector-missing-scopes">
            {t("connectorCredentials.partial", { scopes: missingScopes.join(", ") })}
          </p>
        ) : null}
        {current && !current.connection ? (
          <p className="text-sm text-muted-foreground" data-testid="connector-credential-stored">
            {t("connectorCredentials.stored", { date: dateTime(current.updated_at) })}
          </p>
        ) : null}
        {current?.connection ? (
          <p className="text-sm" data-testid="connector-connection">
            <span className="text-muted-foreground">
              {t("connectorCredentials.connectionState", {
                state: t(connectionStateKey(current.connection.state)),
              })}
            </span>
            {grantsLink === "connection" ? (
              <>
                {" "}
                <a
                  href={grantsHref}
                  className="font-medium underline underline-offset-4"
                  data-testid="connector-connection-link"
                >
                  {t("connectorCredentials.openConnection")}
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </CardHeader>
      {canWrite &&
      ((lost && (way || providerUrl)) || missingScopes.length > 0 || choice || replaceable) ? (
        <CardContent className="grid gap-4">
          {/* The one way to renew a lost sign-in. What it does is said in the
              line under the title, so the button stands alone. */}
          {lost && way === "connection" ? (
            <Button asChild className="w-fit">
              <a href={grantsHref} data-testid="connector-renew-signin">
                {renewLabel}
              </a>
            </Button>
          ) : way === "provider" && (lost || missingScopes.length > 0) ? (
            // Withheld permissions are granted the same way: by signing in
            // again. Not the page's filled action — the sign-in works.
            <Button
              variant={lost ? "default" : "outline"}
              className="w-fit"
              disabled={oauthStart.isPending}
              onClick={() => oauthStart.mutate()}
              data-testid="connector-renew-signin"
            >
              {renewLabel}
            </Button>
          ) : lost && way === "key" && !showKey ? (
            <Button
              className="w-fit"
              onClick={() => setShowKey(true)}
              data-testid="connector-renew-signin"
            >
              {renewLabel}
            </Button>
          ) : null}
          {/* Where the provider itself renews access — its own page, a
              different place than the sign-in, named as one. */}
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
          {choice ? (
            <Field>
              <FieldLabel htmlFor="connector-connection">
                {t("connectorCredentials.choose")}
              </FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={chosen} onValueChange={setChosen}>
                  <SelectTrigger
                    id="connector-connection"
                    className="sm:max-w-xs"
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
                        {item.service_name ?? item.name}
                        <Badge variant="secondary" className="ml-2">
                          {item.name}
                        </Badge>
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
                {grantsLink === "chooser" ? (
                  <>
                    {" "}
                    <a
                      href={grantsHref}
                      className="underline"
                      data-testid="connector-connections-link"
                    >
                      {t("connectorCredentials.openConnections")}
                    </a>
                  </>
                ) : null}
              </FieldDescription>
            </Field>
          ) : null}
          {replaceable && showKey ? (
            <div className="grid gap-3" data-testid="connector-key-form">
              {authType === "header" ? (
                <Field>
                  <FieldLabel htmlFor="connector-key-header">
                    {t("connectorCredentials.headerName")}
                  </FieldLabel>
                  <Input
                    id="connector-key-header"
                    autoComplete="off"
                    value={header}
                    className="font-mono sm:max-w-xs"
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
                    className="sm:max-w-xs"
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
          ) : replaceable && !lost ? (
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => setShowKey(true)}
              data-testid="connector-key-toggle"
            >
              {t("connectorCredentials.replaceKey")}
            </Button>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
