import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plug, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ApiError, apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

import {
  connectionFailureKey,
  type ConnectionItem,
  connectionNeedsRenewal,
  connectionStateKey,
  type DiscoveryItem,
  parseTypedScopes,
  readCallbackOutcome,
  suggestConnectionName,
} from "./connections-model";

const QUERY_KEY = ["admin", "connections"] as const;

/**
 * "Anbindungen": every system SubKit may call on someone's behalf, and the one
 * way to add one — an address, a few rights, a "Freigeben" on the other side.
 * No key is ever typed here; a system that cannot grant access this way is
 * connected on its connector page instead.
 */
export function ConnectionsPage() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("connection:write");
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnect, setDisconnect] = useState<ConnectionItem | null>(null);
  const [outcome, setOutcome] = useState(() => readCallbackOutcome(window.location.search));

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiRequest<{ items: ConnectionItem[] }>("/v1/connections"),
  });
  const refresh = () => client.invalidateQueries({ queryKey: QUERY_KEY });

  // The other side sends the browser back here with one word in the query.
  // Say it once, then drop it from the address so a reload does not repeat it.
  useEffect(() => {
    if (!outcome) return;
    if (outcome.kind === "connected") {
      toast.success(
        t(outcome.renewed ? "connections.renewed" : "connections.connected", {
          name: outcome.name,
        }),
      );
      setOutcome(null);
    }
    window.history.replaceState(null, "", window.location.pathname);
  }, [outcome, t]);

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
      await refresh();
      toast.success(t("connections.disconnected", { name }));
    },
    onError: (error) => toast.error(failureSentence(error, t)),
  });

  const items = query.data?.items ?? [];

  return (
    <PageFrame
      testId="admin-connections"
      title={t("resource.connections.title")}
      description={t("resource.connections.description")}
      scroll="page"
      surface="installation"
      action={
        canWrite ? (
          <Button
            className="w-full sm:w-auto"
            onClick={() => setConnectOpen(true)}
            data-testid="connection-create"
          >
            <Plug data-icon="inline-start" />
            {t("connections.connect")}
          </Button>
        ) : undefined
      }
    >
      {outcome?.kind === "failed" && (
        <Alert variant="destructive" className="mb-5" data-testid="connection-failed">
          <AlertTitle>
            {outcome.name
              ? t("connections.failedTitleNamed", { name: outcome.name })
              : t("connections.failedTitle")}
          </AlertTitle>
          <AlertDescription>{t(connectionFailureKey(outcome.code))}</AlertDescription>
        </Alert>
      )}
      {query.isPending ? (
        <div className="grid gap-3" data-testid="connections-loading">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      ) : query.error ? (
        <Alert variant="destructive" data-testid="connections-error">
          <AlertTitle>{t("connections.loadFailed")}</AlertTitle>
          <AlertDescription>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              data-testid="connections-retry"
            >
              {t("common.refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <Empty className="min-h-52 border" data-testid="connections-empty">
          <EmptyHeader>
            <EmptyTitle>{t("connections.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("connections.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-2" data-testid="connections-list">
          {items.map((item, index) => (
            <ConnectionRow
              key={item.id}
              item={item}
              index={index}
              canWrite={canWrite}
              renewing={renew.isPending && renew.variables === item.id}
              onRenew={() => renew.mutate(item.id)}
              onDisconnect={() => setDisconnect(item)}
            />
          ))}
        </div>
      )}
      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <AlertDialog open={Boolean(disconnect)} onOpenChange={(next) => !next && setDisconnect(null)}>
        <AlertDialogContent data-testid="connection-disconnect-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("connections.disconnectTitle", { name: disconnect?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {disconnect && disconnect.used_by_connectors > 0
                ? t("connections.disconnectInUse", { count: String(disconnect.used_by_connectors) })
                : t("connections.disconnectDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="connection-disconnect-cancel">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => disconnect && remove.mutate(disconnect.id)}
              data-testid="connection-disconnect-confirm"
            >
              {t("connections.disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageFrame>
  );
}

function failureSentence(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof ApiError && error.status === 409) return t("connections.failure.nameTaken");
  const code = error instanceof ApiError ? (error.message.split(":")[0] ?? null) : null;
  return t(connectionFailureKey(code));
}

function ConnectionRow({
  item,
  index,
  canWrite,
  renewing,
  onRenew,
  onDisconnect,
}: {
  item: ConnectionItem;
  index: number;
  canWrite: boolean;
  renewing: boolean;
  onRenew: () => void;
  onDisconnect: () => void;
}) {
  const { t, locale, dateTime } = useI18n();
  const needsRenewal = connectionNeedsRenewal(item);
  const stateWord =
    item.state === "expiring" && item.expires_at
      ? t("connections.state.expiringAt", { date: dateTime(item.expires_at) })
      : t(connectionStateKey(item.state));
  return (
    <Card size="sm" data-testid={`connection-item-${index}`}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">{item.service_name ?? item.name}</p>
            <Badge
              variant={
                needsRenewal ? "destructive" : item.state === "valid" ? "secondary" : "outline"
              }
              data-testid={`connection-state-${index}`}
            >
              <span aria-hidden="true">{needsRenewal ? "●" : "○"}</span> {stateWord}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {item.name} · {item.base_url}
          </p>
          {item.service_description && (
            <p className="mt-1 text-sm text-muted-foreground">{item.service_description}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1" data-testid={`connection-scopes-${index}`}>
            {(item.granted_scopes ?? item.scopes).map((scope) => (
              <Badge key={scope} variant="secondary">
                {scope}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {item.last_used_at
              ? t("connections.lastUsed", { when: formatRelativeTime(locale, item.last_used_at) })
              : t("connections.neverUsed")}
            {" · "}
            {item.auto_renew
              ? t("connections.autoRenews")
              : item.expires_at
                ? t("connections.expiresAt", { date: dateTime(item.expires_at) })
                : t("connections.noExpiry")}
            {item.used_by_connectors > 0 && (
              <>
                {" · "}
                {t("connections.usedBy", { count: String(item.used_by_connectors) })}
              </>
            )}
          </p>
          {needsRenewal && (
            <p className="mt-2 text-sm text-destructive" data-testid={`connection-why-${index}`}>
              {item.state === "unreadable"
                ? t("connections.unreadableHint")
                : t("connections.expiredHint", { error: item.last_error ?? "" })}
            </p>
          )}
        </div>
        {canWrite && (
          <div className="flex shrink-0 gap-2">
            <Button
              variant={needsRenewal ? "default" : "outline"}
              size="sm"
              disabled={renewing}
              onClick={onRenew}
              data-testid={`connection-renew-${index}`}
            >
              <RefreshCw data-icon="inline-start" className={cn(renewing && "animate-spin")} />
              {t("connections.renew")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("common.actions")} data-testid={`connection-menu-${index}`}>
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={onDisconnect}
                  data-testid={`connection-disconnect-${index}`}
                >
                  {t("connections.disconnect")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Three steps in one dialog: the address, what the address said, the rights.
 * The dialog ends by leaving the page — the last step happens on the other
 * side, and the other side brings the browser back.
 */
function ConnectDialog({
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={false} data-testid="connection-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("connections.connect")}</DialogTitle>
          <DialogDescription>{t("connections.connectDescription")}</DialogDescription>
        </DialogHeader>
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
                  if (event.key === "Enter" && baseUrl.trim()) discover.mutate(baseUrl.trim());
                }}
                data-testid="connection-create-url"
              />
              <Button
                variant="outline"
                disabled={!baseUrl.trim() || discover.isPending}
                onClick={() => discover.mutate(baseUrl.trim())}
                data-testid="connection-create-check"
              >
                {t("connections.check")}
              </Button>
            </div>
            <FieldDescription>{t("connections.baseUrlHint")}</FieldDescription>
          </Field>
          {discover.error && (
            <Alert variant="destructive" data-testid="connection-create-check-failed">
              <AlertDescription>{failureSentence(discover.error, t)}</AlertDescription>
            </Alert>
          )}
          {found && (
            <div
              className="rounded-lg border bg-muted/40 p-3 text-sm"
              data-testid="connection-create-found"
            >
              <p className="font-medium">{found.service_name ?? found.base_url}</p>
              {found.service_description && (
                <p className="mt-1 text-muted-foreground">{found.service_description}</p>
              )}
              <p className="mt-1 text-muted-foreground">
                {found.connectable
                  ? t("connections.foundConnectable")
                  : t(connectionFailureKey(found.reason))}
              </p>
            </div>
          )}
          {found?.connectable && (
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
                <FieldDescription>{t("connections.nameHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>{t("connections.scopes")}</FieldLabel>
                {found.scopes_supported.length > 0 ? (
                  <div className="grid gap-2" data-testid="connection-create-scopes">
                    {found.scopes_supported.map((scope, index) => {
                      const checked = picked.includes(scope);
                      return (
                        <label
                          key={scope}
                          htmlFor={`connection-create-scope-${index}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={`connection-create-scope-${index}`}
                            checked={checked}
                            onCheckedChange={(value) =>
                              setPicked((current) =>
                                value === true
                                  ? [...current, scope]
                                  : current.filter((s) => s !== scope),
                              )
                            }
                            data-testid={`connection-create-scope-${index}`}
                          />
                          <span className="font-mono text-xs">{scope}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <Input
                    value={typedScopes}
                    placeholder="read write"
                    onChange={(event) => setTypedScopes(event.target.value)}
                    data-testid="connection-create-scopes-typed"
                  />
                )}
                <FieldDescription>{t("connections.scopesHint")}</FieldDescription>
              </Field>
            </>
          )}
          {start.error && (
            <Alert variant="destructive" data-testid="connection-create-start-failed">
              <AlertDescription>{failureSentence(start.error, t)}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            data-testid="connection-create-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!canStart || start.isPending}
            onClick={() =>
              found && start.mutate({ name: name.trim(), base_url: found.base_url, scopes })
            }
            data-testid="connection-create-submit"
          >
            {t("connections.continueToApproval")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
