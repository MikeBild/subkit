import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronRight, MoreHorizontal, Plug, Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  type ApiAccessSection,
  absolute,
  apiAccessHref,
  apiAccessSectionFromUrl,
  connectorHref,
  docsHref,
} from "@/app/links";
import { useSession } from "@/app/session";
import { ConfirmAction } from "@/components/cockpit/confirm-action";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { cn } from "@/lib/utils";
import { SecretDialog } from "@/pages/admin";
import {
  type ApiKeyItem,
  type ConnectedClientItem,
  defaultKeyScopes,
  grantsNeedingRenewal,
  groupApiKeys,
  groupConnectedClients,
  keyState,
  keyStateSaysUse,
  keyStateText,
  keysNeedingAction,
  openApiAccessSection,
  ROTATE_OVERLAP_MINUTES,
  readableSections,
  scopeCatalogue,
  scopeLabel,
  scopeRisk,
  scopeRiskKey,
  sectionBadgeText,
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

/**
 * The guide a reader follows to add an app — Claude, ChatGPT, Codex. Adding
 * starts in the app itself, so the empty section links the way there.
 */
const CLIENTS_GUIDE = "authors/coding-agents.md";
/** How a script swaps a key for a short-lived token — for developers, not on the page itself. */
const TOKEN_EXCHANGE_GUIDE = "developers/token-exchange.md";

const SECTION_TITLE_KEYS = {
  clients: "apiAccess.section.clients",
  keys: "apiAccess.section.keys",
  grants: "apiAccess.section.grants",
} as const;

const TAB_COLUMNS = ["grid-cols-1", "grid-cols-2", "grid-cols-3"] as const;

/**
 * Zugangsdaten — the one page for everything that holds or grants rights
 * (§11 Rechte-Inventur): the apps with access to SubKit, the keys for
 * scripts, and the systems SubKit may use on someone's behalf. Each is a tab
 * with its own address (`?section=clients|keys|grants`) — the pattern of
 * Personen & Rechte: tabs on a wide screen, a select on a phone. Each section
 * is behind its own read permission; a section the reader cannot read is
 * absent rather than a failed load.
 *
 * The three sections stood one below the other with an index of anchors
 * above them, and the page opened with the words "Kontoverbindungen",
 * "API-Schlüssel" and "Verbundene Anwendungen" — three names a reader could
 * not tell apart without knowing the machinery. Each section now says when it
 * is needed, with an example.
 */
export function ApiAccessPage() {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => session.permissions.includes(permission);
  const canKeys = can("api_key:read");
  const canClients = can("mcp_oauth_client:read");
  const canGrants = can("connection:read");

  // All three lists load with the page, whichever tab is open: a tab says
  // how many of its rows need someone, and it can only say that once its
  // list has arrived.
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

  const readable = useMemo(
    () => readableSections({ grants: canGrants, keys: canKeys, clients: canClients }),
    [canGrants, canKeys, canClients],
  );
  // The section IS the address, as on Personen & Rechte: read from the
  // router's location on every render and changed only by navigating. The
  // OAuth callback lands on `section=grants`, the old `/connections` address
  // redirects there, and a tab switch replaces the history entry.
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const section = openApiAccessSection(apiAccessSectionFromUrl(searchStr), readable);
  const navigate = useNavigate();
  const choose = (next: string) => {
    const picked = readable.find((candidate) => candidate === next);
    if (!picked || picked === section) return;
    void navigate({ to: apiAccessHref(picked), replace: true });
  };

  const nowMs = Date.now();
  const badges: Record<ApiAccessSection, string | null> = {
    clients: null,
    keys: sectionBadgeText(
      "keys",
      keys.data ? keysNeedingAction(keys.data.items, nowMs) : undefined,
      t,
    ),
    grants: sectionBadgeText(
      "grants",
      connections.data ? grantsNeedingRenewal(connections.data.items) : undefined,
      t,
    ),
  };

  return (
    <PageFrame
      testId="admin-api-access"
      title={t("resource.apiAccess.title")}
      description={t("apiAccess.intro")}
      scroll="page"
      surface="installation"
    >
      {section === null ? (
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      ) : (
        <Tabs value={section} onValueChange={choose} data-testid="api-access-tabs">
          {readable.length > 1 ? (
            <>
              <Select value={section} onValueChange={choose}>
                <SelectTrigger
                  className="w-full sm:hidden"
                  aria-label={t("apiAccess.sectionPicker")}
                  data-testid="api-access-mobile-section"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {readable.map((value) => (
                      <SelectItem
                        key={value}
                        value={value}
                        data-testid={`api-access-mobile-${value}`}
                      >
                        {t(SECTION_TITLE_KEYS[value])}
                        {badges[value] ? ` · ${badges[value]}` : null}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <TabsList
                variant="line"
                className={cn(
                  "hidden h-auto w-full sm:grid",
                  TAB_COLUMNS[readable.length - 1] ?? "grid-cols-3",
                )}
                data-testid="api-access-tab-list"
              >
                {readable.map((value) => (
                  <TabsTrigger key={value} value={value} data-testid={`api-access-tab-${value}`}>
                    <span data-tab-label="">{t(SECTION_TITLE_KEYS[value])}</span>
                    {/* Only a count someone can act on, in its own words. */}
                    {badges[value] ? (
                      <Badge variant="outline" data-testid={`api-access-tab-badge-${value}`}>
                        {badges[value]}
                      </Badge>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </>
          ) : null}
          <TabsContent value={section} className="pt-4">
            {section === "grants" ? (
              <GrantsSection query={connections} />
            ) : section === "keys" ? (
              <KeysSection query={keys} />
            ) : (
              <ClientsSection query={clients} />
            )}
          </TabsContent>
        </Tabs>
      )}
    </PageFrame>
  );
}

/**
 * A section's head: what it is for with an example, the one way to add, and —
 * once its list has arrived — how many it holds. The total stands here, never
 * on the tab: a tab carries only what needs someone.
 */
function Section({
  section,
  description,
  total,
  action,
  children,
}: {
  section: ApiAccessSection;
  description: string;
  total?: string | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={`api-access-section-${section}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{description}</p>
          {total ? (
            <p
              className="mt-1 text-xs text-muted-foreground tabular-nums"
              data-testid={`api-access-total-${section}`}
            >
              {total}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A count in words, singular where it is one. */
function countText(
  t: ReturnType<typeof useI18n>["t"],
  count: number,
  one: Parameters<ReturnType<typeof useI18n>["t"]>[0],
  many: Parameters<ReturnType<typeof useI18n>["t"]>[0],
): string {
  return count === 1 ? t(one) : t(many, { count: String(count) });
}

/**
 * A group a reader seldom needs, behind a named toggle with its count (§8.4:
 * never a bare chevron). The rows are not mounted until it opens — production
 * put ~490 of them behind one of these.
 */
function CollapsedGroup({
  label,
  hint,
  testId,
  children,
}: {
  label: (open: boolean) => string;
  hint?: string;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <div className="flex flex-col gap-1">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 w-fit"
            data-testid={`${testId}-toggle`}
          >
            <ChevronRight
              data-icon="inline-start"
              className={cn("transition-transform", open && "rotate-90")}
            />
            {label(open)}
          </Button>
        </CollapsibleTrigger>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
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
  const renderKey = (key: ApiKeyItem, testKey: string) => {
    const state = keyState(key, nowMs);
    const expired = state?.kind === "expired";
    const live = !key.revoked_at;
    return (
      <Card key={key.id} size="sm" data-testid={`api-key-item-${testKey}`}>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{key.name || t("apiKeys.unnamed")}</p>
              {/* The key's state, on the key — the tasks it may raise live
                  on Übersicht, never in a second list on this page. */}
              {state ? (
                <Badge
                  variant={state.kind === "expired" ? "destructive" : "outline"}
                  data-testid={`api-key-${state.kind}-${testKey}`}
                  data-key-state={state.kind}
                >
                  {keyStateText(state, t)}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {key.prefix} · {t("apiKeys.created", { date: dateTime(key.created_at) })}
            </p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid={`api-key-use-${testKey}`}
            >
              {/* When the chip already says how long the key went unused,
                  the use line does not say it a second time. */}
              {keyStateSaysUse(state) ? null : (
                <>
                  {key.last_used_at
                    ? t("apiKeys.lastUsed", {
                        when: formatRelativeTime(locale, key.last_used_at),
                      })
                    : t("apiKeys.neverUsed")}
                  {" · "}
                </>
              )}
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
            <ScopeList scopes={key.scopes} testId={`api-key-scopes-${testKey}`} />
          </div>
          {/* A "⋯" only where it opens a menu of several acts; a key only one
              of them applies to gets that one as a named button. */}
          {live && canRotate !== canRevoke ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 self-start"
              onClick={() => (canRotate ? setRotating(key) : setRevoking(key))}
              data-testid={`api-key-${canRotate ? "rotate" : "revoke"}-${testKey}`}
            >
              {t(canRotate ? "apiKeys.rotate" : "apiKeys.revoke")}
            </Button>
          ) : live && canRotate && canRevoke ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("common.actions")} data-testid={`api-key-menu-${testKey}`}>
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canRotate ? (
                  <DropdownMenuItem
                    onSelect={() => setRotating(key)}
                    data-testid={`api-key-rotate-${testKey}`}
                  >
                    {t("apiKeys.rotate")}
                  </DropdownMenuItem>
                ) : null}
                {canRevoke ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setRevoking(key)}
                    data-testid={`api-key-revoke-${testKey}`}
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
  };
  const groups = groupApiKeys(query.data?.items ?? []);
  return (
    <Section
      section="keys"
      description={t("apiAccess.section.keysDescription")}
      total={
        query.data && groups.active.length > 0
          ? countText(t, groups.active.length, "apiAccess.total.keysOne", "apiAccess.total.keys")
          : null
      }
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
          {groups.active.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="api-keys-none-active">
              {t("apiKeys.noneActive")}
            </p>
          ) : (
            groups.active.map((key, index) => renderKey(key, String(index)))
          )}
          {groups.revoked.length > 0 ? (
            <CollapsedGroup
              testId="api-keys-revoked"
              label={(open) =>
                t(open ? "apiKeys.hideRevoked" : "apiKeys.showRevoked", {
                  count: groups.revoked.length,
                })
              }
            >
              <div className="grid gap-2">
                {groups.revoked.map((key, index) => renderKey(key, `r${index}`))}
              </div>
            </CollapsedGroup>
          ) : null}
        </div>
      )}
      {/* How a script swaps its key for a short-lived token is a developer's
          question: one link to the guide, not a command on this page. */}
      <p className="text-xs text-muted-foreground" data-testid="api-access-developer-footer">
        <a
          href={docsHref(TOKEN_EXCHANGE_GUIDE)}
          className="underline-offset-4 hover:underline"
          data-testid="api-access-token-exchange-link"
        >
          {t("apiAccess.developerFooter")}
        </a>
      </p>
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
  const renderClient = (item: ConnectedClientItem, testKey: string) => (
    <Card key={item.id} size="sm" data-testid={`connected-client-${testKey}`}>
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
              <Badge variant="outline" data-testid={`connected-client-revoked-${testKey}`}>
                <span aria-hidden="true">○</span>{" "}
                {t(item.retired_at ? "connectedClients.retired" : "connectedClients.revoked")}
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
        {/* A retired registration comes back on its next authorization;
              revoking it is how a person makes that impossible. */}
        {/* One act, so one named button — a "⋯" is a menu of several. */}
        {canRevoke && (!item.disabled_at || item.retired_at) ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 self-start"
            onClick={() => setRevoking(item)}
            data-testid={`connected-client-revoke-${testKey}`}
          >
            {t("connectedClients.revoke")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
  const groups = groupConnectedClients(query.data?.items ?? []);
  return (
    <Section
      section="clients"
      description={t("apiAccess.section.clientsDescription")}
      total={
        query.data && groups.granted.length > 0
          ? countText(
              t,
              groups.granted.length,
              "apiAccess.total.clientsOne",
              "apiAccess.total.clients",
            )
          : null
      }
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
        // Adding an app starts in the app; the way there is the guide.
        <EmptySection
          title={t("connectedClients.emptyTitle")}
          description={t("connectedClients.emptyDescription")}
          action={
            <Button asChild variant="outline" size="sm">
              <a href={docsHref(CLIENTS_GUIDE)} data-testid="connected-clients-guide">
                {t("apiAccess.clientsGuide")}
              </a>
            </Button>
          }
          testId="connected-clients-empty"
        />
      ) : (
        <div className="grid gap-2" data-testid="connected-clients-list">
          {groups.granted.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="connected-clients-none-granted"
            >
              {t("connectedClients.noneGranted")}
            </p>
          ) : (
            groups.granted.map((item, index) => renderClient(item, String(index)))
          )}
          {groups.ungranted.length > 0 ? (
            <CollapsedGroup
              testId="connected-clients-ungranted"
              label={(open) =>
                t(open ? "connectedClients.hideUngranted" : "connectedClients.showUngranted", {
                  count: groups.ungranted.length,
                })
              }
            >
              <div className="grid gap-2">
                {groups.ungranted.map((item, index) => renderClient(item, `u${index}`))}
              </div>
            </CollapsedGroup>
          ) : null}
          {groups.disabled.length > 0 ? (
            <CollapsedGroup
              testId="connected-clients-disabled"
              label={(open) =>
                t(open ? "connectedClients.hideDisabled" : "connectedClients.showDisabled", {
                  count: groups.disabled.length,
                })
              }
              hint={t("connectedClients.retirementRule")}
            >
              <div className="grid gap-2">
                {groups.disabled.map((item, index) => renderClient(item, `d${index}`))}
              </div>
            </CollapsedGroup>
          ) : null}
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
    // The section's own primary: a tab shows one section, so its way to add
    // is the one filled action on screen, as "Schlüssel erstellen" is on keys.
    <Button
      className="w-full sm:w-auto"
      onClick={() => setConnectOpen(true)}
      data-testid="connection-create"
    >
      <Plug data-icon="inline-start" />
      {t("connections.connect")}
    </Button>
  ) : undefined;

  const view = queryView(query, (data) => data.items.length === 0);
  const count = query.data?.items.length ?? 0;
  return (
    <Section
      section="grants"
      description={t("apiAccess.section.grantsDescription")}
      total={
        count > 0
          ? countText(t, count, "apiAccess.total.grantsOne", "apiAccess.total.grants")
          : null
      }
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

/**
 * The rights SubKit holds on the other system: how many, and the other
 * system's own strings behind "Details anzeigen". No risk word — the words
 * "liest", "schreibt", "verwaltet" come from SubKit's own permission catalogue
 * (`scopeRisk`), which does not know a foreign scope and would call every one
 * of them "schreibt". A claim this build cannot make is not made.
 */
function ConnectionRights({ scopes, index }: { scopes: readonly string[]; index: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (scopes.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-2"
      data-testid={`connection-rights-${index}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground" data-testid={`connection-rights-count-${index}`}>
          {scopes.length === 1
            ? t("connections.rightsOne")
            : t("connections.rights", { count: String(scopes.length) })}
        </span>
        <CollapsibleTrigger asChild>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            data-testid={`connection-rights-toggle-${index}`}
          >
            {t(open ? "connections.hideRights" : "connections.showRights")}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        {/* The other system's own strings, shown as what they are — machine values. */}
        <div className="mt-2 flex flex-wrap gap-1" data-testid={`connection-scopes-${index}`}>
          {scopes.map((scope) => (
            <Badge key={scope} variant="secondary">
              <LabelText label={{ text: scope, machine: true }} />
            </Badge>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
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
              {stateWord}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {item.name} · {item.base_url}
          </p>
          {item.service_description && (
            <p className="mt-1 text-sm text-muted-foreground">{item.service_description}</p>
          )}
          <ConnectionRights scopes={item.granted_scopes ?? item.scopes} index={index} />
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
          {/* A grant that ends and cannot renew itself says why, before it
              ends — not only as a countdown. */}
          {item.state === "expiring" ? (
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid={`connection-no-auto-renew-${index}`}
            >
              {t("connections.noAutoRenew")}
            </p>
          ) : null}
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
            {/* One further act beside the renewal: a named button, not a "⋯". */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
              data-testid={`connection-disconnect-${index}`}
            >
              {t("connections.disconnect")}
            </Button>
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
