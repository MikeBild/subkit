import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Copy, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  absolute,
  chatNewHref,
  type PeopleSection,
  peopleHref,
  peopleSectionFromUrl,
} from "@/app/links";
import { useSession } from "@/app/session";
import { ConfirmAction } from "@/components/cockpit/confirm-action";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { LoadFailed, queryView } from "@/components/failure-state";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";
import {
  assignableRoles,
  GRANT_RESOURCE_TYPES,
  type GrantResourceType,
  isGrantResourceType,
  isPersonRole,
  openPeopleSection,
  PERSON_ROLES,
  type PersonRole,
  permissionLabel,
  personRefusal,
  readablePeopleSections,
  resourceTypeLabel,
  roleChange,
  roleChangeNotes,
  roleName,
} from "@/pages/admin-model";
import {
  deliveryState,
  eventPatternLabel,
  platformLabel,
  ruleNameLabel,
  ruleTarget,
  workflowPatternLabel,
} from "@/pages/notifications-model";

type Envelope<T> = { items: T[] };
/** How long an invite issued from the people page stays redeemable. */
const INVITE_TTL_HOURS = 24;
type RoleName = "admin" | "member" | "enduser";
type AccessSection = Exclude<PeopleSection, "people">;

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

/** Up to this many permissions are listed by name in a role-change consequence. */
const CONSEQUENCE_LIMIT = 6;

function PermissionList({
  permissions,
  testId,
}: {
  permissions: readonly string[];
  testId: string;
}) {
  const { t } = useI18n();
  const shown = permissions.slice(0, CONSEQUENCE_LIMIT);
  const more = permissions.length - shown.length;
  return (
    <ul className="grid gap-0.5 pl-4 text-sm" data-testid={testId}>
      {shown.map((permission) => (
        <li key={permission} className="list-disc">
          <LabelText label={permissionLabel(permission, t)} />
        </li>
      ))}
      {more > 0 ? (
        <li className="list-none text-muted-foreground">
          {t("people.change.more", { count: String(more) })}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * What a role change does, before it is done.
 *
 * Where both roles can be read, the consequence is the difference itself —
 * what the person can do afterwards that they could not, and what they lose.
 * Where they cannot (no `rbac:read`), it falls back to what the new role is
 * for, from the role catalogue. Either way the sentence names the person.
 */
function RoleChangeConsequence({
  email,
  from,
  to,
  toName: targetName,
  fromName,
  isSelf,
  roles,
}: {
  email: string;
  from: RoleItem | null;
  to: RoleItem | null;
  /** The picked role's name — known even where the role catalogue is not readable. */
  toName: string;
  fromName: string;
  /** The reader is changing their own role. */
  isSelf: boolean;
  roles: readonly RoleItem[] | undefined;
}) {
  const { t } = useI18n();
  const notes = roleChangeNotes({ from: fromName, to: targetName, isSelf });
  const noteText = notes.map((note) => (
    <p key={note} className="font-medium text-foreground" data-testid={`people-change-${note}`}>
      {t(`people.change.note.${note}`)}
    </p>
  ));
  const detail = (role: RoleItem | null) => ({
    queryKey: ["admin", "role", role?.id],
    queryFn: () => apiRequest<RoleDetail>(`/v1/rbac/roles/${encodeURIComponent(role?.id ?? "")}`),
    enabled: Boolean(role),
  });
  const before = useQuery(detail(from));
  const after = useQuery(detail(to));
  const toName = roleName(targetName, roles, t).text;
  if (Array.isArray(before.data?.permissions) && Array.isArray(after.data?.permissions)) {
    const change = roleChange(before.data.permissions, after.data.permissions);
    return (
      <>
        <p>{t("people.change.intro", { email, role: toName })}</p>
        {noteText}
        {change.gained.length > 0 ? (
          <>
            <p className="font-medium text-foreground">{t("people.change.gains")}</p>
            <PermissionList permissions={change.gained} testId="people-change-gained" />
          </>
        ) : null}
        {change.lost.length > 0 ? (
          <>
            <p className="font-medium text-foreground">{t("people.change.loses")}</p>
            <PermissionList permissions={change.lost} testId="people-change-lost" />
          </>
        ) : null}
        {change.gained.length === 0 && change.lost.length === 0 && notes.length === 0 ? (
          <p>{t("people.change.same")}</p>
        ) : null}
      </>
    );
  }
  const purpose = builtinRoleDescription(targetName, to?.description ?? null, t);
  return (
    <>
      <p>{t("people.change.intro", { email, role: toName })}</p>
      {noteText}
      {purpose ? <p>{t("people.change.purpose", { purpose })}</p> : null}
    </>
  );
}

/**
 * One person: which role they hold and what that role lets them do.
 *
 * The list answered "who is here"; nothing answered "and what can they do".
 * The permissions are the role's, read from the engine — a person's direct
 * grants are the Freigaben section of this page, and the sheet links there.
 */
function PersonSheet({
  user,
  roles,
  onClose,
}: {
  user: UserItem | null;
  roles: readonly RoleItem[] | undefined;
  onClose(): void;
}) {
  const { t } = useI18n();
  const canReadGrants = useSession().permissions.includes("rbac:read");
  const role = user
    ? (roles?.find((candidate) => candidate.name === user.effective_role) ?? null)
    : null;
  const detail = useQuery({
    queryKey: ["admin", "role", role?.id],
    queryFn: () => apiRequest<RoleDetail>(`/v1/rbac/roles/${encodeURIComponent(role?.id ?? "")}`),
    enabled: Boolean(role),
  });
  const label = user ? roleName(user.effective_role, roles, t) : null;
  const purpose = user
    ? builtinRoleDescription(user.effective_role, role?.description ?? null, t)
    : null;
  return (
    <Sheet open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        closeLabel={t("common.close")}
        closeTestId="people-sheet-close"
        data-testid="people-sheet"
      >
        <SheetHeader>
          <SheetTitle className="break-all">{user?.email}</SheetTitle>
          <SheetDescription>{t("people.sheet.description")}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          <section className="grid gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{t("people.role")}</h3>
            <p className="text-sm font-medium" data-testid="people-sheet-role">
              {label ? <LabelText label={label} /> : null}
            </p>
            {purpose ? <p className="text-sm text-muted-foreground">{purpose}</p> : null}
          </section>
          <section className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("people.sheet.permissions")}
            </h3>
            {!role ? (
              <p className="text-sm text-muted-foreground" data-testid="people-sheet-unreadable">
                {t("people.sheet.unreadable")}
              </p>
            ) : Array.isArray(detail.data?.permissions) ? (
              detail.data.permissions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("people.sheet.none")}</p>
              ) : (
                <ul className="grid gap-1 text-sm" data-testid="people-sheet-permissions">
                  {[...detail.data.permissions].sort().map((permission) => (
                    <li key={permission}>
                      <LabelText label={permissionLabel(permission, t)} />
                    </li>
                  ))}
                </ul>
              )
            ) : detail.error ? (
              <p className="text-sm text-muted-foreground">{t("people.sheet.unreadable")}</p>
            ) : (
              <Skeleton className="h-20 w-full" />
            )}
            <p className="text-xs text-muted-foreground" data-testid="people-sheet-grants-note">
              {t("people.sheet.grantsNote")}{" "}
              {canReadGrants ? (
                <Link
                  to={peopleHref("grants")}
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={onClose}
                  data-testid="people-sheet-grants-link"
                >
                  {t("people.sheet.grantsLink")}
                </Link>
              ) : (
                t("people.sheet.grantsLink")
              )}
            </p>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A person-role change the reader has picked and not yet confirmed. */
interface PendingRoleChange {
  user: UserItem;
  to: string;
}

function PeopleList() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("identity:write");
  const canReadRoles = session.permissions.includes("rbac:read");
  // A custom role is assigned through RBAC, not through the identity API,
  // and needs its own right. Without it the picker offers the person roles
  // only — the ones this page can actually save.
  const canAssignCustom = session.permissions.includes("rbac:write");
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PersonRole>("member");
  const [deactivate, setDeactivate] = useState<UserItem | null>(null);
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingRoleChange | null>(null);
  const [repair, setRepair] = useState<UserItem | null>(null);
  const [inviteFor, setInviteFor] = useState<UserItem | null>(null);
  const [opened, setOpened] = useState<UserItem | null>(null);
  const query = useQuery({
    queryKey: ["admin", "people"],
    queryFn: () => apiRequest<Envelope<UserItem>>("/v1/identity/users?limit=200"),
  });
  const roles = useQuery({
    queryKey: ["admin", "roles"],
    enabled: canReadRoles,
    queryFn: () => apiRequest<Envelope<RoleItem>>("/v1/rbac/roles"),
  });
  const roleItems = roles.data?.items;
  const choices = useMemo(() => {
    const all = assignableRoles(roleItems ?? []);
    const offered = canAssignCustom ? all : all.filter((item) => isPersonRole(item.name));
    // Without the role catalogue the three person roles are still known by name.
    return offered.length > 0 ? offered.map((item) => item.name) : [...PERSON_ROLES];
  }, [roleItems, canAssignCustom]);
  const roleByName = (name: string) => roleItems?.find((item) => item.name === name) ?? null;
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
    mutationFn: ({ user, to }: PendingRoleChange) => {
      if (isPersonRole(to))
        return apiRequest<unknown>(`/v1/identity/users/${encodeURIComponent(user.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: to }),
        });
      const target = roleByName(to);
      if (!target) throw new Error("role not found");
      return apiRequest<unknown>(`/v1/rbac/users/${encodeURIComponent(user.id)}/role`, {
        method: "POST",
        body: JSON.stringify({ role_id: target.id }),
      });
    },
    onSuccess: async () => {
      setPendingChange(null);
      setRepair(null);
      await refresh();
      toast.success(t("people.roleUpdated"));
    },
  });
  // The engine's reason, in words, inside the dialog that asked — "the last
  // administrator" is not a generic failure and must not read like one.
  const refusal = (error: unknown) =>
    error ? personRefusal(error instanceof ApiError ? error : null, t) : null;
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
  const issueInvite = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ plaintext_token: string; expires_at: string }>(
        `/v1/identity/users/${encodeURIComponent(id)}/invites`,
        // The validity is set here, not left to the engine's default, so the
        // sentence that promises it before the click is the one that holds.
        { method: "POST", body: JSON.stringify({ ttl_minutes: INVITE_TTL_HOURS * 60 }) },
      ),
    onSuccess: (result) => {
      setInviteFor(null);
      setInvite({ token: result.plaintext_token, expiresAt: result.expires_at });
    },
  });

  const view = queryView(query, (data) => data.items.length === 0);

  return (
    <div className="grid gap-4">
      {canWrite ? (
        <div className="flex justify-end">
          <Button
            className="w-full sm:w-auto"
            onClick={() => setCreateOpen(true)}
            data-testid="people-create"
          >
            <Plus data-icon="inline-start" />
            {t("people.create")}
          </Button>
        </div>
      ) : null}
      {view === "loading" ? (
        <LoadingCards testId="people-loading" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("people.section.people") })}
          onRetry={() => void query.refetch()}
          testId="people-load-failed"
        />
      ) : view === "empty" ? (
        <EmptyCard text={t("resource.people.empty")} testId="people-empty" />
      ) : (
        <div className="grid gap-2" data-testid="people-list">
          {(query.data?.items ?? []).map((user, index) => {
            const options = choices.includes(user.effective_role)
              ? choices
              : [user.effective_role, ...choices];
            return (
              <Card key={user.id} size="sm" data-testid={`people-item-${index}`}>
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-sm">
                      <button
                        type="button"
                        className="max-w-full truncate text-left hover:underline focus-visible:underline"
                        onClick={() => setOpened(user)}
                        data-testid={`people-name-${index}`}
                      >
                        {user.email}
                      </button>
                    </CardTitle>
                    <CardDescription className="mt-1 flex flex-wrap gap-2">
                      <Badge variant="outline" data-testid={`people-role-badge-${index}`}>
                        <LabelText label={roleName(user.effective_role, roleItems, t)} />
                      </Badge>
                      <Badge variant="secondary">{statusLabel(t, user.status)}</Badge>
                      {!user.role_consistent &&
                        (canWrite && isPersonRole(user.effective_role) ? (
                          // Red with its way to the fix (§1): the badge IS the
                          // action, and it says what it will do before it does it.
                          <button
                            type="button"
                            onClick={() => setRepair(user)}
                            data-testid={`people-role-drift-${index}`}
                          >
                            <Badge variant="destructive">{t("people.roleDriftRepair")}</Badge>
                          </button>
                        ) : (
                          <Badge variant="destructive" data-testid={`people-role-drift-${index}`}>
                            {t("people.roleDriftAskAdmin")}
                          </Badge>
                        ))}
                    </CardDescription>
                  </div>
                  {canWrite && (
                    <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:w-auto sm:grid-cols-[11rem_auto_auto]">
                      <Select
                        value={user.effective_role}
                        onValueChange={(value) => {
                          if (value !== user.effective_role) setPendingChange({ user, to: value });
                        }}
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
                            {options.map((name) => (
                              <SelectItem
                                key={name}
                                value={name}
                                data-testid={`people-role-${index}-${name}`}
                              >
                                <LabelText label={roleName(name, roleItems, t)} />
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setInviteFor(user)}
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
            );
          })}
        </div>
      )}
      <PersonSheet user={opened} roles={roleItems} onClose={() => setOpened(null)} />
      <ConfirmAction
        open={Boolean(pendingChange)}
        onOpenChange={(open) => !open && setPendingChange(null)}
        title={t("people.change.title")}
        consequence={
          pendingChange ? (
            <RoleChangeConsequence
              email={pendingChange.user.email}
              from={roleByName(pendingChange.user.effective_role)}
              to={roleByName(pendingChange.to)}
              toName={pendingChange.to}
              fromName={pendingChange.user.effective_role}
              isSelf={pendingChange.user.id === session.principal.id}
              roles={roleItems}
            />
          ) : null
        }
        confirmLabel={t("people.change.confirm")}
        onConfirm={() => pendingChange && update.mutateAsync(pendingChange)}
        error={refusal(update.error)}
        testId="people-role-confirm"
      />
      <ConfirmAction
        open={Boolean(repair)}
        onOpenChange={(open) => !open && setRepair(null)}
        title={t("people.repair.title")}
        consequence={
          repair ? (
            <p>
              {t("people.repair.consequence", {
                email: repair.email,
                role: roleName(repair.effective_role, roleItems, t).text,
              })}
            </p>
          ) : null
        }
        confirmLabel={t("people.repair.confirm")}
        onConfirm={() => repair && update.mutateAsync({ user: repair, to: repair.effective_role })}
        error={refusal(update.error)}
        testId="people-repair-confirm"
      />
      <ConfirmAction
        open={Boolean(inviteFor)}
        onOpenChange={(open) => !open && setInviteFor(null)}
        title={t("people.invite")}
        consequence={
          inviteFor ? (
            <p>
              {t("people.inviteConsequence", {
                email: inviteFor.email,
                hours: String(INVITE_TTL_HOURS),
              })}
            </p>
          ) : null
        }
        confirmLabel={t("people.invite")}
        onConfirm={() => inviteFor && issueInvite.mutateAsync(inviteFor.id)}
        error={refusal(issueInvite.error)}
        testId="people-invite-confirm"
      />
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
              <Select value={role} onValueChange={(value) => isPersonRole(value) && setRole(value)}>
                <SelectTrigger className="w-full" data-testid="people-create-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PERSON_ROLES.map((name) => (
                      <SelectItem
                        key={name}
                        value={name}
                        data-testid={`people-create-role-${name}`}
                      >
                        <LabelText label={roleName(name, roleItems, t)} />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {/* A new person starts on a person role; a custom one is given
                  afterwards, from the list, through RBAC. */}
              <FieldDescription>{t("people.createRoleHint")}</FieldDescription>
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
        secret={invite?.token ?? null}
        onClose={() => setInvite(null)}
        title={
          invite
            ? t("people.inviteReadyUntil", { time: dateTime(invite.expiresAt) })
            : t("people.inviteReady")
        }
      />
    </div>
  );
}

const PEOPLE_SECTION_LABEL: Record<PeopleSection, TranslationKey> = {
  people: "people.section.people",
  roles: "access.roles",
  groups: "access.groups",
  grants: "access.grants",
};

const TAB_COLUMNS = ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4"] as const;

/**
 * Personen & Rechte — who is here, and what each of them may do.
 *
 * Two pages until now: Personen for the people and their role, Zugriff for the
 * roles, groups and grants. A role changed on one had its consequence on the
 * other, and the navigation carried two entries for one question. The section
 * lives in the address (`?section=roles`), so a link, a reload and the old
 * `/access` address all land where they meant to; the people list is the
 * default. The permission catalogue is not a section of its own: a role's
 * permissions are read on the role, and the grant dialog offers the ones a
 * record can take.
 */
export function PeopleAndAccessPage() {
  const { t } = useI18n();
  const session = useSession();
  const canIdentity = session.permissions.includes("identity:read");
  const canRbac = session.permissions.includes("rbac:read");
  const readable = useMemo(
    () => readablePeopleSections({ identity: canIdentity, rbac: canRbac }),
    [canIdentity, canRbac],
  );
  // The section IS the address: read from the router's location on every
  // render, and changed only by navigating. A tab switch replaces the history
  // entry (the tabs are one page, not a trail), and a link to another section
  // while the page is open — the profile sheet's "Freigaben" — arrives the
  // same way. There is no second copy of the section in local state that
  // could disagree with the address.
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const section = openPeopleSection(peopleSectionFromUrl(searchStr), readable);
  const navigate = useNavigate();
  const choose = (next: string) => {
    const picked = readable.find((candidate) => candidate === next);
    if (!picked || picked === section) return;
    void navigate({ to: peopleHref(picked), replace: true });
  };

  return (
    <AdminFrame testId="admin-people" titleKey="resource.people.title">
      {section === null ? (
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      ) : (
        <Tabs value={section} onValueChange={choose} data-testid="people-tabs">
          {readable.length > 1 ? (
            <>
              <Select value={section} onValueChange={choose}>
                <SelectTrigger
                  className="w-full sm:hidden"
                  aria-label={t("access.section")}
                  data-testid="people-mobile-section"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {readable.map((value) => (
                      <SelectItem key={value} value={value} data-testid={`people-mobile-${value}`}>
                        {t(PEOPLE_SECTION_LABEL[value])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <TabsList
                variant="line"
                className={cn(
                  "hidden h-auto w-full sm:grid",
                  TAB_COLUMNS[readable.length - 1] ?? "grid-cols-4",
                )}
                data-testid="people-tab-list"
              >
                {readable.map((value) => (
                  <TabsTrigger key={value} value={value} data-testid={`people-tab-${value}`}>
                    {t(PEOPLE_SECTION_LABEL[value])}
                  </TabsTrigger>
                ))}
              </TabsList>
            </>
          ) : null}
          <TabsContent value={section} className="pt-4">
            {section === "people" ? <PeopleList /> : <AccessSections section={section} />}
          </TabsContent>
        </Tabs>
      )}
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

function AccessSections({ section }: { section: AccessSection }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("rbac:write");
  // Every read here is behind its own permission. A reader who may see the
  // roles but not the directory reads no people: a refused read is an audit
  // row and an error state, and the names fall back to their kind.
  const can = (permission: string) => session.permissions.includes(permission);
  const [createKind, setCreateKind] = useState<"role" | "group" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantSubjectType, setGrantSubjectType] = useState<"user" | "group">("user");
  const [grantSubjectId, setGrantSubjectId] = useState("");
  const [grantResourceType, setGrantResourceType] = useState<GrantResourceType>("workflow");
  const [grantResourceId, setGrantResourceId] = useState("");
  const [grantPermission, setGrantPermission] = useState("");
  const [managedRole, setManagedRole] = useState<RoleItem | null>(null);
  const [revoking, setRevoking] = useState<GrantItem | null>(null);
  const [memberGroup, setMemberGroup] = useState<GroupItem | null>(null);
  const [memberUserId, setMemberUserId] = useState("");
  const [roleGroup, setRoleGroup] = useState<GroupItem | null>(null);
  const [groupRoleId, setGroupRoleId] = useState("");
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
    enabled: can("identity:read"),
    queryFn: () => apiRequest<Envelope<UserItem>>("/v1/identity/users?limit=200"),
  });
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    enabled: can("workflow:read"),
    queryFn: () => apiRequest<Envelope<WorkflowItem>>("/v1/workflows?limit=200"),
  });
  const connectors = useQuery({
    queryKey: ["admin", "connectors"],
    enabled: can("connector:read"),
    queryFn: () =>
      apiRequest<Envelope<WorkflowItem & { display_name?: string | null }>>(
        "/v1/connectors?limit=200",
      ),
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
    onSuccess: async () => {
      setRevoking(null);
      await client.invalidateQueries({ queryKey: ["admin", "grants"] });
      toast.success(t("access.grantRevoked"));
    },
  });
  const createGrant = useMutation({
    mutationFn: () =>
      apiRequest("/v1/rbac/grants", {
        method: "POST",
        body: JSON.stringify({
          subject_type: grantSubjectType,
          subject_id: grantSubjectId,
          resource_type: grantResourceType,
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
  const addMember = useMutation({
    mutationFn: () =>
      apiRequest(
        `/v1/rbac/groups/${encodeURIComponent(memberGroup?.id ?? "")}/members/${encodeURIComponent(memberUserId)}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      setMemberGroup(null);
      setMemberUserId("");
      toast.success(t("access.memberAdded"));
    },
  });
  const assignGroupRole = useMutation({
    mutationFn: () =>
      apiRequest(
        `/v1/rbac/groups/${encodeURIComponent(roleGroup?.id ?? "")}/roles/${encodeURIComponent(groupRoleId)}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      setRoleGroup(null);
      setGroupRoleId("");
      toast.success(t("access.groupRoleAssigned"));
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
  // A grant names a person or group and one record. Where the name cannot be
  // resolved the kind is said instead — never the id, which says nothing a
  // reader can act on.
  const subjectName = (grant: GrantItem) => {
    if (grant.subject_type === "user")
      return (
        people.data?.items.find((item) => item.id === grant.subject_id)?.email ?? t("access.person")
      );
    if (grant.subject_type === "group")
      return (
        groups.data?.items.find((item) => item.id === grant.subject_id)?.name ?? t("access.group")
      );
    return t("access.systemAccount");
  };
  const resourceChoices = (type: GrantResourceType) =>
    (type === "workflow" ? workflows.data?.items : connectors.data?.items) ?? [];
  const recordName = (item: WorkflowItem & { display_name?: string | null }) =>
    item.display_name || item.name || item.slug || null;
  const resourceName = (grant: GrantItem) => {
    const kind = resourceTypeLabel(grant.resource_type, t).text;
    if (!isGrantResourceType(grant.resource_type)) return kind;
    const record = resourceChoices(grant.resource_type).find(
      (item) => item.id === grant.resource_id,
    );
    const name = record ? recordName(record) : null;
    return name ? t("access.grantResource", { kind, name }) : kind;
  };
  const grantPermissions = (permissions.data?.items ?? []).filter(
    (permission) => permission.resource_type === grantResourceType,
  );
  return (
    <>
      {section === "roles" ? (
        <div className="grid gap-4" data-testid="roles-section">
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
                    <CardTitle data-testid={`roles-list-${index}-name`}>
                      <LabelText label={roleName(role.name, roles.data?.items, t)} />
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
        </div>
      ) : null}
      {section === "groups" ? (
        <div className="grid gap-4" data-testid="groups-section">
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
            render={(group, index) => (
              <Card key={group.id} size="sm" data-testid={`groups-list-${index}`}>
                <CardHeader>
                  <CardTitle>{group.name}</CardTitle>
                  {group.description && <CardDescription>{group.description}</CardDescription>}
                  {canWrite && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setMemberGroup(group)}
                        data-testid={`group-add-member-${index}`}
                      >
                        {t("access.addMember")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRoleGroup(group)}
                        data-testid={`group-assign-role-${index}`}
                      >
                        {t("access.assignGroupRole")}
                      </Button>
                    </div>
                  )}
                </CardHeader>
              </Card>
            )}
          />
          {/* The engine adds and removes members but has no way to list them.
              Said once, so an empty-looking group is not read as a group
              without members. */}
          <p className="text-xs text-muted-foreground" data-testid="groups-members-note">
            {t("access.membersNotListed")}
          </p>
        </div>
      ) : null}
      {section === "grants" ? (
        <div data-testid="grants-section">
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
                      {subjectName(grant)} · {resourceName(grant)} ·{" "}
                      {grant.expires_at
                        ? t("access.grantExpires", { time: dateTime(grant.expires_at) })
                        : t("access.grantNoExpiry")}
                    </p>
                  </div>
                  {canWrite && (
                    <IconButton
                      label={t("access.revokeGrant")}
                      data-testid={`grant-revoke-${index}`}
                      onClick={() => setRevoking(grant)}
                    >
                      <Trash2 />
                    </IconButton>
                  )}
                </CardContent>
              </Card>
            )}
          />
        </div>
      ) : null}
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
            <DialogDescription>{t("access.grantDescriptionTyped")}</DialogDescription>
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
              <FieldLabel>{t("access.resourceType")}</FieldLabel>
              <Select
                value={grantResourceType}
                onValueChange={(value) => {
                  if (!isGrantResourceType(value)) return;
                  // A permission belongs to one kind of record; carrying the
                  // workflow's choice over to a connector would send a grant
                  // the engine cannot check.
                  setGrantResourceType(value);
                  setGrantResourceId("");
                  setGrantPermission("");
                }}
              >
                <SelectTrigger className="w-full" data-testid="grant-resource-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {GRANT_RESOURCE_TYPES.map((type) => (
                      <SelectItem
                        key={type}
                        value={type}
                        data-testid={`grant-resource-type-${type}`}
                      >
                        <LabelText label={resourceTypeLabel(type, t)} />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{t("access.grantTypesNote")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("access.grantRecord")}</FieldLabel>
              <Select value={grantResourceId} onValueChange={setGrantResourceId}>
                <SelectTrigger className="w-full" data-testid="grant-resource">
                  <SelectValue placeholder={t("access.chooseRecord")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {resourceChoices(grantResourceType).map((record, index) => (
                      <SelectItem
                        key={record.id}
                        value={record.id}
                        data-testid={`grant-resource-${index}`}
                      >
                        {recordName(record) ?? resourceTypeLabel(grantResourceType, t).text}
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
                  <SelectValue placeholder={t("access.choosePermission")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {grantPermissions.map((permission, index) => (
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
            <DialogDescription>
              {managedRole ? roleName(managedRole.name, roles.data?.items, t).text : null}
            </DialogDescription>
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
      <ConfirmAction
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("access.revokeGrant")}
        consequence={
          revoking ? (
            <p>
              {t("access.revokeConsequence", {
                subject: subjectName(revoking),
                permission: permissionLabel(revoking.permission, t).text,
                resource: resourceName(revoking),
              })}
            </p>
          ) : null
        }
        confirmLabel={t("access.revokeGrant")}
        tone="destructive"
        onConfirm={() => revoking && revokeGrant.mutateAsync(revoking.id)}
        error={
          revokeGrant.error
            ? t("access.revokeFailed", {
                reason:
                  revokeGrant.error instanceof ApiError
                    ? revokeGrant.error.message
                    : t("resource.loadFailedDescription"),
              })
            : null
        }
        testId="grant-revoke-confirm"
      />
      <Dialog
        open={Boolean(memberGroup)}
        onOpenChange={(open) => {
          if (!open) {
            setMemberGroup(null);
            setMemberUserId("");
          }
        }}
      >
        <DialogContent showCloseButton={false} data-testid="group-member-dialog">
          <DialogHeader>
            <DialogTitle>{t("access.addMember")}</DialogTitle>
            <DialogDescription>
              {t("access.addMemberConsequence", { group: memberGroup?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>{t("access.person")}</FieldLabel>
            <Select value={memberUserId} onValueChange={setMemberUserId}>
              <SelectTrigger className="w-full" data-testid="group-member-person">
                <SelectValue placeholder={t("access.choosePerson")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(people.data?.items ?? []).map((person, index) => (
                    <SelectItem
                      key={person.id}
                      value={person.id}
                      data-testid={`group-member-person-${index}`}
                    >
                      {person.email}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMemberGroup(null)}
              data-testid="group-member-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!memberUserId || addMember.isPending}
              onClick={() => addMember.mutate()}
              data-testid="group-member-submit"
            >
              {t("access.addMember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(roleGroup)}
        onOpenChange={(open) => {
          if (!open) {
            setRoleGroup(null);
            setGroupRoleId("");
          }
        }}
      >
        <DialogContent showCloseButton={false} data-testid="group-role-dialog">
          <DialogHeader>
            <DialogTitle>{t("access.assignGroupRole")}</DialogTitle>
            <DialogDescription>
              {t("access.assignGroupRoleConsequence", { group: roleGroup?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>{t("people.role")}</FieldLabel>
            <Select value={groupRoleId} onValueChange={setGroupRoleId}>
              <SelectTrigger className="w-full" data-testid="group-role-select">
                <SelectValue placeholder={t("access.chooseRole")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {assignableRoles(roles.data?.items ?? []).map((role, index) => (
                    <SelectItem
                      key={role.id}
                      value={role.id}
                      data-testid={`group-role-select-${index}`}
                    >
                      <LabelText label={roleName(role.name, roles.data?.items, t)} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRoleGroup(null)}
              data-testid="group-role-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!groupRoleId || assignGroupRole.isPending}
              onClick={() => assignGroupRole.mutate()}
              data-testid="group-role-submit"
            >
              {t("access.assignGroupRole")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface NotificationRuleItem {
  id: string;
  name: string;
  event_pattern: string;
  workflow_pattern: string;
  severity: string;
  target_workspace_id?: string;
  target_channel_id: string;
  active: boolean;
}

interface NotificationChannelItem {
  id: string;
  platform: string;
  workspace_id?: string;
  channel_id: string;
  default_severity: string;
  rate_limit_per_minute: number;
  circuit_state: string;
  circuit_open_until?: string | null;
  consecutive_failures?: number;
  active: boolean;
}

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
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("notification:write");
  const resume = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/v1/notifications/channels/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin", "notification-channels"] });
      toast.success(t("notifications.resumed"));
    },
    onError: (error) =>
      toast.error(
        t("notifications.resumeFailed", {
          reason: error instanceof ApiError ? error.message : t("resource.loadFailedDescription"),
        }),
      ),
  });
  const now = Date.now();
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
              <a
                href={absolute(chatNewHref({ prompt: t("notifications.setupPrompt") }))}
                data-testid="notifications-empty-setup"
              >
                {t("notifications.emptySetup")}
              </a>
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
                ruleItems.map((rule, index) => {
                  const target = ruleTarget(rule, channelItems);
                  return (
                    <div
                      key={rule.id}
                      className="rounded-lg border p-3"
                      data-testid={`notifications-rule-${index}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 font-medium break-words">{ruleNameLabel(rule, t)}</p>
                        <Badge variant={rule.active ? "secondary" : "outline"}>
                          {t(rule.active ? "notifications.active" : "notifications.paused")}
                        </Badge>
                        <Badge variant="outline">
                          {word(SEVERITY_LABEL, rule.severity, rule.severity)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground break-words">
                        <LabelText label={eventPatternLabel(rule.event_pattern, t)} /> ·{" "}
                        <LabelText label={workflowPatternLabel(rule.workflow_pattern, t)} />
                      </p>
                      <p
                        className="mt-1 text-sm text-muted-foreground break-words"
                        data-testid={`notifications-rule-${index}-target`}
                      >
                        {target.kind === "inbox"
                          ? t("notifications.target.inbox")
                          : target.kind === "channel"
                            ? t("notifications.target.channel", {
                                channel: platformLabel(target.channel.platform, t).text,
                              })
                            : t("notifications.target.pending")}
                      </p>
                    </div>
                  );
                })
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
                channelItems.map((channel, index) => {
                  const delivery = deliveryState(channel, now);
                  return (
                    <div
                      key={channel.id}
                      className="rounded-lg border p-3"
                      data-testid={`notifications-channel-${index}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 font-medium break-words">
                          <LabelText label={platformLabel(channel.platform, t)} />
                        </p>
                        <Badge variant={channel.active ? "secondary" : "outline"}>
                          {t(channel.active ? "notifications.active" : "notifications.paused")}
                        </Badge>
                        {/* Only a running cool-down is red: that is the one phase
                          in which events are skipped. Anything this build has
                          no word for is the engine's own, neutral. */}
                        <Badge
                          variant={delivery.kind === "suspended" ? "destructive" : "outline"}
                          data-testid={`notifications-channel-${index}-delivery`}
                        >
                          {delivery.kind === "machine" ? (
                            <LabelText label={{ text: delivery.value, machine: true }} />
                          ) : (
                            t(
                              delivery.kind === "delivering"
                                ? "notifications.circuit.closed"
                                : delivery.kind === "retrying"
                                  ? "notifications.circuit.halfOpen"
                                  : "notifications.circuit.open",
                            )
                          )}
                        </Badge>
                      </div>
                      {delivery.kind === "suspended" ? (
                        <p
                          className="mt-1 text-sm break-words"
                          data-testid={`notifications-channel-${index}-cause`}
                        >
                          {t("notifications.suspendedCause", {
                            count: String(delivery.failures),
                          })}{" "}
                          {delivery.until
                            ? t("notifications.suspendedUntil", { time: dateTime(delivery.until) })
                            : t("notifications.suspendedRetry")}
                        </p>
                      ) : null}
                      {!channel.active ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <p className="text-sm text-muted-foreground">
                            {t("notifications.pausedCause")}
                          </p>
                          {canWrite ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={resume.isPending}
                              onClick={() => resume.mutate(channel.id)}
                              data-testid={`notifications-channel-${index}-resume`}
                            >
                              {t("notifications.resume")}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
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
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </AdminFrame>
  );
}
