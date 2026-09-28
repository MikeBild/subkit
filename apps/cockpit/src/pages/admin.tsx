import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Plus,
  RefreshCw,
  ScanSearch,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, decisionsHref } from "@/app/links";
import { useSession } from "@/app/session";
import { AttentionList } from "@/components/cockpit/attention-list";
import { ContextHelp } from "@/components/cockpit/context-help";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { PreparedChanges } from "@/components/cockpit/prepared-changes";
import { LoadFailed, queryView } from "@/components/failure-state";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { catalogLabel, LabelText } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";
import { permissionLabel, roleLabel, settingMetaLabel } from "@/pages/admin-model";
import {
  componentLabelKey,
  drilldownHref,
  drilldownLabelKey,
  freshnessSourceLabelKey,
  healthStateLine,
  type OperationalOverview,
  operationsAttention,
  scanOutcome,
} from "@/pages/operations-model";

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
  /** Live connections this person approved — what a withdrawal would end. */
  oauth_connections?: number;
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

interface SettingsResponse {
  saved_revision: number | null;
  active_revision: number | null;
  activation_status: "saved" | "preparing" | "active" | "failed" | "restart_required" | null;
  pending_restart_fields: string[];
  items: SettingItem[];
  diagnostics: {
    pending_restart_keys: string[];
    override_keys: string[];
  };
}

type AuthProviderSetting =
  | {
      protocol: "api_key";
      id: string;
      label: string;
    }
  | {
      protocol: "oidc";
      id: string;
      label: string;
      issuer_url: string;
      client_id: string;
      scopes: string;
      tenant_slug: string;
    };

function AdminFrame({
  titleKey,
  descriptionKey,
  action,
  children,
  testId,
}: {
  titleKey: TranslationKey;
  /** Only where the title does not already say what the page is for. */
  descriptionKey?: TranslationKey;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <PageFrame
      testId={testId}
      title={t(titleKey)}
      {...(descriptionKey ? { description: t(descriptionKey) } : {})}
      action={action}
      scroll="page"
    >
      {children}
    </PageFrame>
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

/**
 * Nothing here yet, said once.
 *
 * Every empty card used to add "new records of the workspace appear here",
 * which restates the title and tells the reader nothing to do. Where there is
 * a next step on these pages it is the page's own action in the header.
 */
function EmptyCard({ text, testId }: { text: string; testId: string }) {
  return (
    <Empty className="min-h-52 border" data-testid={testId}>
      <EmptyHeader>
        <EmptyTitle>{text}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
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
      apiRequest<void>(`/v1/identity/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
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

  const view = queryView(query, (data) => data.items.length === 0);

  return (
    <AdminFrame
      testId="admin-people"
      titleKey="resource.people.title"
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
      {view === "loading" ? (
        <LoadingCards testId="people-loading" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("resource.people.title") })}
          onRetry={() => void query.refetch()}
          testId="people-load-failed"
        />
      ) : view === "empty" ? (
        <EmptyCard text={t("resource.people.empty")} testId="people-empty" />
      ) : (
        <div className="grid gap-2" data-testid="people-list">
          {(query.data?.items ?? []).map((user, index) => (
            <Card key={user.id} size="sm" data-testid={`people-item-${index}`}>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate text-sm">{user.email}</CardTitle>
                  <CardDescription className="mt-1 flex flex-wrap gap-2">
                    <Badge variant="outline">
                      <LabelText label={roleLabel(user.effective_role, t)} />
                    </Badge>
                    <Badge variant="secondary">{statusLabel(t, user.status)}</Badge>
                    {(user.oauth_connections ?? 0) > 0 && (
                      <Badge variant="outline" data-testid={`people-connections-${index}`}>
                        {t("people.connections", { count: String(user.oauth_connections ?? 0) })}
                      </Badge>
                    )}
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
                        update.mutate({
                          id: user.id,
                          nextRole: value as RoleName,
                        })
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
                              <LabelText label={roleLabel(name, t)} />
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
                        <LabelText label={roleLabel(name, t)} />
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
            <AlertDialogDescription data-testid="people-deactivate-description">
              {t("people.deactivateDescription", {
                email: deactivate?.email ?? "",
              })}
              {(deactivate?.oauth_connections ?? 0) > 0 && (
                <>
                  {" "}
                  {t("people.deactivateConnections", {
                    count: String(deactivate?.oauth_connections ?? 0),
                    email: deactivate?.email ?? "",
                  })}
                </>
              )}
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

/** A value shown once — a new key, an invitation — with a copy button. */
export function SecretDialog({
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

/**
 * One tab's list in all four of its states. Each tab used to ask only
 * "pending?" and then render the rows, so a failed read fell through to "no
 * roles" — an installation told it had no roles because a request failed.
 */
function AccessCollection<T extends { id?: string; name?: string; description?: string | null }>({
  name,
  query,
  items,
  failedTitle,
  empty,
  render,
}: {
  /** `roles` → `roles-loading`, `roles-load-failed`, `roles-list`, `roles-list-empty`. */
  name: string;
  query: Parameters<typeof queryView>[0] & { refetch(): unknown };
  items: T[];
  failedTitle: string;
  empty: string;
  render?: (item: T, index: number) => ReactNode;
}) {
  const testId = `${name}-list`;
  const view = queryView(query, () => items.length === 0);
  if (view === "loading") return <LoadingCards testId={`${name}-loading`} />;
  if (view === "error")
    return (
      <LoadFailed
        title={failedTitle}
        onRetry={() => void query.refetch()}
        testId={`${name}-load-failed`}
      />
    );
  if (view === "empty") return <EmptyCard text={empty} testId={`${testId}-empty`} />;
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
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
        }),
      }),
    onSuccess: async () => {
      const kind = createKind;
      setCreateKind(null);
      setName("");
      setDescription("");
      await client.invalidateQueries({
        queryKey: ["admin", kind === "role" ? "roles" : "groups"],
      });
      toast.success(t("access.created"));
    },
  });
  const revokeGrant = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/rbac/grants/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
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
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["admin", "role", managedRole?.id],
      }),
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
          <AccessCollection
            name="roles"
            query={roles}
            items={roles.data?.items ?? []}
            failedTitle={t("resource.loadFailed", { resource: t("access.roles") })}
            empty={t("access.noRoles")}
            render={(role, index) => (
              <Card key={role.id} size="sm" data-testid={`roles-list-${index}`}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle>
                      <LabelText label={roleLabel(role.name, t)} />
                    </CardTitle>
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
          <AccessCollection
            name="groups"
            query={groups}
            items={groups.data?.items ?? []}
            failedTitle={t("resource.loadFailed", { resource: t("access.groups") })}
            empty={t("access.noGroups")}
          />
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
          <AccessCollection
            name="grants"
            query={grants}
            items={grants.data?.items ?? []}
            failedTitle={t("resource.loadFailed", { resource: t("access.grants") })}
            empty={t("access.noGrants")}
            render={(grant, index) => (
              <Card key={grant.id} size="sm" data-testid={`grants-list-${index}`}>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <LabelText label={permissionLabel(grant.permission, t)} />
                    </p>
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
        </TabsContent>
        <TabsContent value="permissions" className="pt-4">
          <AccessCollection
            name="permissions"
            query={permissions}
            items={(permissions.data?.items ?? []).map((permission) => ({
              ...permission,
              id: permission.name,
            }))}
            failedTitle={t("resource.loadFailed", { resource: t("access.permissions") })}
            empty={t("access.noPermissions")}
            render={(permission, index) => (
              <Card key={permission.name} size="sm" data-testid={`permissions-list-${index}`}>
                <CardHeader>
                  <CardTitle>
                    <LabelText label={permissionLabel(permission.name, t)} />
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">{permission.name}</CardDescription>
                </CardHeader>
              </Card>
            )}
          />
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
                          <LabelText label={permissionLabel(permission.name, t)} />
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
                    <span className="block font-medium">
                      <LabelText label={permissionLabel(permission.name, t)} />
                    </span>
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

/**
 * Is this installation healthy, and if not, why.
 *
 * The page used to hold a scan button and a sentence saying its findings were
 * on the overview — while the overview's red health tile linked here. A loop
 * with a cause at neither end. It reads the same snapshot as the overview now
 * (one query key, one read) and owns the answer the overview's health tile can
 * only summarise: the problems first, each with its way to the cause, then
 * what the score is made of and how fresh the numbers behind it are.
 *
 * Checking and repairing stay two acts in one order (§13): the scan reads and
 * reports, and every repair it proposes becomes a decision a person makes.
 */
export function OperationsPage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["operational-overview", "v1"],
    queryFn: () => apiRequest<OperationalOverview>("/v1/operational-overview"),
  });
  const scan = useMutation({
    mutationFn: () =>
      apiRequest<components["schemas"]["SelfHealingScanResponse"]>("/v1/self-healing/scans", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({}),
      }),
    onSuccess: async (response) => {
      await client.invalidateQueries({ queryKey: ["operational-overview"] });
      await client.invalidateQueries({ queryKey: ["decisions"] });
      const outcome = scanOutcome(response);
      toast.success(
        t(outcome.key, { count: String(outcome.count) }),
        outcome.offerDecisions
          ? {
              action: {
                label: t("operations.openDecisions"),
                onClick: () => window.location.assign(absolute(decisionsHref())),
              },
            }
          : undefined,
      );
    },
  });
  const view = queryView(query, () => false);
  const formatValue = (raw: number, unit: string) =>
    unit === "ratio"
      ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(raw)
      : new Intl.NumberFormat(locale).format(raw);
  const snapshot = query.data;
  const attention = snapshot
    ? operationsAttention(snapshot, { t, dateTime, value: formatValue })
    : [];
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
      {view === "loading" ? (
        <LoadingCards testId="operations-loading" />
      ) : (
        <div className="grid gap-4">
          {/* The scan still works when the report could not be read, so the
              tools stay; the failure is said above them. An unread report is
              never shown as an empty — healthy — attention list. */}
          {view === "error" ? (
            <LoadFailed
              title={t("operations.loadFailed")}
              onRetry={() => void query.refetch()}
              testId="operations-load-failed"
            />
          ) : null}
          <AttentionList
            items={attention}
            title={t("operations.attention.title")}
            testId="operations-attention"
          />
          {snapshot ? <HealthBreakdown snapshot={snapshot} formatValue={formatValue} /> : null}
          <Card data-testid="operations-tools">
            <CardHeader>
              <CardTitle>{t("operations.scanTitle")}</CardTitle>
              <CardDescription>{t("operations.scanDescription")}</CardDescription>
            </CardHeader>
            {snapshot && (
              <CardContent>
                <p className="text-sm text-muted-foreground" data-testid="operations-generated">
                  {t("operations.generated", {
                    date: dateTime(snapshot.generated_at),
                  })}
                </p>
              </CardContent>
            )}
          </Card>
        </div>
      )}
    </AdminFrame>
  );
}

/**
 * What the health state is made of, and how fresh the numbers behind it are.
 *
 * Every row carries its value, its own state and the engine's way to what it
 * counts — a component at full marks included, because "why is it healthy"
 * is the same question asked the other way round.
 */
function HealthBreakdown({
  snapshot,
  formatValue,
}: {
  snapshot: OperationalOverview;
  formatValue: (raw: number, unit: string) => string;
}) {
  const { t, dateTime } = useI18n();
  const health = snapshot.core.health;
  const freshness = snapshot.core.data_freshness;
  return (
    <Card data-testid="operations-health">
      <CardHeader>
        <CardTitle>{t("operations.health.title")}</CardTitle>
        <CardDescription data-testid="operations-health-state">
          {healthStateLine(health.state, t)}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="grid gap-2">
          {health.components.map((component, index) => {
            const labelKey = componentLabelKey(component.id);
            const href = drilldownHref(component.drilldown);
            return (
              <li
                key={component.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm"
                data-testid={`operations-component-${index}`}
              >
                <span className="min-w-0">
                  <span className="font-medium">
                    <LabelText label={catalogLabel(component.id, labelKey ?? undefined, t)} />
                  </span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {component.raw_value === null
                      ? t(`operational.freshness.${component.freshness}` as TranslationKey)
                      : formatValue(component.raw_value, component.unit)}
                  </span>
                </span>
                {href ? (
                  <a
                    href={href}
                    className="text-sm font-medium underline underline-offset-4"
                    data-testid={`operations-component-${index}-open`}
                  >
                    {t(drilldownLabelKey(component.drilldown.label_id))}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="grid gap-2" data-testid="operations-freshness">
          <h3 className="text-sm font-semibold">
            {t("operational.core.freshness")}
            {" · "}
            <span className="font-normal text-muted-foreground">
              {t(`operational.freshness.${freshness.state}` as TranslationKey)}
            </span>
          </h3>
          <ul className="grid gap-2">
            {freshness.sources.map((source, index) => {
              const labelKey = freshnessSourceLabelKey(source.id);
              const href = drilldownHref(source.drilldown);
              return (
                <li
                  key={source.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm"
                  data-testid={`operations-freshness-${index}`}
                  data-state={source.state}
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      <LabelText label={catalogLabel(source.id, labelKey ?? undefined, t)} />
                    </span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {source.updated_at
                        ? t("operations.freshness.lastRun", { date: dateTime(source.updated_at) })
                        : t("operations.freshness.never")}
                      {" · "}
                      {t(`operational.freshness.${source.state}` as TranslationKey)}
                    </span>
                  </span>
                  {href ? (
                    <a
                      href={href}
                      className="text-sm font-medium underline underline-offset-4"
                      data-testid={`operations-freshness-${index}-open`}
                    >
                      {t(drilldownLabelKey(source.drilldown.label_id))}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

interface NotificationRuleItem {
  id: string;
  name: string;
  event_pattern: string;
  workflow_pattern: string;
  severity: string;
  target_channel_id: string;
  active: boolean;
}

interface NotificationChannelItem {
  id: string;
  platform: string;
  channel_id: string;
  default_severity: string;
  rate_limit_per_minute: number;
  circuit_state: string;
  active: boolean;
}

const CIRCUIT_LABEL: Readonly<Record<string, TranslationKey>> = {
  closed: "notifications.circuit.closed",
  open: "notifications.circuit.open",
  half_open: "notifications.circuit.halfOpen",
};

const SEVERITY_LABEL: Readonly<Record<string, TranslationKey>> = {
  debug: "notifications.severity.debug",
  info: "notifications.severity.info",
  warn: "notifications.severity.warn",
  error: "notifications.severity.error",
  critical: "notifications.severity.critical",
};

/**
 * Which events leave this installation, and through which channel.
 *
 * The delivery state is read as a word rather than through the shared status
 * label: a circuit phase the engine can store must never resolve to
 * "unknown" (§2), and the shared helper is allowed to fall through to it.
 */
export function NotificationsPage() {
  const { t } = useI18n();
  const rules = useQuery({
    queryKey: ["admin", "notification-rules"],
    queryFn: () => apiRequest<Envelope<NotificationRuleItem>>("/v1/notifications/rules"),
  });
  const channels = useQuery({
    queryKey: ["admin", "notification-channels"],
    queryFn: () => apiRequest<Envelope<NotificationChannelItem>>("/v1/notifications/channels"),
  });
  const ruleItems = rules.data?.items ?? [];
  const channelItems = channels.data?.items ?? [];
  const rulesView = queryView(rules, (data) => data.items.length === 0);
  const channelsView = queryView(channels, (data) => data.items.length === 0);
  const word = (map: Readonly<Record<string, TranslationKey>>, value: string, fallback: string) => {
    const key = map[value];
    return key ? t(key) : fallback;
  };

  return (
    <AdminFrame
      testId="admin-notifications"
      titleKey="resource.notifications.title"
      descriptionKey="resource.notifications.description"
    >
      {rulesView === "loading" || channelsView === "loading" ? (
        <LoadingCards testId="notifications-loading" />
      ) : rulesView === "error" || channelsView === "error" ? (
        // Either half missing makes the other misleading: rules without the
        // channels they deliver to cannot say where anything goes.
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("resource.notifications.title") })}
          onRetry={() => {
            void rules.refetch();
            void channels.refetch();
          }}
          testId="notifications-load-failed"
        />
      ) : ruleItems.length === 0 && channelItems.length === 0 ? (
        // Never used, not measured zero: the next step belongs in the empty
        // state, not in a manual somewhere else (§4).
        <Empty className="min-h-52 border" data-testid="notifications-empty">
          <EmptyHeader>
            <EmptyTitle>{t("notifications.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("notifications.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/chat" data-testid="notifications-empty-setup">
                {t("notifications.emptySetup")}
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4">
          <Card data-testid="notifications-rules">
            <CardHeader>
              <CardTitle>{t("notifications.rules")}</CardTitle>
              <CardDescription>{t("notifications.rulesDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {ruleItems.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="notifications-rules-none">
                  {t("notifications.noRules")}
                </p>
              ) : (
                ruleItems.map((rule, index) => (
                  <div
                    key={rule.id}
                    className="rounded-lg border p-3"
                    data-testid={`notifications-rule-${index}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 font-medium break-words">{rule.name}</p>
                      <Badge variant={rule.active ? "secondary" : "outline"}>
                        {t(rule.active ? "notifications.active" : "notifications.paused")}
                      </Badge>
                      <Badge variant="outline">
                        {word(SEVERITY_LABEL, rule.severity, rule.severity)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground break-words">
                      {t("notifications.ruleMatch", {
                        events: rule.event_pattern,
                        workflows: rule.workflow_pattern || "*",
                      })}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card data-testid="notifications-channels">
            <CardHeader>
              <CardTitle>{t("notifications.channels")}</CardTitle>
              <CardDescription>{t("notifications.channelsDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {channelItems.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="notifications-channels-none"
                >
                  {t("notifications.noChannels")}
                </p>
              ) : (
                channelItems.map((channel, index) => (
                  <div
                    key={channel.id}
                    className="rounded-lg border p-3"
                    data-testid={`notifications-channel-${index}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 font-medium break-words">{channel.platform}</p>
                      <Badge variant={channel.active ? "secondary" : "outline"}>
                        {t(channel.active ? "notifications.active" : "notifications.paused")}
                      </Badge>
                      <Badge
                        variant={channel.circuit_state === "closed" ? "outline" : "destructive"}
                      >
                        {word(
                          CIRCUIT_LABEL,
                          channel.circuit_state,
                          t("notifications.circuit.open"),
                        )}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground break-words">
                      {t("notifications.channelLimit", {
                        severity: word(
                          SEVERITY_LABEL,
                          channel.default_severity,
                          channel.default_severity,
                        ),
                        limit: String(channel.rate_limit_per_minute),
                      })}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
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

function authProvidersFrom(value: unknown): AuthProviderSetting[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (provider): provider is AuthProviderSetting =>
      typeof provider === "object" &&
      provider !== null &&
      ((provider as { protocol?: unknown }).protocol === "api_key" ||
        (provider as { protocol?: unknown }).protocol === "oidc"),
  );
}

function authProvidersFromDraft(raw: string | undefined, fallback: unknown): AuthProviderSetting[] {
  if (raw === undefined) return authProvidersFrom(fallback);
  try {
    return authProvidersFrom(JSON.parse(raw));
  } catch {
    return authProvidersFrom(fallback);
  }
}

function AuthProviderInput({
  label,
  testId,
  value,
  type = "text",
  disabled,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  type?: "text" | "url";
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium" htmlFor={testId}>
      {label}
      <Input
        id={testId}
        type={type}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function AuthProvidersEditor({
  value,
  publicBaseUrl,
  disabled,
  onChange,
}: {
  value: AuthProviderSetting[];
  publicBaseUrl: string;
  disabled: boolean;
  onChange: (value: AuthProviderSetting[]) => void;
}) {
  const { t } = useI18n();
  const callbackUrl = useMemo(() => {
    try {
      return new URL("/v1/identity/login/callback", publicBaseUrl).toString();
    } catch {
      return "/v1/identity/login/callback";
    }
  }, [publicBaseUrl]);

  function update(index: number, provider: AuthProviderSetting) {
    onChange(value.map((current, currentIndex) => (currentIndex === index ? provider : current)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <div className="grid gap-3" data-testid="settings-auth-providers">
      <div className="rounded-xl border border-border bg-muted/30 px-3 py-2">
        <p className="text-xs font-medium">{t("settings.auth.callbackUrl")}</p>
        <code className="mt-1 block break-all text-xs text-muted-foreground">{callbackUrl}</code>
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.auth.publicClientHint")}</p>
      </div>
      {value.map((provider, index) => (
        <div
          key={`${provider.protocol}-${provider.id}-${index}`}
          className="grid gap-3 rounded-xl border border-border p-4"
          data-testid={`settings-auth-provider-${index}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {provider.label || t("settings.auth.unnamedProvider")}
              </p>
              <p className="text-xs text-muted-foreground">
                {provider.protocol === "oidc"
                  ? t("settings.auth.oidcPublicClient")
                  : t("settings.auth.apiKey")}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                label={t("settings.auth.moveUp")}
                data-testid={`settings-auth-provider-${index}-move-up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                label={t("settings.auth.moveDown")}
                data-testid={`settings-auth-provider-${index}-move-down`}
                disabled={disabled || index === value.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </IconButton>
              <IconButton
                label={t("settings.auth.remove")}
                data-testid={`settings-auth-provider-${index}-remove`}
                disabled={disabled || value.length === 1}
                onClick={() => onChange(value.filter((_, currentIndex) => currentIndex !== index))}
              >
                <Trash2 />
              </IconButton>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <AuthProviderInput
              label={t("settings.auth.providerId")}
              testId={`settings-auth-provider-${index}-id`}
              value={provider.id}
              disabled={disabled}
              onChange={(id) => update(index, { ...provider, id })}
            />
            <AuthProviderInput
              label={t("settings.auth.label")}
              testId={`settings-auth-provider-${index}-label`}
              value={provider.label}
              disabled={disabled}
              onChange={(label) => update(index, { ...provider, label })}
            />
            {provider.protocol === "oidc" && (
              <>
                <div className="sm:col-span-2">
                  <AuthProviderInput
                    label={t("settings.auth.issuerUrl")}
                    testId={`settings-auth-provider-${index}-issuer-url`}
                    type="url"
                    value={provider.issuer_url}
                    disabled={disabled}
                    onChange={(issuer_url) => update(index, { ...provider, issuer_url })}
                  />
                </div>
                <AuthProviderInput
                  label={t("settings.auth.clientId")}
                  testId={`settings-auth-provider-${index}-client-id`}
                  value={provider.client_id}
                  disabled={disabled}
                  onChange={(client_id) => update(index, { ...provider, client_id })}
                />
                <AuthProviderInput
                  label={t("settings.auth.scopes")}
                  testId={`settings-auth-provider-${index}-scopes`}
                  value={provider.scopes}
                  disabled={disabled}
                  onChange={(scopes) => update(index, { ...provider, scopes })}
                />
                <AuthProviderInput
                  label={t("settings.auth.tenantSlug")}
                  testId={`settings-auth-provider-${index}-tenant-slug`}
                  value={provider.tenant_slug}
                  disabled={disabled}
                  onChange={(tenant_slug) => update(index, { ...provider, tenant_slug })}
                />
              </>
            )}
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={disabled}
        data-testid="settings-auth-provider-add"
        onClick={() =>
          onChange([
            ...value,
            {
              protocol: "oidc",
              id: `oidc-${value.length + 1}`,
              label: "OIDC",
              issuer_url: "https://",
              client_id: "",
              scopes: "openid profile email",
              tenant_slug: "default",
            },
          ])
        }
      >
        <Plus data-icon="inline-start" /> {t("settings.auth.addOidc")}
      </Button>
    </div>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("settings:write");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [restartSetting, setRestartSetting] = useState<SettingItem | null>(null);
  const [activeSection, setActiveSection] = useState("");
  const query = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => apiRequest<SettingsResponse>("/v1/settings"),
  });
  const allItems = query.data?.items ?? [];
  const publicBaseUrlItem = allItems.find((item) => item.path === "server.public_base_url");
  const publicBaseUrl =
    drafts["server.public_base_url"] ??
    (typeof publicBaseUrlItem?.value === "string"
      ? publicBaseUrlItem.value
      : (globalThis.location?.origin ?? ""));
  const items = useMemo(
    () =>
      allItems.filter((item) => {
        const needle = search.trim().toLowerCase();
        if (!needle) return true;
        return (
          item.path.toLowerCase().includes(needle) ||
          item.meta.description?.toLowerCase().includes(needle)
        );
      }),
    [allItems, search],
  );
  const changedItems = useMemo(
    () => allItems.filter((item) => Object.hasOwn(drafts, item.path)),
    [allItems, drafts],
  );
  const sections = useMemo(() => {
    const grouped = new Map<string, SettingItem[]>();
    for (const item of items) {
      const section = item.path.split(".")[0] ?? "other";
      grouped.set(section, [...(grouped.get(section) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [items]);
  const selectedSection = sections.some(([section]) => section === activeSection)
    ? activeSection
    : (sections[0]?.[0] ?? "");
  const selectedItems = sections.find(([section]) => section === selectedSection)?.[1] ?? [];
  const pendingRestartCount = query.data?.pending_restart_fields.length ?? 0;
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
  const settingsView = queryView(query, () => false);
  return (
    <AdminFrame testId="admin-settings" titleKey="resource.settings.title">
      <PreparedChanges canDecide={canWrite} />
      <div
        className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end"
        data-family-slot="configuration-content"
      >
        <Input
          className="sm:max-w-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("settings.search")}
          data-testid="settings-search"
        />
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="settings-refresh"
          onClick={() => query.refetch()}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {settingsView === "loading" ? (
        <LoadingCards testId="settings-loading" />
      ) : settingsView === "error" ? (
        // Rendering the list anyway showed an installation with nothing
        // configured, every activation fact unset — a failed read presented as
        // a fact about the configuration.
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("resource.settings.title") })}
          onRetry={() => void query.refetch()}
          testId="settings-load-failed"
        />
      ) : (
        <div className="grid gap-5 pb-20" data-testid="settings-list">
          <section
            className="overflow-hidden rounded-xl ring-1 ring-foreground/10"
            aria-label={t("settings.status.title")}
            data-testid="settings-activation-status"
          >
            <dl className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
              <div className="grid gap-1 p-4">
                <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <SlidersHorizontal className="size-3.5 text-foreground/70" aria-hidden="true" />
                  {t("settings.status.resolved")}
                </dt>
                <dd className="text-lg font-semibold tabular-nums">{allItems.length}</dd>
                <p className="text-xs text-muted-foreground">
                  {t("settings.status.resolvedDescription")}
                </p>
              </div>
              <div className="grid gap-1 p-4">
                <dt className="text-xs font-medium text-muted-foreground">
                  {t("settings.status.savedRevision")}
                </dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {query.data?.saved_revision ?? "—"}
                </dd>
                <p className="text-xs text-muted-foreground">
                  {t("settings.status.savedRevisionDescription")}
                </p>
              </div>
              <div className="grid gap-1 p-4">
                <dt className="text-xs font-medium text-muted-foreground">
                  {t("settings.status.activeRevision")}
                </dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {query.data?.active_revision ?? "—"}
                </dd>
                <p className="text-xs text-muted-foreground">
                  {t("settings.status.activeRevisionDescription")}
                </p>
              </div>
              <div className="grid gap-1 p-4">
                <dt className="text-xs font-medium text-muted-foreground">
                  {t("settings.status.activation")}
                </dt>
                <dd>
                  <Badge
                    variant={pendingRestartCount > 0 ? "outline" : "default"}
                    className={
                      pendingRestartCount > 0 ? "border-border bg-muted text-foreground" : undefined
                    }
                  >
                    {pendingRestartCount > 0
                      ? t("settings.status.pending", {
                          count: pendingRestartCount,
                        })
                      : (query.data?.activation_status ?? t("settings.status.active")).replaceAll(
                          "_",
                          " ",
                        )}
                  </Badge>
                </dd>
                <p className="text-xs text-muted-foreground">
                  {pendingRestartCount > 0
                    ? t("settings.status.pendingDescription")
                    : t("settings.status.activeDescription")}
                </p>
              </div>
            </dl>
          </section>

          {sections.length === 0 ? (
            <EmptyCard text={t("settings.noMatches")} testId="settings-no-matches" />
          ) : (
            <Tabs value={selectedSection} onValueChange={setActiveSection}>
              <div className="overflow-x-auto border-b" data-testid="settings-categories">
                <TabsList variant="line" className="h-10 w-max min-w-full justify-start gap-4 p-0">
                  {sections.map(([section, sectionItems], sectionIndex) => (
                    <TabsTrigger
                      key={section}
                      value={section}
                      className="h-10 flex-none rounded-none px-0 after:bg-foreground"
                      data-testid={`settings-category-${sectionIndex}`}
                    >
                      {settingSection(`${section}.value`, t)}
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {sectionItems.length}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value={selectedSection} className="mt-2">
                <Card
                  data-testid={`settings-section-${sections.findIndex(([section]) => section === selectedSection)}`}
                >
                  <CardHeader className="border-b">
                    <CardTitle>{settingSection(`${selectedSection}.value`, t)}</CardTitle>
                    <CardDescription>{t("settings.sectionDescription")}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup>
                      {selectedItems.map((item) => {
                        const index = allItems.indexOf(item);
                        if (item.path === "auth.providers") {
                          const providers = authProvidersFromDraft(drafts[item.path], item.value);
                          return (
                            <Field
                              key={item.path}
                              orientation="responsive"
                              data-disabled={!canWrite || undefined}
                              className="border-t pt-5 first:border-t-0 first:pt-0"
                              data-testid={`setting-item-${index}`}
                            >
                              <FieldLabel className="min-w-0 @md/field-group:max-w-sm">
                                <span className="min-w-0">
                                  <span className="block truncate">
                                    {t("settings.auth.providers")}
                                  </span>
                                  <span className="mt-1 block truncate font-mono text-xs font-normal text-muted-foreground">
                                    {item.path}
                                  </span>
                                </span>
                                <ContextHelp
                                  label={t("settings.about", {
                                    setting: t("settings.auth.providers"),
                                  })}
                                  testId={`setting-help-${index}`}
                                >
                                  {t("settings.resolution", {
                                    path: item.path,
                                    source: settingMetaLabel(item.meta.source, t).text,
                                    scope: settingMetaLabel(item.meta.scope, t).text,
                                  })}
                                </ContextHelp>
                              </FieldLabel>
                              <FieldContent className="min-w-0 @md/field-group:max-w-2xl">
                                <AuthProvidersEditor
                                  value={providers}
                                  publicBaseUrl={publicBaseUrl}
                                  disabled={!canWrite || save.isPending}
                                  onChange={(next) =>
                                    setDrafts((current) => ({
                                      ...current,
                                      [item.path]: JSON.stringify(next),
                                    }))
                                  }
                                />
                                <FieldDescription className="flex flex-wrap gap-1.5 pt-1.5">
                                  <Badge variant="secondary">
                                    <LabelText label={settingMetaLabel(item.meta.source, t)} />
                                  </Badge>
                                </FieldDescription>
                              </FieldContent>
                            </Field>
                          );
                        }
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
                            className="border-t pt-5 first:border-t-0 first:pt-0"
                            data-testid={`setting-item-${index}`}
                          >
                            <FieldLabel
                              className="min-w-0 @md/field-group:max-w-sm"
                              htmlFor={`setting-${index}`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate">{settingLabel(item.path, t)}</span>
                                <span className="mt-1 block truncate font-mono text-xs font-normal text-muted-foreground">
                                  {item.path}
                                </span>
                              </span>
                              <ContextHelp
                                label={t("settings.about", {
                                  setting: settingLabel(item.path, t),
                                })}
                                testId={`setting-help-${index}`}
                              >
                                {t("settings.resolution", {
                                  path: item.path,
                                  source: settingMetaLabel(item.meta.source, t).text,
                                  scope: settingMetaLabel(item.meta.scope, t).text,
                                })}
                              </ContextHelp>
                            </FieldLabel>
                            <FieldContent className="min-w-0 @md/field-group:max-w-lg">
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
                                    item.meta.sensitive
                                      ? t("settings.secretPlaceholder")
                                      : undefined
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
                              {item.meta.sensitive && (
                                <FieldDescription
                                  className="pt-1.5"
                                  data-testid={`setting-secret-hint-${index}`}
                                >
                                  {t("settings.secretExternalOnly")}
                                </FieldDescription>
                              )}
                              <FieldDescription className="flex flex-wrap gap-1.5 pt-1.5">
                                <Badge variant="secondary">
                                  <LabelText label={settingMetaLabel(item.meta.source, t)} />
                                </Badge>
                                {item.meta.requiresRestart && (
                                  <Badge
                                    variant="outline"
                                    className="border-border bg-muted text-foreground"
                                  >
                                    {t("settings.restart")}
                                  </Badge>
                                )}
                              </FieldDescription>
                            </FieldContent>
                          </Field>
                        );
                      })}
                    </FieldGroup>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>
      )}
      {canWrite && changedItems.length > 0 && (
        <div
          className="sticky bottom-3 z-10 -mx-1 mt-4 flex flex-col gap-3 rounded-xl bg-background/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          role="status"
          data-testid="settings-change-bar"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 text-foreground/70" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">
                {t("settings.unsavedCount", { count: changedItems.length })}
              </p>
              <p className="text-xs text-muted-foreground">{t("settings.unsavedHint")}</p>
            </div>
          </div>
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
