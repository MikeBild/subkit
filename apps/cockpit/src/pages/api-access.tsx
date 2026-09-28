import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plug, Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  type ApiAccessSection,
  absolute,
  apiAccessSectionFromUrl,
  connectorHref,
} from "@/app/links";
import { useSession } from "@/app/session";
import { AttentionList } from "@/components/cockpit/attention-list";
import { ConfirmAction } from "@/components/cockpit/confirm-action";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { cn } from "@/lib/utils";
import { SecretDialog } from "@/pages/admin";
import {
  type ApiKeyItem,
  apiAccessAttention,
  type ConnectedClientItem,
  defaultKeyScopes,
  keyExpired,
  ROTATE_OVERLAP_MINUTES,
  scopeCatalogue,
  scopeLabel,
  scopeRisk,
  scopeRiskKey,
} from "@/pages/api-access-model";
import {
  type ConnectionItem,
  connectionFailureKey,
  connectionNeedsRenewal,
  connectionReasonKey,
  connectionStateKey,
  type DiscoveryItem,
  parseTypedScopes,
  readCallbackOutcome,
  suggestConnectionName,
  withoutCallbackParams,
} from "@/pages/connections-model";

type IssuedApiKey = ApiKeyItem & { plaintext_key: string };

const KEYS_QUERY = ["admin", "api-keys"] as const;
const CLIENTS_QUERY = ["admin", "oauth-clients"] as const;
const CONNECTIONS_QUERY = ["admin", "connections"] as const;

// RFC 8693 token exchange at the engine's own token endpoint — one line a
// script can paste. The key never leaves the file it is read from.
const TOKEN_EXCHANGE_CURL = [
  "curl -sS -X POST $SUBKIT_URL/v1/oauth/token \\",
  '  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \\',
  '  --data-urlencode "subject_token=$(cat /etc/subkit/api-key)" \\',
  '  --data-urlencode "subject_token_type=urn:subkit:params:oauth:token-type:api-key"',
].join("\n");

/**
 * Zugangsdaten — the one page for everything that holds or grants rights
 * (§11 Rechte-Inventur): the keys this installation hands out, the
 * applications connected to it, and the accounts it is connected to. Each
 * section is behind its own read permission; a section the reader cannot read
 * is absent rather than a failed load.
 */
export function ApiAccessPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const can = (permission: string) => session.permissions.includes(permission);
  const canKeys = can("api_key:read");
  const canClients = can("mcp_oauth_client:read");
  const canGrants = can("connection:read");

  const keys = useQuery({
    queryKey: KEYS_QUERY,
    queryFn: () => apiRequest<{ items: ApiKeyItem[] }>("/v1/identity/api-keys"),
    enabled: canKeys,
  });
  const clients = useQuery({
    queryKey: CLIENTS_QUERY,
    queryFn: () => apiRequest<{ items: ConnectedClientItem[] }>("/v1/oauth/clients"),
    enabled: canClients,
  });
  const connections = useQuery({
    queryKey: CONNECTIONS_QUERY,
    queryFn: () => apiRequest<{ items: ConnectionItem[] }>("/v1/connections"),
    enabled: canGrants,
  });

  const attention = useMemo(
    () =>
      apiAccessAttention(
        {
          connections: connections.data?.items ?? [],
          keys: keys.data?.items ?? [],
          nowMs: Date.now(),
        },
        t,
        dateTime,
      ),
    [connections.data, keys.data, t, dateTime],
  );

  // An address that names a section opens the page there — the OAuth callback
  // lands on `section=grants`, the attention list links to its section.
  useEffect(() => {
    const section = apiAccessSectionFromUrl(window.location.search);
    if (!section) return;
    const heading = document.getElementById(sectionHeadingId(section));
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }, []);

  return (
    <PageFrame
      testId="admin-api-access"
      title={t("resource.apiAccess.title")}
      description={t("resource.apiAccess.description")}
      scroll="page"
      surface="installation"
    >
      <div className="flex flex-col gap-8">
        <AttentionList
          items={attention}
          title={t("apiAccess.attention.title")}
          testId="api-access-attention"
        />
        {canKeys ? <KeysSection query={keys} /> : null}
        {canClients ? <ClientsSection query={clients} /> : null}
        {canGrants ? <GrantsSection query={connections} /> : null}
      </div>
    </PageFrame>
  );
}

function sectionHeadingId(section: ApiAccessSection): string {
  return `api-access-${section}-title`;
}

function Section({
  section,
  title,
  description,
  action,
  children,
}: {
  section: ApiAccessSection;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="flex scroll-mt-4 flex-col gap-3"
      aria-labelledby={sectionHeadingId(section)}
      data-testid={`api-access-section-${section}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id={sectionHeadingId(section)}
            tabIndex={-1}
            className="text-base font-semibold outline-none"
          >
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function LoadingRows({ testId }: { testId: string }) {
  return (
    <div className="grid gap-2" data-testid={testId}>
      {[0, 1].map((index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}

/** Never used yet: what it is for, and the one way to start (§4). */
function EmptySection({
  title,
  description,
  action,
  testId,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <Empty className="min-h-40 border" data-testid={testId}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

// ── API-Schlüssel ─────────────────────────────────────────────────────────────

type ListQuery<T> = ReturnType<typeof useQuery<{ items: T[] }>>;

function KeysSection({ query }: { query: ListQuery<ApiKeyItem> }) {
  const { t, locale, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("api_key:write");
  const canRotate = session.permissions.includes("api_key:rotate");
  const canRevoke = session.permissions.includes("api_key:revoke");
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: KEYS_QUERY });

  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ old: ApiKeyItem; new: IssuedApiKey }>(
        `/v1/identity/api-keys/${encodeURIComponent(id)}/rotate`,
        { method: "POST", body: JSON.stringify({ overlap_minutes: ROTATE_OVERLAP_MINUTES }) },
      ),
    onSuccess: async (result) => {
      setRotating(null);
      setSecret(result.new.plaintext_key);
      await refresh();
      if (result.old.rotating_out_at)
        toast.success(t("apiKeys.rotated", { date: dateTime(result.old.rotating_out_at) }));
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/identity/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoking(null);
      await refresh();
      toast.success(t("apiKeys.revoked"));
    },
  });

  const createButton = canWrite ? (
    <Button
      className="w-full sm:w-auto"
      onClick={() => setCreateOpen(true)}
      data-testid="api-key-create"
    >
      <Plus data-icon="inline-start" />
      {t("apiKeys.create")}
    </Button>
  ) : undefined;

  const view = queryView(query, (data) => data.items.length === 0);
  const nowMs = Date.now();
  return (
    <Section
      section="keys"
      title={t("apiAccess.section.keys")}
      description={t("apiAccess.section.keysDescription")}
      action={createButton}
    >
      {view === "loading" ? (
        <LoadingRows testId="api-keys-loading" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("apiAccess.section.keys") })}
          onRetry={() => void query.refetch()}
          testId="api-keys-load-failed"
        />
      ) : view === "empty" ? (
        <EmptySection
          title={t("apiKeys.emptyTitle")}
          description={t("apiKeys.emptyDescription")}
          testId="api-keys-empty"
        />
      ) : (
        <div className="grid gap-2" data-testid="api-keys-list">
          {(query.data?.items ?? []).map((key, index) => {
            const expired = keyExpired(key, nowMs);
            const live = !key.revoked_at;
            return (
              <Card key={key.id} size="sm" data-testid={`api-key-item-${index}`}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{key.name || t("apiKeys.unnamed")}</p>
                      {key.revoked_at ? (
                        <Badge variant="outline" data-testid={`api-key-revoked-${index}`}>
                          <span aria-hidden="true">○</span> {t("apiKeys.revokedBadge")}
                        </Badge>
                      ) : expired ? (
                        <Badge variant="destructive" data-testid={`api-key-expired-${index}`}>
                          <span aria-hidden="true">●</span> {t("apiKeys.expiredBadge")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {key.prefix} · {t("apiKeys.created", { date: dateTime(key.created_at) })}
                    </p>
                    <p
                      className="mt-1 text-xs text-muted-foreground"
                      data-testid={`api-key-use-${index}`}
                    >
                      {key.last_used_at
                        ? t("apiKeys.lastUsed", {
                            when: formatRelativeTime(locale, key.last_used_at),
                          })
                        : t("apiKeys.neverUsed")}
                      {" · "}
                      {key.revoked_at
                        ? t("apiKeys.revokedAt", { date: dateTime(key.revoked_at) })
                        : key.expires_at
                          ? t(expired ? "apiKeys.expiredAt" : "apiKeys.expiresAt", {
                              date: dateTime(key.expires_at),
                            })
                          : t("apiKeys.noExpiry")}
                      {live && key.rotating_out_at ? (
                        <>
                          {" · "}
                          {t("apiKeys.rotatingOut", { date: dateTime(key.rotating_out_at) })}
                        </>
                      ) : null}
                    </p>
                    <ScopeList scopes={key.scopes} testId={`api-key-scopes-${index}`} />
                  </div>
                  {live && (canRotate || canRevoke) ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          label={t("common.actions")}
                          data-testid={`api-key-menu-${index}`}
                        >
                          <MoreHorizontal />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canRotate ? (
                          <DropdownMenuItem
                            onSelect={() => setRotating(key)}
                            data-testid={`api-key-rotate-${index}`}
                          >
                            {t("apiKeys.rotate")}
                          </DropdownMenuItem>
                        ) : null}
                        {canRevoke ? (
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRevoking(key)}
                            data-testid={`api-key-revoke-${index}`}
                          >
                            {t("apiKeys.revoke")}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <Card size="sm" data-testid="api-keys-token-exchange">
        <CardContent className="flex flex-col gap-2 p-4">
          <p className="text-sm text-muted-foreground">{t("apiKeys.exchangeHint")}</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            <code>{TOKEN_EXCHANGE_CURL}</code>
          </pre>
        </CardContent>
      </Card>
      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onIssued={async (plaintext) => {
          setCreateOpen(false);
          setSecret(plaintext);
          await refresh();
        }}
      />
      <ConfirmAction
        open={Boolean(rotating)}
        onOpenChange={(next) => !next && setRotating(null)}
        title={t("apiKeys.rotateTitle", { name: rotating?.name || t("apiKeys.unnamed") })}
        consequence={t("apiKeys.rotateConsequence", { minutes: String(ROTATE_OVERLAP_MINUTES) })}
        confirmLabel={t("apiKeys.rotate")}
        onConfirm={() => (rotating ? rotate.mutateAsync(rotating.id) : undefined)}
        error={rotate.error ? t("apiKeys.actionFailed") : null}
        testId="api-key-rotate-dialog"
      />
      <ConfirmAction
        open={Boolean(revoking)}
        onOpenChange={(next) => !next && setRevoking(null)}
        title={t("apiKeys.revokeTitle", { name: revoking?.name || t("apiKeys.unnamed") })}
        consequence={t("apiKeys.revokeConsequence")}
        confirmLabel={t("apiKeys.revoke")}
        tone="destructive"
        onConfirm={() => (revoking ? revoke.mutateAsync(revoking.id) : undefined)}
        error={revoke.error ? t("apiKeys.actionFailed") : null}
        testId="api-key-revoke-dialog"
      />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} title={t("apiKeys.ready")} />
    </Section>
  );
}

/** A key's rights as words with their risk — never the raw `resource:action` string (§11). */
function ScopeList({ scopes, testId }: { scopes: readonly string[]; testId: string }) {
  const { t } = useI18n();
  return (
    <ul className="mt-2 flex flex-wrap gap-1" data-testid={testId}>
      {scopes.map((scope) => {
        const risk = scopeRisk(scope);
        return (
          <li key={scope}>
            <Badge variant={risk === "reads" ? "secondary" : "outline"} data-scope-risk={risk}>
              <LabelText label={scopeLabel(scope, t)} />
              <span className={cn("ml-1", risk === "manages" && "font-semibold")}>
                · {t(scopeRiskKey(risk))}
              </span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

/** A new key's rights are picked from what the person holds — never typed. */
function CreateKeyDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (plaintext: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const session = useSession();
  const catalogue = useMemo(() => scopeCatalogue(session.permissions), [session.permissions]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(() => defaultKeyScopes(session.permissions));
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
      setPicked(defaultKeyScopes(session.permissions));
      await onIssued(result.plaintext_key);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} data-testid="api-key-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("apiKeys.create")}</DialogTitle>
          <DialogDescription>{t("apiKeys.createDescription")}</DialogDescription>
        </DialogHeader>
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
            <FieldLabel>{t("apiKeys.scopes")}</FieldLabel>
            <div
              className="grid max-h-72 gap-2 overflow-y-auto rounded-md border p-3"
              data-testid="api-key-create-scopes"
            >
              {catalogue.map((scope, index) => {
                const risk = scopeRisk(scope);
                return (
                  <label
                    key={scope}
                    htmlFor={`api-key-scope-${index}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={`api-key-scope-${index}`}
                      checked={picked.includes(scope)}
                      onCheckedChange={(value) =>
                        setPicked((current) =>
                          value === true
                            ? [...current, scope]
                            : current.filter((entry) => entry !== scope),
                        )
                      }
                      data-testid={`api-key-scope-${index}`}
                    />
                    <span className="min-w-0 flex-1">
                      <LabelText label={scopeLabel(scope, t)} />
                    </span>
                    <Badge variant={risk === "reads" ? "secondary" : "outline"}>
                      {t(scopeRiskKey(risk))}
                    </Badge>
                  </label>
                );
              })}
            </div>
            <FieldDescription>{t("apiKeys.scopesHint")}</FieldDescription>
          </Field>
          {issue.error ? (
            <Alert variant="destructive" data-testid="api-key-create-failed">
              <AlertDescription>{t("apiKeys.actionFailed")}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="api-key-create-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || picked.length === 0 || issue.isPending}
            onClick={() => issue.mutate()}
            data-testid="api-key-create-submit"
          >
            {t("apiKeys.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Verbundene Anwendungen ────────────────────────────────────────────────────

/**
 * The applications that were approved for this installation, and who approved
 * each one. The approval belongs to the installation, not to a browser
 * session — so the section says whose decision keeps one alive, and what a
 * withdrawal ends.
 */
function ClientsSection({ query }: { query: ListQuery<ConnectedClientItem> }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canRevoke = session.permissions.includes("mcp_oauth_client:revoke");
  const [revoking, setRevoking] = useState<ConnectedClientItem | null>(null);
  const revoke = useMutation({
    mutationFn: (clientId: string) =>
      apiRequest<void>(`/v1/oauth/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
    onSuccess: async () => {
      const name = revoking?.client_name || t("connectedClients.unnamed");
      setRevoking(null);
      await client.invalidateQueries({ queryKey: CLIENTS_QUERY });
      toast.success(t("connectedClients.revokedToast", { name }));
    },
  });
  const view = queryView(query, (data) => data.items.length === 0);
  return (
    <Section
      section="clients"
      title={t("apiAccess.section.clients")}
      description={t("apiAccess.section.clientsDescription")}
    >
      {view === "loading" ? (
        <LoadingRows testId="connected-clients-loading" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("apiAccess.section.clients") })}
          onRetry={() => void query.refetch()}
          testId="connected-clients-load-failed"
        />
      ) : view === "empty" ? (
        <EmptySection
          title={t("connectedClients.emptyTitle")}
          description={t("connectedClients.emptyDescription")}
          testId="connected-clients-empty"
        />
      ) : (
        <div className="grid gap-2" data-testid="connected-clients-list">
          {(query.data?.items ?? []).map((item, index) => (
            <Card key={item.id} size="sm" data-testid={`connected-client-${index}`}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {item.client_name || t("connectedClients.unnamed")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.approved_by.length
                      ? t("connectedClients.approvedBy", { people: item.approved_by.join(", ") })
                      : t("connectedClients.noLiveApproval")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.disabled_at ? (
                      <Badge variant="outline" data-testid={`connected-client-revoked-${index}`}>
                        <span aria-hidden="true">○</span> {t("connectedClients.revoked")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        {t("connectedClients.live", { count: String(item.live_connections) })}
                      </Badge>
                    )}
                    <Badge variant="outline">
                      {t("apiKeys.created", { date: dateTime(item.created_at) })}
                    </Badge>
                  </div>
                </div>
                {canRevoke && !item.disabled_at ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        label={t("common.actions")}
                        data-testid={`connected-client-menu-${index}`}
                      >
                        <MoreHorizontal />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setRevoking(item)}
                        data-testid={`connected-client-revoke-${index}`}
                      >
                        {t("connectedClients.revoke")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <ConfirmAction
        open={Boolean(revoking)}
        onOpenChange={(next) => !next && setRevoking(null)}
        title={t("connectedClients.revokeTitle", {
          name: revoking?.client_name || t("connectedClients.unnamed"),
        })}
        consequence={
          revoking && revoking.approved_by.length > 0
            ? t("connectedClients.revokeConsequence", {
                people: revoking.approved_by.join(", "),
              })
            : t("connectedClients.revokeConsequenceNoApproval")
        }
        confirmLabel={t("connectedClients.revoke")}
        tone="destructive"
        onConfirm={() => (revoking ? revoke.mutateAsync(revoking.client_id) : undefined)}
        error={revoke.error ? t("connectedClients.revokeFailed") : null}
        testId="connected-client-revoke-dialog"
      />
    </Section>
  );
}

// ── Kontoverbindungen ────────────────────────────────────────────────────────

/**
 * Every system SubKit may call on someone's behalf, and the one way to add
 * one — an address, a few rights, a "Freigeben" on the other side. No key is
 * ever typed here; a system that cannot grant access this way is connected on
 * its connector page instead.
 */
function GrantsSection({ query }: { query: ListQuery<ConnectionItem> }) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("connection:write");
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnect, setDisconnect] = useState<ConnectionItem | null>(null);
  const [outcome, setOutcome] = useState(() => readCallbackOutcome(window.location.search));
  const refresh = () => client.invalidateQueries({ queryKey: CONNECTIONS_QUERY });

  // The other side sends the browser back here with its result in the query.
  // Say it once, then drop those words from the address — and only those, so
  // a reload stays in this section without repeating the sentence.
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
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${withoutCallbackParams(window.location.search)}`,
    );
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
  });

  const connectButton = canWrite ? (
    <Button
      variant="outline"
      className="w-full sm:w-auto"
      onClick={() => setConnectOpen(true)}
      data-testid="connection-create"
    >
      <Plug data-icon="inline-start" />
      {t("connections.connect")}
    </Button>
  ) : undefined;

  const view = queryView(query, (data) => data.items.length === 0);
  return (
    <Section
      section="grants"
      title={t("apiAccess.section.grants")}
      description={t("apiAccess.section.grantsDescription")}
      action={connectButton}
    >
      {outcome?.kind === "failed" && (
        <Alert variant="destructive" data-testid="connection-failed">
          <AlertTitle>
            {outcome.name
              ? t("connections.failedTitleNamed", { name: outcome.name })
              : t("connections.failedTitle")}
          </AlertTitle>
          <AlertDescription>{t(connectionFailureKey(outcome.code))}</AlertDescription>
        </Alert>
      )}
      {view === "loading" ? (
        <LoadingRows testId="connections-loading" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("connections.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="connections-error"
        />
      ) : view === "empty" ? (
        <EmptySection
          title={t("connections.emptyTitle")}
          description={t("connections.emptyDescription")}
          testId="connections-empty"
        />
      ) : (
        <div className="grid gap-2" data-testid="connections-list">
          {(query.data?.items ?? []).map((item, index) => (
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
      <ConfirmAction
        open={Boolean(disconnect)}
        onOpenChange={(next) => !next && setDisconnect(null)}
        title={t("connections.disconnectTitle", { name: disconnect?.name ?? "" })}
        consequence={
          disconnect && disconnect.used_by.length > 0
            ? t("connections.disconnectInUse", {
                count: String(disconnect.used_by.length),
                connectors: disconnect.used_by.map((user) => user.display_name).join(", "),
              })
            : t("connections.disconnectDescription")
        }
        confirmLabel={t("connections.disconnect")}
        tone="destructive"
        onConfirm={() => (disconnect ? remove.mutateAsync(disconnect.id) : undefined)}
        error={remove.error ? failureSentence(remove.error, t) : null}
        testId="connection-disconnect-dialog"
      />
    </Section>
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
          {/* The other system's own rights strings: this build cannot name
              them, so they are shown as what they are — machine values. */}
          <div className="mt-2 flex flex-wrap gap-1" data-testid={`connection-scopes-${index}`}>
            {(item.granted_scopes ?? item.scopes).map((scope) => (
              <Badge key={scope} variant="secondary">
                <LabelText label={{ text: scope, machine: true }} />
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
          </p>
          <div className="mt-2 text-xs" data-testid={`connection-used-by-${index}`}>
            {item.used_by.length === 0 ? (
              <span className="text-muted-foreground">{t("connections.notUsed")}</span>
            ) : (
              <>
                <span className="text-muted-foreground">{t("connections.usedByLabel")} </span>
                {item.used_by.map((user, userIndex) => (
                  <span key={user.connector_id}>
                    {userIndex > 0 ? ", " : null}
                    <a
                      href={absolute(connectorHref(user.connector_id))}
                      className="font-medium underline underline-offset-4"
                      data-testid={`connection-used-by-${index}-${userIndex}`}
                    >
                      {user.display_name}
                    </a>{" "}
                    <span className="text-muted-foreground">
                      ({t("connections.usedByWorkflows", { count: String(user.workflow_count) })})
                    </span>
                  </span>
                ))}
              </>
            )}
          </div>
          {needsRenewal && item.state_reason ? (
            <div className="mt-2" data-testid={`connection-why-${index}`}>
              <p className="text-sm text-destructive">
                {t(connectionReasonKey(item.state_reason))}
              </p>
              {item.last_error ? (
                <p className="text-xs text-muted-foreground">
                  {t("common.engineWording", { text: item.last_error })}
                </p>
              ) : null}
            </div>
          ) : null}
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
