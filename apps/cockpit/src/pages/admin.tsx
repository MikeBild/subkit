import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, RefreshCw, RotateCw, ScanSearch, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { ContextHelp } from "@/components/cockpit/context-help";
import { IconButton } from "@/components/cockpit/icon-button";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

type Envelope<T> = { items: T[] };
type RoleName = "admin" | "member" | "enduser";
type AccessTab = "roles" | "groups" | "grants" | "permissions";

interface UserItem {
  id: string;
  email: string;
  role: RoleName;
  effective_role: string;
  role_consistent: boolean;
  status: string;
}

interface RoleItem {
  id: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
}

interface GroupItem {
  id: string;
  name: string;
  description: string | null;
}

interface GrantItem {
  id: string;
  subject_type: string;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permission: string;
  expires_at: string | null;
}

interface WorkflowItem {
  id: string;
  name?: string | null;
  slug?: string | null;
}

interface RoleDetail extends RoleItem {
  permissions: string[];
}

interface PermissionItem {
  name: string;
  description: string;
  resource_type: string;
}

interface ApiKeyItem {
  id: string;
  name: string | null;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

interface IssuedApiKey extends ApiKeyItem {
  plaintext_key: string;
}

interface SettingItem {
  path: string;
  value: unknown;
  meta: {
    source: string;
    scope: string;
    sensitive: boolean;
    requiresRestart: boolean;
    description?: string;
    kind: string;
  };
}

interface HealthDigest {
  headline: string;
  all_clear: boolean;
  generated_at: string;
  failure_groups: Array<{ cause: string; count: number; workflow_name: string | null }>;
  risk: Array<{ headline: string; detail: string; severity: "warn" | "critical" }>;
  patch_candidates: { pending: number };
}

function AdminFrame({
  titleKey,
  descriptionKey,
  action,
  children,
  testId,
}: {
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <header className="flex shrink-0 flex-col items-stretch justify-between gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:px-8">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t(titleKey)}</h1>
            <ContextHelp
              label={t("resource.about", { resource: t(titleKey) })}
              testId={`${testId}-help`}
            >
              {t(descriptionKey)}
            </ContextHelp>
          </div>
        </div>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8">
        {children}
      </div>
    </main>
  );
}

function LoadingCards({ testId }: { testId: string }) {
  return (
    <div className="grid gap-3" data-testid={testId}>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}

function EmptyCard({ text, testId }: { text: string; testId: string }) {
  const { t } = useI18n();
  return (
    <Empty className="min-h-52 border" data-testid={testId}>
      <EmptyHeader>
        <EmptyTitle>{text}</EmptyTitle>
        <EmptyDescription>{t("admin.emptyHint")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function roleLabel(role: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key: Record<string, TranslationKey> = {
    config: "settings.meta.configuration",
    admin: "role.admin",
    member: "role.member",
    enduser: "role.enduser",
    metrics_scraper: "role.metricsScraper",
    portal_token_user: "role.portalTokenUser",
  };
  return key[role] ? t(key[role]) : t("common.unknown");
}

function builtinRoleDescription(
  role: string,
  fallback: string | null,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  const key: Record<string, TranslationKey> = {
    admin: "access.roleDescription.admin",
    member: "access.roleDescription.member",
    enduser: "access.roleDescription.enduser",
    metrics_scraper: "access.roleDescription.metricsScraper",
    portal_token_user: "access.roleDescription.portalTokenUser",
  };
  return key[role] ? t(key[role]) : fallback;
}

const PERMISSION_RESOURCE_KEYS: Readonly<Record<string, TranslationKey>> = {
  api_key: "nav.apiAccess",
  audit: "nav.audit",
  chat_identity: "permission.resource.chatIdentity",
  chat_workspace: "permission.resource.chatWorkspace",
  connector: "resource.connectors.title",
  conversation: "nav.chat",
  credential: "permission.resource.credentials",
  discovery: "permission.resource.discovery",
  execution: "resource.runs.title",
  file: "resource.files.title",
  identity: "resource.people.title",
  inbound_hook: "permission.resource.inboundHooks",
  knowledge: "resource.knowledge.title",
  mcp: "permission.resource.mcp",
  mcp_oauth_client: "permission.resource.mcpClients",
  metrics: "permission.resource.metrics",
  notification: "resource.inbox.title",
  portal_token: "permission.resource.portalTokens",
  rbac: "resource.access.title",
  self_healing: "resource.operations.title",
  settings: "resource.settings.title",
  skill: "resource.skills.title",
  stats: "resource.usage.title",
  workflow: "resource.workflows.title",
};

const PERMISSION_ACTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  abort: "permission.action.abort",
  activate: "permission.action.activate",
  admin: "permission.action.admin",
  approve: "permission.action.approve",
  archive: "permission.action.archive",
  authoring: "permission.action.authoring",
  cancel: "permission.action.cancel",
  delete: "permission.action.delete",
  list: "permission.action.list",
  oauth: "permission.action.oauth",
  promote: "permission.action.promote",
  read: "permission.action.read",
  revoke: "permission.action.revoke",
  rotate: "permission.action.rotate",
  run: "permission.action.run",
  signal: "permission.action.signal",
  test: "permission.action.test",
  write: "permission.action.write",
};

function permissionLabel(permission: string, t: ReturnType<typeof useI18n>["t"]): string {
  const [resource, action] = permission.split(":");
  const resourceKey = resource ? PERMISSION_RESOURCE_KEYS[resource] : undefined;
  const actionKey = action ? PERMISSION_ACTION_KEYS[action] : undefined;
  if (!resourceKey || !actionKey) return t("common.unknown");
  return t("permission.label", { resource: t(resourceKey), action: t(actionKey) });
}

export function PeoplePage() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("identity:write");
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleName>("member");
  const [deactivate, setDeactivate] = useState<UserItem | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["admin", "people"],
    queryFn: () => apiRequest<Envelope<UserItem>>("/v1/identity/users?limit=200"),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["admin", "people"] });
  const create = useMutation({
    mutationFn: () =>
      apiRequest<UserItem>("/v1/identity/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      }),
    onSuccess: async () => {
      setCreateOpen(false);
      setEmail("");
      await refresh();
      toast.success(t("people.created"));
    },
  });
  const update = useMutation({
    mutationFn: ({ id, nextRole }: { id: string; nextRole: RoleName }) =>
      apiRequest<UserItem>(`/v1/identity/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      }),
    onSuccess: async () => {
      await refresh();
      toast.success(t("people.roleUpdated"));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/identity/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeactivate(null);
      await refresh();
      toast.success(t("people.deactivated"));
    },
  });
  const invite = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ plaintext_token: string }>(
        `/v1/identity/users/${encodeURIComponent(id)}/invites`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: (result) => setSecret(result.plaintext_token),
  });

  return (
    <AdminFrame
      testId="admin-people"
      titleKey="resource.people.title"
      descriptionKey="resource.people.description"
      action={
        canWrite ? (
          <Button
            className="w-full sm:w-auto"
            onClick={() => setCreateOpen(true)}
            data-testid="people-create"
          >
            <Plus data-icon="inline-start" />
            {t("people.create")}
          </Button>
        ) : undefined
      }
    >
      {query.isPending ? (
        <LoadingCards testId="people-loading" />
      ) : !query.data?.items.length ? (
        <EmptyCard text={t("resource.people.empty")} testId="people-empty" />
      ) : (
        <div className="grid gap-2" data-testid="people-list">
          {query.data.items.map((user, index) => (
            <Card key={user.id} size="sm" data-testid={`people-item-${index}`}>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate text-sm">{user.email}</CardTitle>
                  <CardDescription className="mt-1 flex flex-wrap gap-2">
                    <Badge variant="outline">{roleLabel(user.effective_role, t)}</Badge>
                    <Badge variant="secondary">{statusLabel(t, user.status)}</Badge>
                    {!user.role_consistent && (
                      <Badge variant="destructive" data-testid={`people-role-drift-${index}`}>
                        {t("people.roleDrift")}
                      </Badge>
                    )}
                  </CardDescription>
                </div>
                {canWrite && (
                  <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:w-auto sm:grid-cols-[9rem_auto_auto]">
                    <Select
                      value={user.effective_role}
                      onValueChange={(value) =>
                        update.mutate({ id: user.id, nextRole: value as RoleName })
                      }
                    >
                      <SelectTrigger
                        className="w-full"
                        data-testid={`people-role-${index}`}
                        aria-label={t("people.role")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(["admin", "member", "enduser"] as const).map((name) => (
                            <SelectItem
                              key={name}
                              value={name}
                              data-testid={`people-role-${index}-${name}`}
                            >
                              {roleLabel(name, t)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => invite.mutate(user.id)}
                      data-testid={`people-invite-${index}`}
                    >
                      {t("people.invite")}
                    </Button>
                    <IconButton
                      label={t("people.deactivate")}
                      data-testid={`people-deactivate-${index}`}
                      onClick={() => setDeactivate(user)}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent showCloseButton={false} data-testid="people-create-dialog">
          <DialogHeader>
            <DialogTitle>{t("people.create")}</DialogTitle>
            <DialogDescription>{t("people.createDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="people-email">{t("people.email")}</FieldLabel>
              <Input
                id="people-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid="people-create-email"
              />
            </Field>
            <Field>
              <FieldLabel>{t("people.role")}</FieldLabel>
              <Select value={role} onValueChange={(value) => setRole(value as RoleName)}>
                <SelectTrigger className="w-full" data-testid="people-create-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(["admin", "member", "enduser"] as const).map((name) => (
                      <SelectItem
                        key={name}
                        value={name}
                        data-testid={`people-create-role-${name}`}
                      >
                        {roleLabel(name, t)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              data-testid="people-create-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!email.trim() || create.isPending}
              onClick={() => create.mutate()}
              data-testid="people-create-submit"
            >
              {t("people.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={Boolean(deactivate)} onOpenChange={(open) => !open && setDeactivate(null)}>
        <AlertDialogContent data-testid="people-deactivate-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("people.deactivate")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("people.deactivateDescription", { email: deactivate?.email ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="people-deactivate-cancel">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deactivate && remove.mutate(deactivate.id)}
              data-testid="people-deactivate-confirm"
            >
              {t("people.deactivate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SecretDialog
        secret={secret}
        onClose={() => setSecret(null)}
        title={t("people.inviteReady")}
      />
    </AdminFrame>
  );
}

function SecretDialog({
  secret,
  onClose,
  title,
}: {
  secret: string | null;
  onClose: () => void;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} data-testid="secret-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("secret.once")}</DialogDescription>
        </DialogHeader>
        <div
          className="rounded-lg border bg-muted p-3 font-mono text-xs break-all"
          data-testid="secret-value"
        >
          {secret}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => secret && navigator.clipboard.writeText(secret)}
            data-testid="secret-copy"
          >
            <Copy data-icon="inline-start" />
            {t("common.copy")}
          </Button>
          <Button onClick={onClose} data-testid="secret-done">
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApiAccessPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("api_key:write");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("workflow:read,workflow:run");
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiKeyItem | null>(null);
  const query = useQuery({
    queryKey: ["admin", "api-keys"],
    queryFn: () => apiRequest<Envelope<ApiKeyItem>>("/v1/identity/api-keys"),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["admin", "api-keys"] });
  const issue = useMutation({
    mutationFn: () =>
      apiRequest<IssuedApiKey>("/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({
          owner_kind: "user",
          owner_id: session.principal.id,
          name: name.trim(),
          scopes: scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: async (result) => {
      setOpen(false);
      setSecret(result.plaintext_key);
      await refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ new: IssuedApiKey }>(`/v1/identity/api-keys/${encodeURIComponent(id)}/rotate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: async (result) => {
      setSecret(result.new.plaintext_key);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/identity/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoke(null);
      await refresh();
      toast.success(t("apiKeys.revoked"));
    },
  });
  return (
    <AdminFrame
      testId="admin-api-access"
      titleKey="resource.apiAccess.title"
      descriptionKey="resource.apiAccess.description"
      action={
        canWrite ? (
          <Button
            className="w-full sm:w-auto"
            onClick={() => setOpen(true)}
            data-testid="api-key-create"
          >
            <Plus data-icon="inline-start" />
            {t("apiKeys.create")}
          </Button>
        ) : undefined
      }
    >
      {query.isPending ? (
        <LoadingCards testId="api-keys-loading" />
      ) : !query.data?.items.length ? (
        <EmptyCard text={t("resource.apiAccess.empty")} testId="api-keys-empty" />
      ) : (
        <div className="grid gap-2" data-testid="api-keys-list">
          {query.data.items.map((key, index) => (
            <Card key={key.id} size="sm" data-testid={`api-key-item-${index}`}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{key.name || t("apiKeys.unnamed")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {key.prefix} · {t("apiKeys.created", { date: dateTime(key.created_at) })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {key.scopes.map((scope) => (
                      <Badge key={scope} variant="secondary">
                        {scope}
                      </Badge>
                    ))}
                  </div>
                </div>
                {!key.revoked_at && (
                  <div className="flex gap-2">
                    <IconButton
                      label={t("apiKeys.rotate")}
                      data-testid={`api-key-rotate-${index}`}
                      onClick={() => rotate.mutate(key.id)}
                    >
                      <RotateCw />
                    </IconButton>
                    <IconButton
                      label={t("apiKeys.revoke")}
                      data-testid={`api-key-revoke-${index}`}
                      onClick={() => setRevoke(key)}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
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
              <FieldLabel htmlFor="api-key-scopes">{t("apiKeys.scopes")}</FieldLabel>
              <Textarea
                id="api-key-scopes"
                value={scopes}
                onChange={(event) => setScopes(event.target.value)}
                data-testid="api-key-create-scopes"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              data-testid="api-key-create-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!name.trim() || issue.isPending}
              onClick={() => issue.mutate()}
              data-testid="api-key-create-submit"
            >
              {t("apiKeys.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={Boolean(revoke)} onOpenChange={(next) => !next && setRevoke(null)}>
        <AlertDialogContent data-testid="api-key-revoke-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apiKeys.revoke")}</AlertDialogTitle>
            <AlertDialogDescription>{t("apiKeys.revokeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="api-key-revoke-cancel">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => revoke && remove.mutate(revoke.id)}
              data-testid="api-key-revoke-confirm"
            >
              {t("apiKeys.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SecretDialog secret={secret} onClose={() => setSecret(null)} title={t("apiKeys.ready")} />
    </AdminFrame>
  );
}

function AccessCollection<T extends { id?: string; name?: string; description?: string | null }>({
  items,
  empty,
  testId,
  render,
}: {
  items: T[];
  empty: string;
  testId: string;
  render?: (item: T, index: number) => ReactNode;
}) {
  if (!items.length) return <EmptyCard text={empty} testId={`${testId}-empty`} />;
  return (
    <div className="grid gap-2" data-testid={testId}>
      {items.map((item, index) =>
        render ? (
          render(item, index)
        ) : (
          <Card key={item.id ?? index} size="sm" data-testid={`${testId}-${index}`}>
            <CardHeader>
              <CardTitle>{item.name}</CardTitle>
              {item.description && <CardDescription>{item.description}</CardDescription>}
            </CardHeader>
          </Card>
        ),
      )}
    </div>
  );
}

export function AccessPage() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("rbac:write");
  const [activeTab, setActiveTab] = useState<AccessTab>("roles");
  const [createKind, setCreateKind] = useState<"role" | "group" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantSubjectType, setGrantSubjectType] = useState<"user" | "group">("user");
  const [grantSubjectId, setGrantSubjectId] = useState("");
  const [grantResourceId, setGrantResourceId] = useState("");
  const [grantPermission, setGrantPermission] = useState("workflow:read");
  const [managedRole, setManagedRole] = useState<RoleItem | null>(null);
  const roles = useQuery({
    queryKey: ["admin", "roles"],
    queryFn: () => apiRequest<Envelope<RoleItem>>("/v1/rbac/roles"),
  });
  const groups = useQuery({
    queryKey: ["admin", "groups"],
    queryFn: () => apiRequest<Envelope<GroupItem>>("/v1/rbac/groups"),
  });
  const grants = useQuery({
    queryKey: ["admin", "grants"],
    queryFn: () => apiRequest<Envelope<GrantItem>>("/v1/rbac/grants"),
  });
  const permissions = useQuery({
    queryKey: ["admin", "permissions"],
    queryFn: () => apiRequest<Envelope<PermissionItem>>("/v1/rbac/permissions"),
  });
  const people = useQuery({
    queryKey: ["admin", "people"],
    queryFn: () => apiRequest<Envelope<UserItem>>("/v1/identity/users?limit=200"),
  });
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    queryFn: () => apiRequest<Envelope<WorkflowItem>>("/v1/workflows?limit=200"),
  });
  const roleDetail = useQuery({
    queryKey: ["admin", "role", managedRole?.id],
    queryFn: () =>
      apiRequest<RoleDetail>(`/v1/rbac/roles/${encodeURIComponent(managedRole?.id ?? "")}`),
    enabled: Boolean(managedRole),
  });
  const create = useMutation({
    mutationFn: () =>
      apiRequest(createKind === "role" ? "/v1/rbac/roles" : "/v1/rbac/groups", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      }),
    onSuccess: async () => {
      const kind = createKind;
      setCreateKind(null);
      setName("");
      setDescription("");
      await client.invalidateQueries({ queryKey: ["admin", kind === "role" ? "roles" : "groups"] });
      toast.success(t("access.created"));
    },
  });
  const revokeGrant = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/rbac/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin", "grants"] }),
  });
  const createGrant = useMutation({
    mutationFn: () =>
      apiRequest("/v1/rbac/grants", {
        method: "POST",
        body: JSON.stringify({
          subject_type: grantSubjectType,
          subject_id: grantSubjectId,
          resource_type: "workflow",
          resource_id: grantResourceId,
          permission: grantPermission,
        }),
      }),
    onSuccess: async () => {
      setGrantOpen(false);
      await client.invalidateQueries({ queryKey: ["admin", "grants"] });
      toast.success(t("access.grantCreated"));
    },
  });
  const changeRolePermission = useMutation({
    mutationFn: ({ permission, enabled }: { permission: string; enabled: boolean }) =>
      apiRequest(
        `/v1/rbac/roles/${encodeURIComponent(managedRole?.id ?? "")}/permissions${enabled ? "" : `/${encodeURIComponent(permission)}`}`,
        {
          method: enabled ? "POST" : "DELETE",
          ...(enabled ? { body: JSON.stringify({ permission }) } : {}),
        },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin", "role", managedRole?.id] }),
  });
  const subjectItems =
    grantSubjectType === "user" ? (people.data?.items ?? []) : (groups.data?.items ?? []);
  const subjectName = (grant: GrantItem) => {
    if (grant.subject_type === "user")
      return (
        people.data?.items.find((item) => item.id === grant.subject_id)?.email ?? t("access.person")
      );
    return (
      groups.data?.items.find((item) => item.id === grant.subject_id)?.name ?? t("access.group")
    );
  };
  const workflowName = (grant: GrantItem) => {
    const workflow = workflows.data?.items.find((item) => item.id === grant.resource_id);
    return workflow?.name || workflow?.slug || t("access.workflow");
  };
  return (
    <AdminFrame
      testId="admin-access"
      titleKey="resource.access.title"
      descriptionKey="resource.access.description"
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as AccessTab)}
        data-testid="access-tabs"
      >
        <Select value={activeTab} onValueChange={(value) => setActiveTab(value as AccessTab)}>
          <SelectTrigger
            className="w-full sm:hidden"
            aria-label={t("access.section")}
            data-testid="access-mobile-section"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(["roles", "groups", "grants", "permissions"] as const).map((value) => (
                <SelectItem key={value} value={value} data-testid={`access-mobile-${value}`}>
                  {t(`access.${value}`)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <TabsList
          variant="line"
          className="hidden h-auto w-full grid-cols-4 sm:grid"
          data-testid="access-tab-list"
        >
          <TabsTrigger value="roles" data-testid="access-tab-roles">
            {t("access.roles")}
          </TabsTrigger>
          <TabsTrigger value="groups" data-testid="access-tab-groups">
            {t("access.groups")}
          </TabsTrigger>
          <TabsTrigger value="grants" data-testid="access-tab-grants">
            {t("access.grants")}
          </TabsTrigger>
          <TabsTrigger value="permissions" data-testid="access-tab-permissions">
            {t("access.permissions")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="roles" className="grid gap-4 pt-4">
          <div className="flex justify-end">
            {canWrite && (
              <Button
                className="w-full sm:w-auto"
                onClick={() => setCreateKind("role")}
                data-testid="role-create"
              >
                <Plus data-icon="inline-start" />
                {t("access.createRole")}
              </Button>
            )}
          </div>
          {roles.isPending ? (
            <LoadingCards testId="roles-loading" />
          ) : (
            <AccessCollection
              items={roles.data?.items ?? []}
              empty={t("access.noRoles")}
              testId="roles-list"
              render={(role, index) => (
                <Card key={role.id} size="sm" data-testid={`roles-list-${index}`}>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <CardTitle>{roleLabel(role.name, t)}</CardTitle>
                      {role.is_builtin && <Badge variant="secondary">{t("access.builtin")}</Badge>}
                    </div>
                    {builtinRoleDescription(role.name, role.description, t) && (
                      <CardDescription>
                        {builtinRoleDescription(role.name, role.description, t)}
                      </CardDescription>
                    )}
                    {canWrite && !role.is_builtin && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 w-fit"
                        onClick={() => setManagedRole(role)}
                        data-testid={`role-manage-${index}`}
                      >
                        {t("access.managePermissions")}
                      </Button>
                    )}
                  </CardHeader>
                </Card>
              )}
            />
          )}
        </TabsContent>
        <TabsContent value="groups" className="grid gap-4 pt-4">
          <div className="flex justify-end">
            {canWrite && (
              <Button
                className="w-full sm:w-auto"
                onClick={() => setCreateKind("group")}
                data-testid="group-create"
              >
                <Plus data-icon="inline-start" />
                {t("access.createGroup")}
              </Button>
            )}
          </div>
          {groups.isPending ? (
            <LoadingCards testId="groups-loading" />
          ) : (
            <AccessCollection
              items={groups.data?.items ?? []}
              empty={t("access.noGroups")}
              testId="groups-list"
            />
          )}
        </TabsContent>
        <TabsContent value="grants" className="pt-4">
          <div className="mb-4 flex justify-end">
            {canWrite && (
              <Button
                className="w-full sm:w-auto"
                onClick={() => setGrantOpen(true)}
                data-testid="grant-create"
              >
                <Plus data-icon="inline-start" />
                {t("access.createGrant")}
              </Button>
            )}
          </div>
          {grants.isPending ? (
            <LoadingCards testId="grants-loading" />
          ) : (
            <AccessCollection
              items={grants.data?.items ?? []}
              empty={t("access.noGrants")}
              testId="grants-list"
              render={(grant, index) => (
                <Card key={grant.id} size="sm" data-testid={`grants-list-${index}`}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{permissionLabel(grant.permission, t)}</p>
                      <p className="text-xs text-muted-foreground">
                        {subjectName(grant)} · {workflowName(grant)} · {grant.permission}
                      </p>
                    </div>
                    {canWrite && (
                      <IconButton
                        label={t("access.revokeGrant")}
                        data-testid={`grant-revoke-${index}`}
                        onClick={() => revokeGrant.mutate(grant.id)}
                      >
                        <Trash2 />
                      </IconButton>
                    )}
                  </CardContent>
                </Card>
              )}
            />
          )}
        </TabsContent>
        <TabsContent value="permissions" className="pt-4">
          {permissions.isPending ? (
            <LoadingCards testId="permissions-loading" />
          ) : (
            <AccessCollection
              items={(permissions.data?.items ?? []).map((permission) => ({
                ...permission,
                id: permission.name,
              }))}
              empty={t("access.noPermissions")}
              testId="permissions-list"
              render={(permission, index) => (
                <Card key={permission.name} size="sm" data-testid={`permissions-list-${index}`}>
                  <CardHeader>
                    <CardTitle>{permissionLabel(permission.name, t)}</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {permission.name}
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            />
          )}
        </TabsContent>
      </Tabs>
      <Dialog open={Boolean(createKind)} onOpenChange={(open) => !open && setCreateKind(null)}>
        <DialogContent showCloseButton={false} data-testid="access-create-dialog">
          <DialogHeader>
            <DialogTitle>
              {t(createKind === "role" ? "access.createRole" : "access.createGroup")}
            </DialogTitle>
            <DialogDescription>{t("access.createDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="access-name">{t("common.name")}</FieldLabel>
              <Input
                id="access-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                data-testid="access-create-name"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="access-description">{t("common.description")}</FieldLabel>
              <Textarea
                id="access-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                data-testid="access-create-description"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateKind(null)}
              data-testid="access-create-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
              data-testid="access-create-submit"
            >
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent showCloseButton={false} data-testid="grant-create-dialog">
          <DialogHeader>
            <DialogTitle>{t("access.createGrant")}</DialogTitle>
            <DialogDescription>{t("access.grantDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>{t("access.subjectType")}</FieldLabel>
              <Select
                value={grantSubjectType}
                onValueChange={(value) => {
                  setGrantSubjectType(value as "user" | "group");
                  setGrantSubjectId("");
                }}
              >
                <SelectTrigger className="w-full" data-testid="grant-subject-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="user" data-testid="grant-subject-type-user">
                      {t("access.person")}
                    </SelectItem>
                    <SelectItem value="group" data-testid="grant-subject-type-group">
                      {t("access.group")}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t("access.subject")}</FieldLabel>
              <Select value={grantSubjectId} onValueChange={setGrantSubjectId}>
                <SelectTrigger className="w-full" data-testid="grant-subject">
                  <SelectValue placeholder={t("access.chooseSubject")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {subjectItems.map((item, index) => (
                      <SelectItem
                        key={item.id}
                        value={item.id}
                        data-testid={`grant-subject-${index}`}
                      >
                        {"email" in item ? item.email : item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t("access.workflow")}</FieldLabel>
              <Select value={grantResourceId} onValueChange={setGrantResourceId}>
                <SelectTrigger className="w-full" data-testid="grant-workflow">
                  <SelectValue placeholder={t("access.chooseWorkflow")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(workflows.data?.items ?? []).map((workflow, index) => (
                      <SelectItem
                        key={workflow.id}
                        value={workflow.id}
                        data-testid={`grant-workflow-${index}`}
                      >
                        {workflow.name || workflow.slug || t("access.workflow")}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t("access.permissions")}</FieldLabel>
              <Select value={grantPermission} onValueChange={setGrantPermission}>
                <SelectTrigger className="w-full" data-testid="grant-permission">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(permissions.data?.items ?? [])
                      .filter((permission) => permission.resource_type === "workflow")
                      .map((permission, index) => (
                        <SelectItem
                          key={permission.name}
                          value={permission.name}
                          data-testid={`grant-permission-${index}`}
                        >
                          {permissionLabel(permission.name, t)}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGrantOpen(false)}
              data-testid="grant-create-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={
                !grantSubjectId || !grantResourceId || !grantPermission || createGrant.isPending
              }
              onClick={() => createGrant.mutate()}
              data-testid="grant-create-submit"
            >
              {t("access.createGrant")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(managedRole)} onOpenChange={(open) => !open && setManagedRole(null)}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-lg"
          data-testid="role-permissions-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t("access.managePermissions")}</DialogTitle>
            <DialogDescription>{managedRole?.name}</DialogDescription>
          </DialogHeader>
          <div
            className="flex max-h-96 flex-col gap-2 overflow-y-auto"
            data-testid="role-permissions-list"
          >
            {(permissions.data?.items ?? []).map((permission, index) => {
              const checked = roleDetail.data?.permissions.includes(permission.name) ?? false;
              return (
                <div key={permission.name} className="flex items-start gap-3 rounded-lg border p-3">
                  <Checkbox
                    checked={checked}
                    aria-label={permission.name}
                    onCheckedChange={(value) =>
                      changeRolePermission.mutate({
                        permission: permission.name,
                        enabled: value === true,
                      })
                    }
                    data-testid={`role-permission-${index}`}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{permissionLabel(permission.name, t)}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {permission.name}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button onClick={() => setManagedRole(null)} data-testid="role-permissions-done">
              {t("common.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminFrame>
  );
}

export function OperationsPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["admin", "operations"],
    queryFn: () => apiRequest<HealthDigest>("/v1/operator/health-digest"),
  });
  const scan = useMutation({
    mutationFn: () =>
      apiRequest("/v1/self-healing/scans", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin", "operations"] });
      toast.success(t("operations.scanStarted"));
    },
  });
  return (
    <AdminFrame
      testId="admin-operations"
      titleKey="resource.operations.title"
      descriptionKey="resource.operations.description"
      action={
        session.permissions.includes("self_healing:write") ? (
          <Button
            className="w-full sm:w-auto"
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
            data-testid="operations-scan"
          >
            <ScanSearch data-icon="inline-start" />
            {t("operations.scan")}
          </Button>
        ) : undefined
      }
    >
      {query.isPending ? (
        <LoadingCards testId="operations-loading" />
      ) : (
        query.data && (
          <div className="grid gap-4">
            <Card data-testid="operations-summary">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle>
                    {query.data.all_clear
                      ? t("operations.summaryAllClear")
                      : t("operations.summaryAttention", {
                          failures: query.data.failure_groups.length,
                          patches: query.data.patch_candidates.pending,
                        })}
                  </CardTitle>
                  <Badge variant={query.data.all_clear ? "secondary" : "destructive"}>
                    {query.data.all_clear ? t("operations.healthy") : t("operations.attention")}
                  </Badge>
                </div>
                <CardDescription>
                  {t("operations.generated", { date: dateTime(query.data.generated_at) })}
                </CardDescription>
              </CardHeader>
            </Card>
            <section className="grid gap-3 lg:grid-cols-2">
              <Card data-testid="operations-failures">
                <CardHeader>
                  <CardTitle>{t("operations.failures")}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {query.data.failure_groups.length ? (
                    query.data.failure_groups.map((failure, index) => (
                      <div
                        key={`${failure.cause}-${index}`}
                        className="rounded-lg border p-3"
                        data-testid={`operations-failure-${index}`}
                      >
                        <p className="font-medium">{failure.workflow_name || failure.cause}</p>
                        <p className="text-sm text-muted-foreground">
                          {failure.cause} · {failure.count}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("operations.noFailures")}</p>
                  )}
                </CardContent>
              </Card>
              <Card data-testid="operations-risks">
                <CardHeader>
                  <CardTitle>{t("operations.risks")}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {query.data.risk.length ? (
                    query.data.risk.map((risk, index) => (
                      <div
                        key={`${risk.headline}-${index}`}
                        className="rounded-lg border p-3"
                        data-testid={`operations-risk-${index}`}
                      >
                        <div className="flex gap-2">
                          <p className="font-medium">{risk.headline}</p>
                          <Badge variant={risk.severity === "critical" ? "destructive" : "outline"}>
                            {t(
                              risk.severity === "critical"
                                ? "severity.critical"
                                : "severity.warning",
                            )}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{risk.detail}</p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("operations.noRisks")}</p>
                  )}
                </CardContent>
              </Card>
            </section>
          </div>
        )
      )}
    </AdminFrame>
  );
}

function parseSettingValue(raw: string, original: unknown): unknown {
  if (typeof original === "boolean") return raw === "true";
  if (typeof original === "number") return Number(raw);
  if (Array.isArray(original) || (original && typeof original === "object")) return JSON.parse(raw);
  return raw;
}

const SETTING_SECTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  auth: "settings.section.auth",
  connectors: "settings.section.connectors",
  database: "settings.section.database",
  egress: "settings.section.egress",
  errors: "settings.section.errors",
  llm: "settings.section.llm",
  log: "settings.section.log",
  mcp: "settings.section.mcp",
  notifications: "settings.section.notifications",
  observability: "settings.section.observability",
  platform: "settings.section.platform",
  queue: "settings.section.queue",
  repl: "settings.section.repl",
  sandbox: "settings.section.sandbox",
  server: "settings.section.server",
  spec: "settings.section.spec",
  storage: "settings.section.storage",
  tokens: "settings.section.tokens",
  ui: "settings.section.ui",
};

function settingSection(path: string, t: ReturnType<typeof useI18n>["t"]): string {
  const section = path.split(".")[0] ?? "";
  const key = SETTING_SECTION_KEYS[section];
  return key ? t(key) : t("settings.section.other");
}

function settingLabel(path: string, t: ReturnType<typeof useI18n>["t"]): string {
  const lower = path.toLowerCase();
  const provider = [
    "anthropic",
    "openai",
    "gemini",
    "azure",
    "bedrock",
    "vertex",
    "ai_gateway",
  ].find((name) => lower.includes(`.${name}.`));
  const providerLabels: Readonly<Record<string, string>> = {
    ai_gateway: "AI Gateway",
    anthropic: "Anthropic",
    azure: "Azure",
    bedrock: "Amazon Bedrock",
    gemini: "Gemini",
    openai: "OpenAI",
    vertex: "Google Vertex AI",
  };
  const providerLabel = provider ? providerLabels[provider] : null;
  const key = lower.includes("enabled")
    ? "settings.label.enabled"
    : lower.includes("model")
      ? "settings.label.model"
      : lower.includes("provider")
        ? "settings.label.provider"
        : lower.includes("key") || lower.includes("secret") || lower.includes("password")
          ? "settings.label.secret"
          : lower.includes("endpoint")
            ? "settings.label.endpoint"
            : lower.includes("url")
              ? "settings.label.url"
              : lower.includes("timeout") || lower.endsWith("_ms")
                ? "settings.label.timeout"
                : lower.includes("ttl")
                  ? "settings.label.ttl"
                  : lower.includes("threshold") ||
                      lower.includes("_pct") ||
                      lower.includes("fraction")
                    ? "settings.label.threshold"
                    : lower.includes("max_") || lower.includes("cap") || lower.includes("limit")
                      ? "settings.label.limit"
                      : lower.includes("format")
                        ? "settings.label.format"
                        : lower.includes("level")
                          ? "settings.label.level"
                          : lower.includes("mode")
                            ? "settings.label.mode"
                            : lower.includes("region") || lower.includes("location")
                              ? "settings.label.region"
                              : lower.includes("bucket")
                                ? "settings.label.bucket"
                                : lower.includes("port")
                                  ? "settings.label.port"
                                  : lower.includes("concurrency")
                                    ? "settings.label.concurrency"
                                    : lower.includes("retention")
                                      ? "settings.label.retention"
                                      : lower.includes("budget")
                                        ? "settings.label.budget"
                                        : lower.includes("theme")
                                          ? "settings.label.theme"
                                          : "settings.label.value";
  return providerLabel
    ? t("settings.providerLabel", { provider: providerLabel, label: t(key) })
    : t(key);
}

function settingMetaLabel(value: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key: Record<string, TranslationKey> = {
    default: "settings.meta.default",
    env: "settings.meta.environment",
    environment: "settings.meta.environment",
    global: "settings.meta.global",
    tenant: "settings.meta.workspace",
    override: "settings.meta.override",
    workspace: "settings.meta.workspace",
  };
  const labelKey = key[value.toLowerCase()];
  return labelKey ? t(labelKey) : t("common.unknown");
}

export function SettingsPage() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("settings:write");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [restartSetting, setRestartSetting] = useState<SettingItem | null>(null);
  const query = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => apiRequest<Envelope<SettingItem>>("/v1/settings"),
  });
  const items = useMemo(
    () =>
      (query.data?.items ?? []).filter((item) =>
        item.path.toLowerCase().includes(search.toLowerCase()),
      ),
    [query.data, search],
  );
  const changedItems = useMemo(
    () => items.filter((item) => Object.hasOwn(drafts, item.path)),
    [drafts, items],
  );
  const sections = useMemo(() => {
    const grouped = new Map<string, SettingItem[]>();
    for (const item of items) {
      const section = item.path.split(".")[0] ?? "other";
      grouped.set(section, [...(grouped.get(section) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [items]);
  const save = useMutation({
    mutationFn: async ({
      items: pending,
      force = false,
    }: {
      items: SettingItem[];
      force?: boolean;
    }) => {
      for (const item of pending) {
        await apiRequest(`/v1/settings/${encodeURIComponent(item.path)}`, {
          method: "PUT",
          headers: { "x-subkit-audit-source": "ui" },
          body: JSON.stringify({
            value: parseSettingValue(drafts[item.path] ?? String(item.value ?? ""), item.value),
            force: force && item.meta.requiresRestart,
          }),
        });
      }
    },
    onSuccess: async () => {
      setDrafts({});
      setRestartSetting(null);
      await client.invalidateQueries({ queryKey: ["admin", "settings"] });
      toast.success(t("settings.saved"));
    },
    onError: () => toast.error(t("settings.saveFailed")),
  });
  return (
    <AdminFrame
      testId="admin-settings"
      titleKey="resource.settings.title"
      descriptionKey="resource.settings.description"
    >
      <div className="mb-4 flex items-center gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("settings.search")}
          data-testid="settings-search"
        />
        <IconButton
          label={t("common.refresh")}
          data-testid="settings-refresh"
          onClick={() => query.refetch()}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {query.isPending ? (
        <LoadingCards testId="settings-loading" />
      ) : (
        <div className="grid gap-4 pb-20" data-testid="settings-list">
          {sections.map(([section, sectionItems], sectionIndex) => (
            <Card key={section} data-testid={`settings-section-${sectionIndex}`}>
              <CardHeader>
                <CardTitle>{settingSection(`${section}.value`, t)}</CardTitle>
                <CardDescription>{t("settings.sectionDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  {sectionItems.map((item) => {
                    const index = items.indexOf(item);
                    const value =
                      drafts[item.path] ??
                      (item.meta.sensitive
                        ? ""
                        : typeof item.value === "string"
                          ? item.value
                          : JSON.stringify(item.value));
                    return (
                      <Field
                        key={item.path}
                        orientation="responsive"
                        data-disabled={!canWrite || undefined}
                        className="border-t pt-4 first:border-t-0 first:pt-0"
                        data-testid={`setting-item-${index}`}
                      >
                        <FieldLabel
                          className="min-w-0 @md/field-group:max-w-64"
                          htmlFor={`setting-${index}`}
                        >
                          <span className="truncate">{settingLabel(item.path, t)}</span>
                          <ContextHelp
                            label={t("settings.about", { setting: settingLabel(item.path, t) })}
                            testId={`setting-help-${index}`}
                          >
                            {t("settings.resolution", {
                              path: item.path,
                              source: settingMetaLabel(item.meta.source, t),
                              scope: settingMetaLabel(item.meta.scope, t),
                            })}
                          </ContextHelp>
                        </FieldLabel>
                        <FieldContent className="min-w-0">
                          {typeof item.value === "boolean" ? (
                            <Switch
                              id={`setting-${index}`}
                              checked={value === "true"}
                              onCheckedChange={(checked) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [item.path]: String(checked),
                                }))
                              }
                              disabled={!canWrite || save.isPending}
                              aria-label={settingLabel(item.path, t)}
                              data-testid={`setting-input-${index}`}
                            />
                          ) : (
                            <Input
                              id={`setting-${index}`}
                              type={item.meta.sensitive ? "password" : "text"}
                              value={value}
                              placeholder={
                                item.meta.sensitive ? t("settings.secretPlaceholder") : undefined
                              }
                              onChange={(event) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [item.path]: event.target.value,
                                }))
                              }
                              disabled={!canWrite || save.isPending}
                              data-testid={`setting-input-${index}`}
                            />
                          )}
                          <FieldDescription className="flex flex-wrap gap-1.5 pt-1">
                            <Badge variant="secondary">
                              {settingMetaLabel(item.meta.source, t)}
                            </Badge>
                            {item.meta.requiresRestart && (
                              <Badge variant="outline">{t("settings.restart")}</Badge>
                            )}
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    );
                  })}
                </FieldGroup>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {canWrite && changedItems.length > 0 && (
        <div
          className="sticky bottom-0 z-10 -mx-1 mt-4 flex flex-col gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          role="status"
          data-testid="settings-change-bar"
        >
          <p className="text-sm font-medium">
            {t("settings.unsavedCount", { count: changedItems.length })}
          </p>
          <div className="flex gap-2">
            <Button
              className="flex-1 sm:flex-none"
              variant="outline"
              disabled={save.isPending}
              onClick={() => setDrafts({})}
              data-testid="settings-discard"
            >
              {t("common.discard")}
            </Button>
            <Button
              className="flex-1 sm:flex-none"
              disabled={save.isPending}
              onClick={() => {
                const restart = changedItems.find((item) => item.meta.requiresRestart);
                restart ? setRestartSetting(restart) : save.mutate({ items: changedItems });
              }}
              data-testid="settings-save"
            >
              {save.isPending && <Spinner data-icon="inline-start" />}
              {t("common.saveChanges")}
            </Button>
          </div>
        </div>
      )}
      <AlertDialog
        open={Boolean(restartSetting)}
        onOpenChange={(open) => !open && setRestartSetting(null)}
      >
        <AlertDialogContent data-testid="settings-restart-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.restartDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="settings-restart-cancel">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (restartSetting) save.mutate({ items: changedItems, force: true });
              }}
              data-testid="settings-restart-confirm"
            >
              {t("settings.saveAndRestart")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminFrame>
  );
}
