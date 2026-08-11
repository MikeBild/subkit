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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

type Envelope<T> = { items: T[] };
type RoleName = "admin" | "member" | "enduser";

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
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 sm:px-8">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{t(titleKey)}</h1>
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
  return (
    <div
      className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"
      data-testid={testId}
    >
      {text}
    </div>
  );
}

function roleLabel(role: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key: Record<string, TranslationKey> = {
    admin: "role.admin",
    member: "role.member",
    enduser: "role.enduser",
  };
  return key[role] ? t(key[role]) : role;
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
          <Button onClick={() => setCreateOpen(true)} data-testid="people-create">
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
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{user.email}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Badge variant="outline">{roleLabel(user.effective_role, t)}</Badge>
                    <Badge variant="secondary">{user.status}</Badge>
                    {!user.role_consistent && (
                      <Badge variant="destructive" data-testid={`people-role-drift-${index}`}>
                        {t("people.roleDrift")}
                      </Badge>
                    )}
                  </div>
                </div>
                {canWrite && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={user.effective_role}
                      onValueChange={(value) =>
                        update.mutate({ id: user.id, nextRole: value as RoleName })
                      }
                    >
                      <SelectTrigger
                        className="w-36"
                        data-testid={`people-role-${index}`}
                        aria-label={t("people.role")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["admin", "member", "enduser"] as const).map((name) => (
                          <SelectItem
                            key={name}
                            value={name}
                            data-testid={`people-role-${index}-${name}`}
                          >
                            {roleLabel(name, t)}
                          </SelectItem>
                        ))}
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
              </CardContent>
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
                  {(["admin", "member", "enduser"] as const).map((name) => (
                    <SelectItem key={name} value={name} data-testid={`people-create-role-${name}`}>
                      {roleLabel(name, t)}
                    </SelectItem>
                  ))}
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
          <Button onClick={() => setOpen(true)} data-testid="api-key-create">
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
      <Tabs defaultValue="roles" data-testid="access-tabs">
        <TabsList
          variant="line"
          className="grid h-auto w-full grid-cols-2 sm:grid-cols-4"
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
              <Button onClick={() => setCreateKind("role")} data-testid="role-create">
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
                    {role.description && <CardDescription>{role.description}</CardDescription>}
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
              <Button onClick={() => setCreateKind("group")} data-testid="group-create">
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
              <Button onClick={() => setGrantOpen(true)} data-testid="grant-create">
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
                      <p className="font-medium">{grant.permission}</p>
                      <p className="text-xs text-muted-foreground">
                        {subjectName(grant)} · {workflowName(grant)}
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
                    <CardTitle>{permission.name}</CardTitle>
                    <CardDescription>{permission.description}</CardDescription>
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
                  <SelectItem value="user" data-testid="grant-subject-type-user">
                    {t("access.person")}
                  </SelectItem>
                  <SelectItem value="group" data-testid="grant-subject-type-group">
                    {t("access.group")}
                  </SelectItem>
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
                  {subjectItems.map((item, index) => (
                    <SelectItem
                      key={item.id}
                      value={item.id}
                      data-testid={`grant-subject-${index}`}
                    >
                      {"email" in item ? item.email : item.name}
                    </SelectItem>
                  ))}
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
                  {(workflows.data?.items ?? []).map((workflow, index) => (
                    <SelectItem
                      key={workflow.id}
                      value={workflow.id}
                      data-testid={`grant-workflow-${index}`}
                    >
                      {workflow.name || workflow.slug || t("access.workflow")}
                    </SelectItem>
                  ))}
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
                  {(permissions.data?.items ?? [])
                    .filter((permission) => permission.resource_type === "workflow")
                    .map((permission, index) => (
                      <SelectItem
                        key={permission.name}
                        value={permission.name}
                        data-testid={`grant-permission-${index}`}
                      >
                        {permission.name}
                      </SelectItem>
                    ))}
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
          <div className="max-h-96 space-y-2 overflow-y-auto" data-testid="role-permissions-list">
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
                    <span className="block font-medium">{permission.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {permission.description}
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
                  <CardTitle>{query.data.headline}</CardTitle>
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
                            {risk.severity}
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
  const save = useMutation({
    mutationFn: ({ item, force = false }: { item: SettingItem; force?: boolean }) =>
      apiRequest(`/v1/settings/${encodeURIComponent(item.path)}`, {
        method: "PUT",
        headers: { "x-subkit-audit-source": "ui" },
        body: JSON.stringify({
          value: parseSettingValue(drafts[item.path] ?? String(item.value ?? ""), item.value),
          force,
        }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin", "settings"] });
      toast.success(t("settings.saved"));
    },
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
        <div className="grid gap-2" data-testid="settings-list">
          {items.map((item, index) => {
            const value =
              drafts[item.path] ??
              (item.meta.sensitive
                ? ""
                : typeof item.value === "string"
                  ? item.value
                  : JSON.stringify(item.value));
            return (
              <Card key={item.path} size="sm" data-testid={`setting-item-${index}`}>
                <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1fr)_auto] lg:items-end">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{item.path}</p>
                    <div className="mt-1 flex gap-1">
                      <Badge variant="secondary">{item.meta.source}</Badge>
                      {item.meta.requiresRestart && (
                        <Badge variant="outline">{t("settings.restart")}</Badge>
                      )}
                    </div>
                  </div>
                  <Field>
                    <FieldLabel className="sr-only" htmlFor={`setting-${index}`}>
                      {item.path}
                    </FieldLabel>
                    <Input
                      id={`setting-${index}`}
                      type={item.meta.sensitive ? "password" : "text"}
                      value={value}
                      placeholder={
                        item.meta.sensitive ? t("settings.secretPlaceholder") : undefined
                      }
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [item.path]: event.target.value }))
                      }
                      disabled={!canWrite}
                      data-testid={`setting-input-${index}`}
                    />
                  </Field>
                  {canWrite && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        item.meta.requiresRestart
                          ? setRestartSetting(item)
                          : save.mutate({ item, force: false })
                      }
                      disabled={save.isPending || drafts[item.path] === undefined}
                      data-testid={`setting-save-${index}`}
                    >
                      {t("common.save")}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
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
                if (restartSetting) save.mutate({ item: restartSetting, force: true });
                setRestartSetting(null);
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
