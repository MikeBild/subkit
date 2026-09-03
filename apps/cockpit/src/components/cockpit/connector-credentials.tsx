import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
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
import { useI18n } from "@/lib/i18n-context";
import type { ConnectionItem } from "@/pages/connections-model";

interface CredentialSummary {
  mode: string;
  environment: "dev" | "prod";
  connection: { id: string; name: string } | null;
  updated_at: string;
}

/**
 * How a connector authenticates, decided on its own page: pick a connection
 * ("Verbindung wählen") — or, only for a provider that cannot grant access
 * itself, paste a key, and the card says so.
 */
export function ConnectorCredentials({
  connectorId,
  canWrite,
}: {
  connectorId: string;
  canWrite: boolean;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string>("");
  const [token, setToken] = useState("");
  const [showKey, setShowKey] = useState(false);

  const summary = useQuery({
    queryKey: ["connector-credential", connectorId],
    queryFn: () =>
      apiRequest<CredentialSummary | null>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/credential`,
      ),
  });
  const connections = useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => apiRequest<{ items: ConnectionItem[] }>("/v1/connections"),
    enabled: canWrite,
  });
  const attach = useMutation({
    mutationFn: (body: Record<string, string>) =>
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

  const current = summary.data ?? null;
  const items = connections.data?.items ?? [];

  return (
    <Card data-testid="connector-credentials">
      <CardHeader>
        <CardTitle>{t("connectorCredentials.title")}</CardTitle>
        <CardDescription>
          {current?.connection
            ? t("connectorCredentials.viaConnection", { name: current.connection.name })
            : current
              ? t("connectorCredentials.viaKey", {
                  mode: current.mode,
                  date: dateTime(current.updated_at),
                })
              : t("connectorCredentials.none")}
        </CardDescription>
      </CardHeader>
      {canWrite && (
        <CardContent className="grid gap-4">
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
                : t("connectorCredentials.chooseHint")}{" "}
              <a
                href="/cockpit/connections"
                className="underline"
                data-testid="connector-connections-link"
              >
                {t("connectorCredentials.openConnections")}
              </a>
            </FieldDescription>
          </Field>
          {showKey ? (
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
                  disabled={!token.trim() || attach.isPending}
                  onClick={() => attach.mutate({ mode: "bearer", token: token.trim() })}
                  data-testid="connector-key-save"
                >
                  {t("common.save")}
                </Button>
              </div>
              <FieldDescription>{t("connectorCredentials.keyHint")}</FieldDescription>
            </Field>
          ) : (
            <Button
              variant="link"
              className="w-fit px-0"
              onClick={() => setShowKey(true)}
              data-testid="connector-key-toggle"
            >
              {t("connectorCredentials.enterKey")}
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}
