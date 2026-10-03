import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, connectorHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ListTable } from "@/components/cockpit/list-table";
import {
  Button,
  Checkbox,
  type CockpitColumn,
  ConfirmDialog,
  ContextHelp,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormDialog,
  Input,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type ConnectionItem,
  connectionFailureKey,
  connectionNeedsRenewal,
  connectionReasonKey,
  connectionStateKey,
  type DiscoveryItem,
  parseTypedScopes,
  suggestConnectionName,
} from "@/pages/connections-model";

export const CONNECTIONS_QUERY = ["admin", "connections"] as const;

type Translate = ReturnType<typeof useI18n>["t"];

function failureSentence(error: unknown, t: Translate): string {
  if (error instanceof ApiError && error.status === 409) return t("connections.failure.nameTaken");
  const code = error instanceof ApiError ? (error.message.split(":")[0] ?? null) : null;
  return t(connectionFailureKey(code));
}

/**
 * The systems SubKit may call on someone's behalf: one row per account
 * connection with its state, who uses it, and "Erneuern" / "Trennen". Adding
 * one is the page's action (`ConnectDialog`); the list says how many there are
 * and nothing else above itself.
 */
export function AccountConnections({
  query,
  emptyAction,
}: {
  query: UseQueryResult<{ items: ConnectionItem[] }>;
  /** The page's action, standing in the empty list instead of the header. */
  emptyAction?: ReactNode;
}) {
  const { t, locale, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("connection:write");
  const [disconnect, setDisconnect] = useState<ConnectionItem | null>(null);

  const renew = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ authorization_url: string }>(`/v1/connections/${encodeURIComponent(id)}/renew`, {
        method: "POST",
      }),
    onSuccess: (result) => window.location.assign(result.authorization_url),
    onError: (error) => toast.error(failureSentence(error, t)),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_result, id) => {
      const name = disconnect?.name ?? id;
      setDisconnect(null);
      await client.invalidateQueries({ queryKey: CONNECTIONS_QUERY });
      toast.success(t("connections.disconnected", { name }));
    },
    onError: (error) => toast.error(failureSentence(error, t)),
  });

  const items = query.data?.items ?? [];
  const columns = useMemo<CockpitColumn<ConnectionItem>[]>(() => {
    const column = tableColumns<ConnectionItem>({ t, dateTime });
    return [
      column.custom(
        "service",
        (item) => item.service_name ?? item.name,
        t("connections.name"),
        (item) => <span className="block truncate">{item.service_name ?? item.name}</span>,
        { width: "w-[20%]" },
      ),
      column.custom(
        "state",
        (item) => item.state,
        t("apiAccess.column.state"),
        (item, index) => (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1" data-testid={`connection-state-${index}`}>
              <StatusBadge
                state={item.state}
                label={
                  item.state === "expiring" && item.expires_at
                    ? t("connections.state.expiringAt", { date: dateTime(item.expires_at) })
                    : t(connectionStateKey(item.state))
                }
              />
              {item.state === "expiring" ? (
                <ContextHelp
                  label={t(connectionStateKey(item.state))}
                  testId={`connection-no-auto-renew-${index}`}
                >
                  {t("connections.noAutoRenew")}
                </ContextHelp>
              ) : null}
            </span>
            {/* A lost grant says its cause on its own row, in one line. */}
            {connectionNeedsRenewal(item) && item.state_reason ? (
              <span data-testid={`connection-why-${index}`}>
                <p className="text-xs whitespace-normal text-destructive">
                  {t(connectionReasonKey(item.state_reason))}
                </p>
              </span>
            ) : null}
          </span>
        ),
        { width: "w-[28%]", interactive: true },
      ),
      column.custom(
        "rights",
        (item) => (item.granted_scopes ?? item.scopes).length,
        t("connections.scopes"),
        (item, index) => {
          const scopes = item.granted_scopes ?? item.scopes;
          if (scopes.length === 0) return "—";
          // The other system's own strings, behind (?): SubKit cannot judge a
          // foreign right, so it counts them and names no risk.
          return (
            <span className="flex items-center gap-1">
              <span data-testid={`connection-rights-count-${index}`}>
                {scopes.length === 1
                  ? t("connections.rightsOne")
                  : t("connections.rights", { count: String(scopes.length) })}
              </span>
              <ContextHelp label={t("connections.scopes")} testId={`connection-rights-${index}`}>
                <span className="font-mono">{scopes.join(" ")}</span>
              </ContextHelp>
            </span>
          );
        },
        { width: "w-[14%]", interactive: true },
      ),
      column.custom(
        "used_by",
        (item) => item.used_by.length,
        t("connections.usedByLabel"),
        (item, index) =>
          item.used_by.length === 0 ? (
            <span className="text-muted-foreground">{t("connections.notUsed")}</span>
          ) : (
            <span className="block truncate" data-testid={`connection-used-by-${index}`}>
              {item.used_by.map((user, userIndex) => (
                <span key={user.connector_id}>
                  {userIndex > 0 ? ", " : null}
                  <a
                    href={absolute(connectorHref(user.connector_id))}
                    className="underline-offset-4 hover:underline"
                    data-testid={`connection-used-by-${index}-${userIndex}`}
                  >
                    {user.display_name}
                  </a>
                </span>
              ))}
            </span>
          ),
        { width: "w-[22%]", interactive: true },
      ),
      column.custom(
        "last_used_at",
        (item) => item.last_used_at,
        t("apiAccess.column.lastUsed"),
        (item) =>
          item.last_used_at
            ? formatRelativeTime(locale, item.last_used_at)
            : t("connections.neverUsed"),
        { width: "w-[16%]" },
      ),
    ];
  }, [t, dateTime, locale]);

  return (
    <>
      {items.length > 0 ? (
        <SummaryLine
          testId="api-access-total-grants"
          text={
            items.length === 1
              ? t("apiAccess.total.grantsOne")
              : t("apiAccess.total.grants", { count: String(items.length) })
          }
        />
      ) : null}
      <ListTable
        id="connections"
        columns={columns}
        rows={items}
        pending={query.isPending}
        failed={query.isError}
        resource={t("apiAccess.section.grants")}
        onRetry={() => void query.refetch()}
        empty={t("connections.emptyTitle")}
        emptyAction={emptyAction}
        rowActions={
          canWrite
            ? (item, index) => (
                <span data-action-scope="connection" className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={renew.isPending && renew.variables === item.id}
                    onClick={() => renew.mutate(item.id)}
                    data-testid={`connection-renew-${index}`}
                  >
                    {t("connections.renew")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDisconnect(item)}
                    data-testid={`connection-disconnect-${index}`}
                  >
                    {t("connections.disconnect")}
                  </Button>
                </span>
              )
            : undefined
        }
      />
      <ConfirmDialog
        open={Boolean(disconnect)}
        onOpenChange={(next) => !next && setDisconnect(null)}
        object={disconnect?.name ?? ""}
        verb={t("connections.disconnect")}
        consequence={
          disconnect && disconnect.used_by.length > 0
            ? t("connections.disconnectInUse", {
                count: String(disconnect.used_by.length),
                connectors: disconnect.used_by.map((user) => user.display_name).join(", "),
              })
            : t("connections.disconnectDescription")
        }
        destructive
        onConfirm={async () => {
          if (disconnect) await remove.mutateAsync(disconnect.id).catch(() => undefined);
        }}
        testId="connection-disconnect-dialog"
      />
    </>
  );
}

/**
 * Three steps in one dialog: the address, what the address said, the rights.
 * The dialog ends by leaving the page — the last step happens on the other
 * side, and the other side brings the browser back.
 */
export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [typedScopes, setTypedScopes] = useState("");

  const discover = useMutation({
    mutationFn: (url: string) =>
      apiRequest<DiscoveryItem>("/v1/connections/discover", {
        method: "POST",
        body: JSON.stringify({ base_url: url }),
      }),
    onSuccess: (result) => {
      setPicked(result.scopes_supported.slice(0, 1));
      if (!nameTouched) setName(suggestConnectionName(result.service_name, result.base_url));
    },
  });
  const start = useMutation({
    mutationFn: (input: { name: string; base_url: string; scopes: string[] }) =>
      apiRequest<{ authorization_url: string }>("/v1/connections/start", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (result) => window.location.assign(result.authorization_url),
  });

  const found = discover.data ?? null;
  const scopes = useMemo(
    () => (found && found.scopes_supported.length > 0 ? picked : parseTypedScopes(typedScopes)),
    [found, picked, typedScopes],
  );
  const canStart = Boolean(found?.connectable) && name.trim().length > 0 && scopes.length > 0;

  const reset = () => {
    setBaseUrl("");
    setName("");
    setNameTouched(false);
    setPicked([]);
    setTypedScopes("");
    discover.reset();
    start.reset();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("connections.connect")}
      submit={{
        label: t("connections.continueToApproval"),
        pending: start.isPending,
        disabled: !canStart,
      }}
      onSubmit={() => {
        if (found && canStart)
          start.mutate({ name: name.trim(), base_url: found.base_url, scopes });
      }}
      error={start.error ? failureSentence(start.error, t) : null}
      testId="connection-create-dialog"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="connection-base-url">{t("connections.baseUrl")}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="connection-base-url"
              value={baseUrl}
              placeholder="https://…"
              autoComplete="off"
              onChange={(event) => setBaseUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && baseUrl.trim()) {
                  event.preventDefault();
                  discover.mutate(baseUrl.trim());
                }
              }}
              data-testid="connection-create-url"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!baseUrl.trim() || discover.isPending}
              onClick={() => discover.mutate(baseUrl.trim())}
              data-testid="connection-create-check"
            >
              {t("connections.check")}
            </Button>
          </div>
          {discover.error ? (
            <FieldError data-testid="connection-create-check-failed">
              {failureSentence(discover.error, t)}
            </FieldError>
          ) : found ? (
            <FieldDescription data-testid="connection-create-found">
              {found.service_name ?? found.base_url}:{" "}
              {found.connectable
                ? t("connections.foundConnectable")
                : t(connectionFailureKey(found.reason))}
            </FieldDescription>
          ) : null}
        </Field>
        {found?.connectable ? (
          <>
            <Field>
              <FieldLabel htmlFor="connection-name">{t("connections.name")}</FieldLabel>
              <Input
                id="connection-name"
                value={name}
                autoComplete="off"
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
                data-testid="connection-create-name"
              />
            </Field>
            <Field>
              <FieldLabel>{t("connections.scopes")}</FieldLabel>
              {found.scopes_supported.length > 0 ? (
                <div className="grid gap-2" data-testid="connection-create-scopes">
                  {found.scopes_supported.map((scope, index) => (
                    <label
                      key={scope}
                      htmlFor={`connection-create-scope-${index}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`connection-create-scope-${index}`}
                        checked={picked.includes(scope)}
                        onCheckedChange={(value) =>
                          setPicked((current) =>
                            value === true
                              ? [...current, scope]
                              : current.filter((entry) => entry !== scope),
                          )
                        }
                        data-testid={`connection-create-scope-${index}`}
                      />
                      <span className="font-mono text-xs">{scope}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Input
                  value={typedScopes}
                  placeholder="read write"
                  onChange={(event) => setTypedScopes(event.target.value)}
                  data-testid="connection-create-scopes-typed"
                />
              )}
            </Field>
          </>
        ) : null}
      </FieldGroup>
    </FormDialog>
  );
}
