import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  PEOPLE_APP_PARAM,
  type PeopleSection,
  peopleAppFromUrl,
  peopleHref,
  peopleSectionFromUrl,
  workflowHref,
} from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  Checkbox,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  ContextHelp,
  CopyField,
  DataState,
  DataTable,
  FactList,
  Field,
  FieldDescription,
  FieldLabel,
  FilterBar,
  FormDialog,
  type InfiniteRows,
  InfiniteSentinel,
  Input,
  Page,
  PageHeader,
  PageTabs,
  RecordSheet,
  RowName,
  SaveBar,
  Section,
  SegmentedControl,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  SummaryLine,
  Switch,
  Textarea,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { useCurrentVersionDag } from "@/components/cockpit/workflow-versions";
import { ForbiddenState, queryView } from "@/components/failure-state";
import { isAppUserEmail } from "@/lib/app-user";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { useInfiniteList } from "@/lib/use-infinite-list";
import {
  assignableRoles,
  type GrantResourceType,
  grantStatus,
  isGrantResourceType,
  isPersonRole,
  membershipNames,
  openPeopleSection,
  PERSON_ROLES,
  type PersonRole,
  permissionGroups,
  permissionLabel,
  personRefusal,
  readablePeopleSections,
  resourceTypeLabel,
  roleChange,
  roleChangeNotes,
  roleName,
} from "@/pages/admin-model";
import {
  APP_READINESS_LABEL,
  type AppActivationOutcome,
  type AppSettingsChanges,
  type AppSignIn,
  type AppSummary,
  type AppView,
  appActivationOutcome,
  appBearerProvider,
  appCheckLines,
  appFailingSummary,
  appGoneFromList,
  appReadiness,
  appSettingsPatch,
  appUserLabel,
  appUserLastSeen,
  type ClaimDraft,
  type ClaimType,
  definitionGuardBucket,
  EXECUTION_ENVIRONMENTS,
  eraseAppUserPath,
  PRODUCTS_PATH,
  PROVIDERS_PATH,
  type ProductDraft,
  personApps,
  personEmailText,
  personNameText,
  productDraft,
  productEntry,
  productErrors,
  productsFrom,
  SIGN_IN_ALGORITHMS,
  type SignInDraft,
  signInDraft,
  signInErrors,
  signInProvider,
  withProduct,
  withProvider,
} from "@/pages/apps-model";
import {
  type SettingsResponse,
  settingsActivationPath,
  settingsSaveFailure,
} from "@/pages/settings-model";

type Envelope<T> = { items: T[] };
type Translate = ReturnType<typeof useI18n>["t"];
const INVITE_TTL_HOURS = 24;

interface UserItem {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  oauth_connections?: number;
  groups?: { id: string; name: string }[] | null;
  identities?: { provider_id: string; product_id: string | null; last_seen_at: string }[];
}

interface RoleItem {
  id: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
  permissions?: string[];
  member_count?: number;
}

interface GroupItem {
  member_count?: number;
  member_ids?: string[];
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

interface RecordItem {
  id: string;
  name?: string | null;
  slug?: string | null;
  display_name?: string | null;
  current_version_id?: string | null;
  current_version?: number | null;
}

interface RoleDetail extends RoleItem {
  permissions: string[];
}

interface PermissionItem {
  name: string;
  description: string;
  resource_type: string;
}

const fetchPeople = () => apiRequest<Envelope<UserItem>>("/v1/identity/users?limit=200");
const fetchRoles = () => apiRequest<Envelope<RoleItem>>("/v1/rbac/roles");
const fetchGroups = () => apiRequest<Envelope<GroupItem>>("/v1/rbac/groups");
const fetchGrants = () => apiRequest<Envelope<GrantItem>>("/v1/rbac/grants");

function usePeople(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "people"], queryFn: fetchPeople, enabled, ...live });
}
function usePeopleList(enabled = true, app: string | null = null) {
  const list = useInfiniteList<UserItem>("/v1/identity/users", app ? { product_id: app } : {}, {
    enabled,
    queryKey: ["admin", "people", "list", app ?? "all"],
  });
  const { query } = list;
  return {
    ...list,
    view: {
      data: list.first ? { items: list.items } : undefined,
      error: query.error,
      failureReason: query.failureReason,
      isPending: query.isPending,
      refetch: query.refetch,
    },
  };
}
function useRoles(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "roles"], queryFn: fetchRoles, enabled, ...live });
}
function useGroups(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "groups"], queryFn: fetchGroups, enabled, ...live });
}
function useGrants(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "grants"], queryFn: fetchGrants, enabled, ...live });
}
function useRoleDetail(role: RoleItem | null) {
  return useQuery({
    queryKey: ["admin", "role", role?.id],
    queryFn: () => apiRequest<RoleDetail>(`/v1/rbac/roles/${encodeURIComponent(role?.id ?? "")}`),
    enabled: Boolean(role),
  });
}

function builtinRoleDescription(role: string, fallback: string | null, t: Translate) {
  const key: Record<string, TranslationKey> = {
    admin: "access.roleDescription.admin",
    member: "access.roleDescription.member",
    enduser: "access.roleDescription.enduser",
    metrics_scraper: "access.roleDescription.metricsScraper",
    portal_token_user: "access.roleDescription.portalTokenUser",
  };
  return key[role] ? t(key[role]) : fallback;
}

function personEmailFact(user: UserItem, t: Translate) {
  return {
    label: t(isAppUserEmail(user.email) ? "apps.section.signIn" : "people.email"),
    value: personEmailText(user, t),
    testId: "people-sheet-email",
  };
}

function refusalToast(error: unknown, t: Translate) {
  toast.error(personRefusal(error instanceof ApiError ? error : null, t));
}

function SectionList<T>({
  name,
  resource,
  query,
  emptyLine,
  emptyAction,
  summary,
  help,
  children,
}: {
  name: string;
  resource: string;
  query: Parameters<typeof queryView<Envelope<T>>>[0] & { refetch(): unknown };
  emptyLine: string;
  emptyAction?: ReactNode;
  summary?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const view = queryView(query, (data) => data.items.length === 0);
  if (view === "loading") return <DataState state="loading" testId={`${name}-loading`} />;
  if (view === "error")
    return (
      <DataState
        state="error"
        line={t("resource.loadFailed", { resource })}
        onRetry={() => void query.refetch()}
        testId={`${name}-load-failed`}
      />
    );
  if (view === "empty")
    return (
      <DataState state="empty" line={emptyLine} action={emptyAction} testId={`${name}-empty`} />
    );
  if (!summary) return children;
  return (
    <div className="flex flex-col gap-3">
      <SummaryLine text={summary} help={help} testId={`${name}-summary`} />
      {children}
    </div>
  );
}

function AdminTable<T extends RowData>({
  collectionId,
  columns,
  data,
  onOpen,
  rowLabel,
  toolbar,
  filtered = false,
  onReset,
  infinite,
}: {
  collectionId: string;
  columns: CockpitColumn<T>[];
  data: T[];
  onOpen(row: T): void;
  rowLabel(row: T): string;
  toolbar?: ReactNode;
  filtered?: boolean;
  onReset?(): void;
  infinite?: InfiniteRows;
}) {
  const { t } = useI18n();
  return (
    <DataTable
      collectionId={collectionId}
      collectionTier="embedded"
      columns={columns}
      data={data}
      onOpen={onOpen}
      rowLabel={rowLabel}
      toolbar={toolbar}
      emptyState={{
        zero: { title: "" },
        filtered: {
          title: t("resource.noMatches"),
          description: t("resource.broaderSearch"),
          resetLabel: t("catalog.clearFilters"),
          onReset: onReset ?? (() => {}),
        },
      }}
      hasActiveFilters={filtered}
      infinite={infinite}
      sorting={[]}
      onSortingChange={() => {}}
      columnsLabel={t("catalog.columns")}
      recordsLabel={t("catalog.records")}
      actionsLabel={t("common.actions")}
    />
  );
}

function ChoiceField({
  label,
  help,
  value,
  onChange,
  placeholder,
  options,
  testId,
  description,
  byIndex = false,
}: {
  label: string;
  help?: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  options: readonly { value: string; label: ReactNode }[];
  testId: string;
  description?: string;
  byIndex?: boolean;
}) {
  return (
    <Field>
      <FieldLabel className="flex items-center gap-1">
        {label}
        {help ? (
          <ContextHelp label={label} testId={`${testId}-help`}>
            {help}
          </ContextHelp>
        ) : null}
      </FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" data-testid={testId} aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option, index) => (
              <SelectItem
                key={option.value}
                value={option.value}
                data-testid={`${testId}-${byIndex ? index : option.value}`}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

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
    <FormDialog
      open={Boolean(secret)}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      submit={{ label: t("common.done") }}
      onSubmit={onClose}
      testId="secret-dialog"
    >
      <CopyField
        labelled
        value={secret ?? ""}
        label={t("people.inviteCode")}
        testId="secret-value"
      />
      <p className="text-sm text-muted-foreground">{t("secret.once")}</p>
    </FormDialog>
  );
}

const CONSEQUENCE_LIMIT = 6;

function PermissionList({
  permissions,
  limit,
  testId,
}: {
  permissions: readonly string[];
  limit?: number;
  testId: string;
}) {
  const { t } = useI18n();
  const shown = limit === undefined ? permissions : permissions.slice(0, limit);
  const more = permissions.length - shown.length;
  return (
    <ul className="grid gap-0.5 text-sm" data-testid={testId}>
      {shown.map((permission) => (
        <li key={permission}>
          <LabelText label={permissionLabel(permission, t)} />
        </li>
      ))}
      {more > 0 ? (
        <li className="text-muted-foreground">
          {t("people.change.more", { count: String(more) })}
        </li>
      ) : null}
    </ul>
  );
}

function PermissionGroups({
  permissions,
  testId,
}: {
  permissions: readonly string[];
  testId: string;
}) {
  const { t } = useI18n();
  const groups = permissionGroups(permissions, t);
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {groups.map((group) => (
        <CollapsibleSection
          key={group.key}
          label={group.area.text}
          count={group.items.length}
          testId={`${testId}-${group.key}`}
        >
          <ul className="grid gap-0.5 text-sm">
            {group.items.map((item) => (
              <li key={item.text}>
                <LabelText label={item} />
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      ))}
    </div>
  );
}

function RoleChangeConsequence({
  user,
  to,
  isSelf,
  roles,
}: {
  user: UserItem;
  to: string;
  isSelf: boolean;
  roles: readonly RoleItem[] | undefined;
}) {
  const { t } = useI18n();
  const byName = (name: string) => roles?.find((item) => item.name === name) ?? null;
  const before = useRoleDetail(byName(user.role));
  const after = useRoleDetail(byName(to));
  const notes = roleChangeNotes({ from: user.role, to, isSelf });
  const toName = roleName(to, roles, t).text;
  const change =
    Array.isArray(before.data?.permissions) && Array.isArray(after.data?.permissions)
      ? roleChange(before.data.permissions, after.data.permissions)
      : null;
  const purpose = builtinRoleDescription(to, byName(to)?.description ?? null, t);
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="people-role-change">
      <p>{t("people.change.intro", { email: personEmailText(user, t), role: toName })}</p>
      {notes.map((note) => (
        <p key={note} className="font-medium" data-testid={`people-change-${note}`}>
          {t(`people.change.note.${note}`)}
        </p>
      ))}
      {change ? (
        <>
          {change.gained.length > 0 ? (
            <Section label={t("people.change.gains")}>
              <PermissionList
                permissions={change.gained}
                limit={CONSEQUENCE_LIMIT}
                testId="people-change-gained"
              />
            </Section>
          ) : null}
          {change.lost.length > 0 ? (
            <Section label={t("people.change.loses")}>
              <PermissionList
                permissions={change.lost}
                limit={CONSEQUENCE_LIMIT}
                testId="people-change-lost"
              />
            </Section>
          ) : null}
          {change.gained.length === 0 && change.lost.length === 0 && notes.length === 0 ? (
            <p>{t("people.change.same")}</p>
          ) : null}
        </>
      ) : purpose ? (
        <p className="text-muted-foreground">{purpose}</p>
      ) : null}
    </div>
  );
}

function PersonSheet({
  user,
  roles,
  onClose,
}: {
  user: UserItem | null;
  roles: readonly RoleItem[] | undefined;
  onClose(): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("identity:write");
  const canReadGrants = session.permissions.includes("rbac:read");
  const canAssignCustom = session.permissions.includes("rbac:write");
  const [picked, setPicked] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [confirm, setConfirm] = useState<"deactivate" | "invite" | "revokeGrants" | null>(null);
  const grants = useGrants(canReadGrants && user !== null);
  const ownGrants = (grants.data?.items ?? []).filter(
    (grant) => user && grant.subject_type === "user" && grant.subject_id === user.id,
  );
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  useEffect(() => setDisplayName(user?.display_name ?? ""), [user?.id, user?.display_name]);
  const shownRoleName = user ? (picked ?? user.role) : null;
  const role = shownRoleName ? (roles?.find((item) => item.name === shownRoleName) ?? null) : null;
  const detail = useRoleDetail(role);
  const choices = useMemo(() => {
    const all = assignableRoles(roles ?? []);
    const offered = canAssignCustom ? all : all.filter((item) => isPersonRole(item.name));
    const names = offered.length > 0 ? offered.map((item) => item.name) : [...PERSON_ROLES];
    return user && !names.includes(user.role) ? [user.role, ...names] : names;
  }, [roles, canAssignCustom, user]);
  const refresh = () => client.invalidateQueries({ queryKey: ["admin"] });
  const close = () => {
    setPicked(null);
    onClose();
  };
  const update = useMutation({
    mutationFn: ({ target, to }: { target: UserItem; to: string }) => {
      if (isPersonRole(to))
        return apiRequest<unknown>(`/v1/identity/users/${encodeURIComponent(target.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: to }),
        });
      const next = roles?.find((item) => item.name === to);
      if (!next) throw new Error("role not found");
      return apiRequest<unknown>(`/v1/rbac/users/${encodeURIComponent(target.id)}/role`, {
        method: "POST",
        body: JSON.stringify({ role_id: next.id }),
      });
    },
    onSuccess: async () => {
      setPicked(null);
      setConfirm(null);
      await refresh();
      toast.success(t("people.roleUpdated"));
    },
    onError: (error) => refusalToast(error, t),
  });
  const updateDisplayName = useMutation({
    mutationFn: (target: UserItem) =>
      apiRequest<UserItem>(`/v1/identity/users/${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ display_name: displayName.trim() || null }),
      }),
    onSuccess: async () => {
      await refresh();
      toast.success(t("people.displayNameUpdated"));
    },
    onError: (error) => refusalToast(error, t),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/identity/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirm(null);
      close();
      await refresh();
      toast.success(t("people.deactivated"));
    },
    onError: (error) => refusalToast(error, t),
  });
  const revokeGrants = useMutation({
    mutationFn: async (ids: readonly string[]) => {
      for (const id of ids)
        await apiRequest<void>(`/v1/rbac/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["admin", "grants"] }),
    onSuccess: () => {
      setConfirm(null);
      toast.success(t("people.grantsRevoked"));
    },
    onError: (error) => refusalToast(error, t),
  });
  const issueInvite = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ plaintext_token: string; expires_at: string }>(
        `/v1/identity/users/${encodeURIComponent(id)}/invites`,
        { method: "POST", body: JSON.stringify({ ttl_minutes: INVITE_TTL_HOURS * 60 }) },
      ),
    onSuccess: (result) => {
      setConfirm(null);
      setInvite({ token: result.plaintext_token, expiresAt: result.expires_at });
    },
    onError: (error) => refusalToast(error, t),
  });

  const changed = user && picked && picked !== user.role ? picked : null;
  const label = user ? roleName(user.role, roles, t) : null;
  const purpose = shownRoleName
    ? builtinRoleDescription(shownRoleName, role?.description ?? null, t)
    : null;
  const displayNameChanged = Boolean(user && displayName.trim() !== (user.display_name ?? ""));
  useDirtyGuard(Boolean(changed || displayNameChanged));
  const self = user?.id === session.principal.id;
  const menu: ActionMenuItem[] =
    canWrite && user && !self
      ? [
          ...(user.status === "invited"
            ? [
                {
                  label: t("people.invite"),
                  onSelect: () => setConfirm("invite"),
                  testId: "people-invite",
                },
              ]
            : []),
          {
            label: t("people.deactivate"),
            onSelect: () => setConfirm("deactivate"),
            destructive: true,
            testId: "people-deactivate",
          },
          ...(canAssignCustom && ownGrants.length > 0
            ? [
                {
                  label: t("people.revokeGrants"),
                  onSelect: () => setConfirm("revokeGrants"),
                  destructive: true,
                  testId: "people-revoke-grants",
                },
              ]
            : []),
        ]
      : [];
  const connections = user?.oauth_connections ?? 0;
  const apps = user ? personApps(user) : [];
  const shownEmail = user ? personEmailText(user, t) : "";

  return (
    <>
      <RecordSheet
        dock
        open={Boolean(user)}
        onOpenChange={(open) => !open && close()}
        title={<span className="break-all">{user ? personNameText(user, t) : null}</span>}
        badge={user ? <StatusBadge state={user.status} /> : null}
        menu={menu.length > 0 ? <ActionMenu items={menu} testId="people-sheet-menu" /> : null}
        testId="people-sheet"
        closeTestId="people-sheet-close"
      >
        {user ? (
          <Section label={t("people.displayName")}>
            <div className="flex flex-col gap-2">
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={120}
                aria-label={t("people.displayName")}
                data-testid="people-display-name"
                disabled={!canWrite}
              />
              {canWrite && displayNameChanged ? (
                <Button
                  onClick={() => updateDisplayName.mutate(user)}
                  disabled={updateDisplayName.isPending}
                  data-testid="people-display-name-save"
                >
                  {t("common.save")}
                </Button>
              ) : null}
            </div>
          </Section>
        ) : null}
        {user ? (
          <FactList
            testId="people-sheet-facts"
            items={[
              personEmailFact(user, t),
              ...(apps.length > 0
                ? [
                    {
                      label: t("people.app"),
                      testId: "people-sheet-apps",
                      value: (
                        <span className="flex flex-wrap gap-1">
                          {apps.map((app) => (
                            <StatusBadge
                              key={app}
                              state="app"
                              label={t("people.appBadge", { id: app })}
                            />
                          ))}
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                label: t("access.groups"),
                value: membershipNames(user.groups, t),
                testId: "people-sheet-groups",
              },
              {
                label: t("people.role"),
                help: purpose ?? undefined,
                testId: "people-sheet-role",
                value: canWrite ? (
                  <Select value={picked ?? user.role} onValueChange={setPicked}>
                    <SelectTrigger
                      className="w-full"
                      aria-label={t("people.role")}
                      data-testid="people-role"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {choices.map((name) => (
                          <SelectItem key={name} value={name} data-testid={`people-role-${name}`}>
                            <LabelText label={roleName(name, roles, t)} />
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : label ? (
                  <LabelText label={label} />
                ) : null,
              },
            ]}
          />
        ) : null}
        {user && changed ? (
          <RoleChangeConsequence
            user={user}
            to={changed}
            isSelf={user.id === session.principal.id}
            roles={roles}
          />
        ) : null}
        <Section
          label={
            changed
              ? t("people.sheet.permissionsOf", { role: roleName(changed, roles, t).text })
              : t("people.sheet.permissions")
          }
          testId="people-sheet-permissions-section"
        >
          {!role ? (
            <p className="text-sm text-muted-foreground" data-testid="people-sheet-unreadable">
              {t("people.sheet.unreadable")}
            </p>
          ) : Array.isArray(detail.data?.permissions) ? (
            detail.data.permissions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("people.sheet.none")}</p>
            ) : (
              <PermissionGroups
                permissions={detail.data.permissions}
                testId="people-sheet-permissions"
              />
            )
          ) : detail.error ? (
            <p className="text-sm text-muted-foreground">{t("people.sheet.unreadable")}</p>
          ) : (
            <DataState state="loading" />
          )}
          <p className="text-xs text-muted-foreground" data-testid="people-sheet-grants-note">
            {t("people.sheet.grantsNote")}{" "}
            {canReadGrants ? (
              <Link
                to={peopleHref("grants")}
                className="font-medium text-foreground underline underline-offset-2"
                onClick={close}
                data-testid="people-sheet-grants-link"
              >
                {t("access.grants")}
              </Link>
            ) : (
              t("access.grants")
            )}
          </p>
        </Section>
        {user && changed ? (
          <SaveBar
            count={1}
            testId="people-save-bar"
            discard={{ onClick: () => setPicked(null), testId: "people-role-discard" }}
            save={{
              onClick: () => update.mutate({ target: user, to: changed }),
              pending: update.isPending,
              testId: "people-role-save",
            }}
          />
        ) : null}
      </RecordSheet>
      <ConfirmDialog
        open={confirm === "deactivate"}
        onOpenChange={(open) => !open && setConfirm(null)}
        object={shownEmail}
        verb={t("people.deactivate")}
        consequence={
          connections > 0
            ? tn("people.deactivateConnections", connections)
            : t("people.deactivateConsequence")
        }
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (user) await remove.mutateAsync(user.id).catch(() => {});
        }}
        testId="people-deactivate-confirm"
      />
      <ConfirmDialog
        open={confirm === "revokeGrants"}
        onOpenChange={(open) => !open && setConfirm(null)}
        object={t("people.grantsObject", { email: shownEmail })}
        verb={t("people.revokeGrantsVerb")}
        consequence={tn("people.revokeGrantsConsequence", ownGrants.length)}
        destructive
        pending={revokeGrants.isPending}
        onConfirm={async () => {
          await revokeGrants.mutateAsync(ownGrants.map((grant) => grant.id)).catch(() => {});
        }}
        testId="people-revoke-grants-confirm"
      />
      <ConfirmDialog
        open={confirm === "invite"}
        onOpenChange={(open) => !open && setConfirm(null)}
        object={t("people.inviteObject", { email: shownEmail })}
        verb={t("people.inviteVerb")}
        consequence={t("people.inviteConsequence", { hours: String(INVITE_TTL_HOURS) })}
        pending={issueInvite.isPending}
        onConfirm={async () => {
          if (user) await issueInvite.mutateAsync(user.id).catch(() => {});
        }}
        testId="people-invite-confirm"
      />
      <SecretDialog
        secret={invite?.token ?? null}
        onClose={() => setInvite(null)}
        title={
          invite
            ? t("people.inviteReadyUntil", { time: dateTime(invite.expiresAt) })
            : t("people.inviteReady")
        }
      />
    </>
  );
}

function PeopleTab({ action }: { action: ReactNode }) {
  const { t, tn, dateTime } = useI18n();
  const session = useSession();
  const router = useRouter();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const appFilter = peopleAppFromUrl(searchStr);
  const people = usePeopleList(true, appFilter);
  const roles = useRoles(session.permissions.includes("rbac:read"));
  const roleItems = roles.data?.items;
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const items = people.items;
  const count = people.total ?? items.length;
  const opened = items.find((item) => item.id === openedId) ?? null;
  const invited = items.filter((item) => item.status === "invited").length;
  const needle = search.trim().toLowerCase();
  const shown = items.filter(
    (item) =>
      (roleFilter === "all" || item.role === roleFilter) &&
      (!needle ||
        (item.display_name ?? "").toLowerCase().includes(needle) ||
        personEmailText(item, t).toLowerCase().includes(needle)),
  );
  const roleOptions = [...new Set(items.map((item) => item.role))];
  const appOptions = [
    ...new Set([...items.flatMap((item) => personApps(item)), ...(appFilter ? [appFilter] : [])]),
  ].sort();
  const chooseApp = (value: string) => {
    const params = new URLSearchParams(window.location.search);
    if (value === "all") params.delete(PEOPLE_APP_PARAM);
    else params.set(PEOPLE_APP_PARAM, value);
    const query = params.toString();
    router.history.replace(
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  };
  const columns = useMemo<CockpitColumn<UserItem>[]>(() => {
    const column = tableColumns<UserItem>({ t, dateTime });
    return [
      column.custom(
        "person",
        (row) => personNameText(row, t),
        t("people.person"),
        (row, index) => (
          <span className="flex min-w-0 flex-col" data-testid={`people-name-${index}`}>
            <span className="truncate">{personNameText(row, t)}</span>
            {row.display_name ? (
              <span className="truncate text-xs text-muted-foreground">
                {personEmailText(row, t)}
              </span>
            ) : null}
            {personApps(row).length > 0 ? (
              <span className="flex flex-wrap gap-1 pt-1" data-testid={`people-apps-${index}`}>
                {personApps(row).map((app) => (
                  <StatusBadge key={app} state="app" label={t("people.appBadge", { id: app })} />
                ))}
              </span>
            ) : null}
          </span>
        ),
        { width: "w-[44%]" },
      ),
      column.custom(
        "role",
        (row) => row.role,
        t("people.role"),
        (row, index) => (
          <span className="block truncate" data-testid={`people-role-badge-${index}`}>
            <LabelText label={roleName(row.role, roleItems, t)} />
          </span>
        ),
        { width: "w-[28%]" },
      ),
      column.custom(
        "status",
        (row) => row.status,
        t("resource.field.status"),
        (row) => <StatusBadge state={row.status} />,
        { width: "w-[28%]" },
      ),
    ];
  }, [t, dateTime, roleItems]);
  return (
    <>
      <SectionList
        name="people"
        resource={t("people.section.people")}
        query={people.view}
        emptyLine={appFilter ? t("people.appEmpty", { id: appFilter }) : t("resource.people.empty")}
        emptyAction={
          appFilter ? (
            <Button
              variant="outline"
              onClick={() => chooseApp("all")}
              data-testid="people-app-filter-reset"
            >
              {t("people.showAll")}
            </Button>
          ) : (
            action
          )
        }
        summary={
          invited > 0
            ? tn("people.summaryInvited", count, { invited })
            : t(count === 1 ? "people.summary.one" : "people.summary", { count })
        }
      >
        <AdminTable
          collectionId="people-list"
          columns={columns}
          data={shown}
          infinite={people.infinite}
          onOpen={(row) => setOpenedId(row.id)}
          rowLabel={(row) =>
            t("people.openRow", {
              email: personEmailText(row, t),
              role: roleName(row.role, roleItems, t).text,
            })
          }
          filtered={Boolean(needle) || roleFilter !== "all" || appFilter !== null}
          onReset={() => {
            setSearch("");
            setRoleFilter("all");
            chooseApp("all");
          }}
          toolbar={
            <FilterBar
              search={{
                value: search,
                onChange: setSearch,
                placeholder: t("people.search"),
                testId: "people-search",
              }}
              selects={[
                {
                  value: roleFilter,
                  onChange: setRoleFilter,
                  label: t("people.role"),
                  testId: "people-role-filter",
                  options: [
                    { value: "all", label: t("people.allRoles") },
                    ...roleOptions.map((name) => ({
                      value: name,
                      label: roleName(name, roleItems, t).text,
                    })),
                  ],
                },
                ...(appOptions.length > 0
                  ? [
                      {
                        value: appFilter ?? "all",
                        onChange: chooseApp,
                        label: t("people.app"),
                        testId: "people-app-filter",
                        options: [
                          { value: "all", label: t("people.allApps") },
                          ...appOptions.map((app) => ({ value: app, label: app })),
                        ],
                      },
                    ]
                  : []),
              ]}
            />
          }
        />
      </SectionList>
      <PersonSheet user={opened} roles={roleItems} onClose={() => setOpenedId(null)} />
    </>
  );
}

function InvitePersonDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const session = useSession();
  const roles = useRoles(open && session.permissions.includes("rbac:read"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PersonRole>("member");
  const [displayName, setDisplayName] = useState("");
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const user = await apiRequest<UserItem>("/v1/identity/users", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          role,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        }),
      });
      return apiRequest<{ plaintext_token: string; expires_at: string }>(
        `/v1/identity/users/${encodeURIComponent(user.id)}/invites`,
        { method: "POST", body: JSON.stringify({ ttl_minutes: INVITE_TTL_HOURS * 60 }) },
      );
    },
    onSuccess: async (result) => {
      onOpenChange(false);
      setEmail("");
      setDisplayName("");
      setInvite({ token: result.plaintext_token, expiresAt: result.expires_at });
      toast.success(t("people.created"));
    },
    onError: (error) => refusalToast(error, t),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin"] }),
  });
  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("people.create")}
        submit={{
          label: t("people.createSubmit"),
          pending: create.isPending,
          disabled: !email.trim(),
        }}
        onSubmit={() => create.mutate()}
        testId="people-create-dialog"
      >
        <Field>
          <FieldLabel htmlFor="people-display-name-create">{t("people.displayName")}</FieldLabel>
          <Input
            id="people-display-name-create"
            value={displayName}
            maxLength={120}
            onChange={(event) => setDisplayName(event.target.value)}
            data-testid="people-create-display-name"
          />
        </Field>
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
        <ChoiceField
          label={t("people.role")}
          help={t("people.createRoleHint")}
          value={role}
          onChange={(value) => isPersonRole(value) && setRole(value)}
          options={PERSON_ROLES.map((name) => ({
            value: name,
            label: <LabelText label={roleName(name, roles.data?.items, t)} />,
          }))}
          testId="people-create-role"
        />
      </FormDialog>
      <SecretDialog
        secret={invite?.token ?? null}
        onClose={() => setInvite(null)}
        title={
          invite
            ? t("people.inviteReadyUntil", { time: dateTime(invite.expiresAt) })
            : t("people.inviteReady")
        }
      />
    </>
  );
}

function RoleSheet({ role, onClose }: { role: RoleItem | null; onClose(): void }) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const roles = useRoles();
  const detail = useRoleDetail(role);
  const editable = Boolean(role && !role.is_builtin && session.permissions.includes("rbac:write"));
  const permissions = useQuery({
    queryKey: ["admin", "permissions"],
    queryFn: () => apiRequest<Envelope<PermissionItem>>("/v1/rbac/permissions"),
    enabled: editable,
  });
  const change = useMutation({
    mutationFn: ({ permission, enabled }: { permission: string; enabled: boolean }) =>
      apiRequest(
        `/v1/rbac/roles/${encodeURIComponent(role?.id ?? "")}/permissions${enabled ? "" : `/${encodeURIComponent(permission)}`}`,
        {
          method: enabled ? "POST" : "DELETE",
          ...(enabled ? { body: JSON.stringify({ permission }) } : {}),
        },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin", "role", role?.id] }),
    onError: (error) => refusalToast(error, t),
  });
  const held = detail.data?.permissions ?? [];
  const purpose = role ? builtinRoleDescription(role.name, role.description, t) : null;
  return (
    <RecordSheet
      open={Boolean(role)}
      onOpenChange={(open) => !open && onClose()}
      title={role ? <LabelText label={roleName(role.name, roles.data?.items, t)} /> : null}
      testId="role-sheet"
      closeTestId="role-sheet-close"
    >
      <FactList
        items={[
          ...(purpose ? [{ label: t("common.description"), value: purpose }] : []),
          {
            label: t("access.kind"),
            value: t(role?.is_builtin ? "access.builtin" : "access.custom"),
          },
        ]}
      />
      <Section label={t("access.permissions")}>
        {editable ? (
          <div className="flex flex-col gap-2" data-testid="role-permissions-list">
            {(permissions.data?.items ?? []).map((permission, index) => (
              <label
                key={permission.name}
                className="flex min-h-10 items-center gap-3 text-sm"
                htmlFor={`role-permission-${index}`}
              >
                <Checkbox
                  id={`role-permission-${index}`}
                  checked={held.includes(permission.name)}
                  onCheckedChange={(value) =>
                    change.mutate({ permission: permission.name, enabled: value === true })
                  }
                  data-testid={`role-permission-${index}`}
                />
                <LabelText label={permissionLabel(permission.name, t)} />
              </label>
            ))}
          </div>
        ) : detail.data ? (
          held.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("people.sheet.none")}</p>
          ) : (
            <PermissionList permissions={[...held].sort()} testId="role-permissions-list" />
          )
        ) : detail.error ? (
          <p className="text-sm text-muted-foreground">{t("people.sheet.unreadable")}</p>
        ) : (
          <DataState state="loading" />
        )}
      </Section>
    </RecordSheet>
  );
}

function RolesTab({ action }: { action: ReactNode }) {
  const { t, dateTime } = useI18n();
  const query = useRoles();
  const items = query.data?.items ?? [];
  const [openedId, setOpenedId] = useState<string | null>(null);
  const columns = useMemo<CockpitColumn<RoleItem>[]>(() => {
    const column = tableColumns<RoleItem>({ t, dateTime });
    return [
      column.custom(
        "name",
        (row) => row.name,
        t("people.role"),
        (row, index) => (
          <span className="block truncate" data-testid={`roles-list-${index}-name`}>
            <LabelText label={roleName(row.name, items, t)} />
          </span>
        ),
        { width: "w-[30%]" },
      ),
      column.custom(
        "permissions",
        (row) => row.permissions?.length,
        t("access.rolePermissions"),
        (row) =>
          row.permissions ? (
            <PermissionList permissions={row.permissions} limit={3} testId="role-row-permissions" />
          ) : (
            "—"
          ),
        { width: "w-[50%]" },
      ),
      column.custom(
        "member_count",
        (row) => row.member_count,
        t("access.members"),
        (row) => row.member_count ?? "—",
        { width: "w-[20%]" },
      ),
    ];
  }, [t, dateTime, items]);
  return (
    <div data-testid="roles-section">
      <SectionList
        name="roles"
        help={t("access.rolesHelp")}
        resource={t("access.roles")}
        query={query}
        emptyLine={t("access.noRoles")}
        emptyAction={action}
        summary={t(items.length === 1 ? "access.rolesSummary.one" : "access.rolesSummary", {
          count: items.length,
        })}
      >
        <AdminTable
          collectionId="roles-list"
          columns={columns}
          data={items}
          onOpen={(row) => setOpenedId(row.id)}
          rowLabel={(row) => t("roles.openRow", { name: roleName(row.name, items, t).text })}
        />
      </SectionList>
      <RoleSheet
        role={items.find((item) => item.id === openedId) ?? null}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

function GroupSheet({ group, onClose }: { group: GroupItem | null; onClose(): void }) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("rbac:write");
  const people = usePeople(
    group !== null && canWrite && session.permissions.includes("identity:read"),
  );
  const roles = useRoles(group !== null);
  const [dialog, setDialog] = useState<"member" | "role" | null>(null);
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const closeDialog = () => {
    setDialog(null);
    setUserId("");
    setRoleId("");
  };
  const addMember = useMutation({
    mutationFn: () =>
      apiRequest(
        `/v1/rbac/groups/${encodeURIComponent(group?.id ?? "")}/members/${encodeURIComponent(userId)}`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      closeDialog();
      await client.invalidateQueries({ queryKey: ["admin"] });
      toast.success(t("access.memberAdded"));
    },
    onError: (error) => refusalToast(error, t),
  });
  const assignRole = useMutation({
    mutationFn: () =>
      apiRequest(
        `/v1/rbac/groups/${encodeURIComponent(group?.id ?? "")}/roles/${encodeURIComponent(roleId)}`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      closeDialog();
      await client.invalidateQueries({ queryKey: ["admin"] });
      toast.success(t("access.groupRoleAssigned"));
    },
    onError: (error) => refusalToast(error, t),
  });
  return (
    <>
      <RecordSheet
        dock
        open={Boolean(group)}
        onOpenChange={(open) => !open && onClose()}
        title={group?.name}
        menu={
          canWrite ? (
            <ActionMenu
              testId="group-sheet-menu"
              items={[
                {
                  label: t("access.addMember"),
                  onSelect: () => setDialog("member"),
                  testId: "group-add-member",
                },
                {
                  label: t("access.assignGroupRole"),
                  onSelect: () => setDialog("role"),
                  testId: "group-assign-role",
                },
              ]}
            />
          ) : null
        }
        testId="group-sheet"
        closeTestId="group-sheet-close"
      >
        <FactList
          items={[
            { label: t("common.description"), value: group?.description || "—" },
            {
              label: t("access.members"),
              value: (
                <span className="text-muted-foreground" data-testid="groups-members-note">
                  {group?.member_count ?? "—"}
                </span>
              ),
            },
          ]}
        />
      </RecordSheet>
      <FormDialog
        open={dialog === "member"}
        onOpenChange={(open) => !open && closeDialog()}
        title={t("access.addMember")}
        submit={{ label: t("access.addMember"), pending: addMember.isPending, disabled: !userId }}
        onSubmit={() => addMember.mutate()}
        testId="group-member-dialog"
      >
        <ChoiceField
          label={t("access.person")}
          value={userId}
          onChange={setUserId}
          placeholder={t("access.choosePerson")}
          options={(people.data?.items ?? []).map((person) => ({
            value: person.id,
            label: personEmailText(person, t),
          }))}
          description={t("access.addMemberConsequence", { group: group?.name ?? "" })}
          testId="group-member-person"
          byIndex
        />
      </FormDialog>
      <FormDialog
        open={dialog === "role"}
        onOpenChange={(open) => !open && closeDialog()}
        title={t("access.assignGroupRole")}
        submit={{
          label: t("access.assignGroupRole"),
          pending: assignRole.isPending,
          disabled: !roleId,
        }}
        onSubmit={() => assignRole.mutate()}
        testId="group-role-dialog"
      >
        <ChoiceField
          label={t("people.role")}
          value={roleId}
          onChange={setRoleId}
          placeholder={t("access.chooseRole")}
          options={assignableRoles(roles.data?.items ?? []).map((role) => ({
            value: role.id,
            label: <LabelText label={roleName(role.name, roles.data?.items, t)} />,
          }))}
          description={t("access.assignGroupRoleConsequence", { group: group?.name ?? "" })}
          testId="group-role-select"
          byIndex
        />
      </FormDialog>
    </>
  );
}

function GroupsTab({ action }: { action: ReactNode }) {
  const { t, dateTime } = useI18n();
  const query = useGroups();
  const items = query.data?.items ?? [];
  const [openedId, setOpenedId] = useState<string | null>(null);
  const columns = useMemo<CockpitColumn<GroupItem>[]>(() => {
    const column = tableColumns<GroupItem>({ t, dateTime });
    return [
      column.text("name", (row) => row.name, t("access.group"), { width: "w-[40%]" }),
      column.custom(
        "member_count",
        (row) => row.member_count,
        t("access.members"),
        (row) => row.member_count ?? "—",
        { width: "w-[60%]" },
      ),
    ];
  }, [t, dateTime]);
  return (
    <div data-testid="groups-section">
      <SectionList
        name="groups"
        resource={t("access.groups")}
        query={query}
        emptyLine={t("access.noGroups")}
        emptyAction={action}
        summary={t(items.length === 1 ? "access.groupsSummary.one" : "access.groupsSummary", {
          count: items.length,
        })}
      >
        <AdminTable
          collectionId="groups-list"
          columns={columns}
          data={items}
          onOpen={(row) => setOpenedId(row.id)}
          rowLabel={(row) => t("groups.openRow", { name: row.name })}
        />
      </SectionList>
      <GroupSheet
        group={items.find((item) => item.id === openedId) ?? null}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

function useGrantNames(enabled = true) {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => enabled && session.permissions.includes(permission);
  const people = usePeople(can("identity:read"));
  const groups = useGroups(enabled);
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    enabled: can("workflow:read"),
    queryFn: () => apiRequest<Envelope<RecordItem>>("/v1/workflows?limit=200"),
  });
  const connectors = useQuery({
    queryKey: ["admin", "connectors"],
    enabled: can("connector:read"),
    queryFn: () => apiRequest<Envelope<RecordItem>>("/v1/connectors?limit=200"),
  });
  const records = (type: GrantResourceType) =>
    (type === "workflow" ? workflows.data?.items : connectors.data?.items) ?? [];
  const recordName = (item: RecordItem) => item.display_name || item.name || item.slug || null;
  const subjectName = (grant: Pick<GrantItem, "subject_type" | "subject_id">) => {
    if (grant.subject_type === "user")
      return (
        ((person) => (person ? personEmailText(person, t) : undefined))(
          people.data?.items.find((item) => item.id === grant.subject_id),
        ) ?? t("access.person")
      );
    if (grant.subject_type === "group")
      return (
        groups.data?.items.find((item) => item.id === grant.subject_id)?.name ?? t("access.group")
      );
    return t("access.systemAccount");
  };
  const resourceName = (grant: GrantItem) => {
    const kind = resourceTypeLabel(grant.resource_type, t).text;
    if (!isGrantResourceType(grant.resource_type)) return kind;
    const record = records(grant.resource_type).find((item) => item.id === grant.resource_id);
    const name = record ? recordName(record) : null;
    return name ? t("access.grantResource", { kind, name }) : kind;
  };
  return {
    people: people.data?.items ?? [],
    groups: groups.data?.items ?? [],
    records,
    recordName,
    subjectName,
    resourceName,
  };
}

function grantTitle(names: ReturnType<typeof useGrantNames>, grant: GrantItem): string {
  return `${names.subjectName(grant)} → ${names.resourceName(grant)}`;
}

function GrantSheet({ grant, onClose }: { grant: GrantItem | null; onClose(): void }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const names = useGrantNames();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/v1/rbac/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirming(false);
      onClose();
      await client.invalidateQueries({ queryKey: ["admin", "grants"] });
      toast.success(t("access.grantRevoked"));
    },
    onError: (error) =>
      toast.error(
        t("access.revokeFailed", {
          reason: error instanceof ApiError ? error.message : t("resource.loadFailedDescription"),
        }),
      ),
  });
  const permission = grant ? permissionLabel(grant.permission, t) : null;
  return (
    <>
      <RecordSheet
        dock
        open={Boolean(grant)}
        onOpenChange={(open) => !open && onClose()}
        title={grant ? grantTitle(names, grant) : null}
        menu={
          grant && session.permissions.includes("rbac:write") ? (
            <ActionMenu
              items={[
                {
                  label: t("access.revokeGrant"),
                  destructive: true,
                  onSelect: () => setConfirming(true),
                  testId: "grant-revoke",
                },
              ]}
            />
          ) : null
        }
        testId="grant-sheet"
        closeTestId="grant-sheet-close"
      >
        {grant ? (
          <FactList
            testId="grant-sheet-facts"
            items={[
              { label: t("access.who"), value: names.subjectName(grant) },
              { label: t("access.grantRecord"), value: names.resourceName(grant) },
              {
                label: t("access.right"),
                value: <LabelText label={permissionLabel(grant.permission, t)} />,
              },
              {
                label: t("access.validity"),
                value: grant.expires_at
                  ? t("access.grantExpires", { time: dateTime(grant.expires_at) })
                  : t("access.grantNoExpiry"),
              },
            ]}
          />
        ) : null}
      </RecordSheet>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        object={
          grant && permission
            ? t("access.revokeObject", {
                permission: permission.text,
                subject: names.subjectName(grant),
              })
            : ""
        }
        verb={t("access.revokeVerb")}
        consequence={
          grant ? t("access.revokeConsequence", { resource: names.resourceName(grant) }) : ""
        }
        destructive
        pending={revoke.isPending}
        onConfirm={async () => {
          if (grant) await revoke.mutateAsync(grant.id).catch(() => {});
        }}
        testId="grant-revoke-confirm"
      />
    </>
  );
}

function GrantsTab({ action }: { action: ReactNode }) {
  const { t, dateTime } = useI18n();
  const query = useGrants();
  const names = useGrantNames();
  const items = query.data?.items ?? [];
  const [openedId, setOpenedId] = useState<string | null>(null);
  const columns: CockpitColumn<GrantItem>[] = (() => {
    const column = tableColumns<GrantItem>({ t, dateTime });
    return [
      column.custom(
        "subject",
        (row) => row.subject_id,
        t("access.grant"),
        (row) => (
          <span className="block truncate">
            <RowName>{grantTitle(names, row)}</RowName>
          </span>
        ),
        { width: "w-[50%]", ownsRowLink: true },
      ),
      column.custom(
        "permission",
        (row) => row.permission,
        t("access.right"),
        (row) => (
          <span className="block truncate">
            <LabelText label={permissionLabel(row.permission, t)} />
          </span>
        ),
        { width: "w-[25%]" },
      ),
      column.custom(
        "expires",
        (row) => row.expires_at,
        t("access.validity"),
        (row) => (
          <span
            title={
              row.expires_at
                ? t("access.grantExpires", { time: dateTime(row.expires_at) })
                : t("access.grantNoExpiry")
            }
          >
            <StatusBadge state={grantStatus(row.expires_at, Date.now())} />
          </span>
        ),
        { width: "w-[25%]" },
      ),
    ];
  })();
  return (
    <div data-testid="grants-section">
      <SectionList
        name="grants"
        help={t("access.grantsHelp")}
        resource={t("access.grants")}
        query={query}
        emptyLine={t("access.noGrants")}
        emptyAction={action}
        summary={t(
          items.every((item) => item.resource_type === "workflow")
            ? items.length === 1
              ? "access.workflowGrants.one"
              : "access.workflowGrants.other"
            : items.length === 1
              ? "access.grantsSummary.one"
              : "access.grantsSummary",
          {
            count: items.length,
          },
        )}
      >
        <AdminTable
          collectionId="grants-list"
          columns={columns}
          data={items}
          onOpen={(row) => setOpenedId(row.id)}
          rowLabel={(row) =>
            t("grants.openRow", {
              permission: permissionLabel(row.permission, t).text,
              subject: names.subjectName(row),
            })
          }
        />
      </SectionList>
      <GrantSheet
        grant={items.find((item) => item.id === openedId) ?? null}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

const GRANT_RIGHTS = ["workflow:run", "workflow:write"] as const;

function GrantAccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const names = useGrantNames(open);
  const [subject, setSubject] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [permission, setPermission] = useState<string>(GRANT_RIGHTS[0]);
  const [subjectType, subjectId] = subject.split(":") as ["user" | "group" | "", string];
  const create = useMutation({
    mutationFn: () =>
      apiRequest("/v1/rbac/grants", {
        method: "POST",
        body: JSON.stringify({
          subject_type: subjectType,
          subject_id: subjectId,
          resource_type: "workflow",
          resource_id: workflowId,
          permission,
        }),
      }),
    onSuccess: async () => {
      onOpenChange(false);
      setSubject("");
      setWorkflowId("");
      await client.invalidateQueries({ queryKey: ["admin", "grants"] });
      toast.success(t("access.grantCreated"));
    },
    onError: (error) => refusalToast(error, t),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("access.createGrant")}
      submit={{
        label: t("access.grantVerb"),
        pending: create.isPending,
        disabled: !subjectId || !workflowId,
      }}
      onSubmit={() => create.mutate()}
      testId="grant-create-dialog"
    >
      <ChoiceField
        label={t("access.who")}
        value={subject}
        onChange={setSubject}
        placeholder={t("access.chooseSubject")}
        options={[
          ...names.people.map((item) => ({
            value: `user:${item.id}`,
            label: personEmailText(item, t),
          })),
          ...names.groups.map((item) => ({ value: `group:${item.id}`, label: item.name })),
        ]}
        testId="grant-subject"
        byIndex
      />
      <ChoiceField
        label={t("access.workflow")}
        value={workflowId}
        onChange={setWorkflowId}
        placeholder={t("access.chooseRecord")}
        options={names.records("workflow").map((record) => ({
          value: record.id,
          label: names.recordName(record) ?? resourceTypeLabel("workflow", t).text,
        }))}
        testId="grant-resource"
        byIndex
      />
      <Field>
        <FieldLabel className="flex items-center gap-1">
          {t("access.right")}
          <ContextHelp label={t("access.right")} testId="grant-permission-help">
            {t("access.grantRightHelp")}
          </ContextHelp>
        </FieldLabel>
        <SegmentedControl
          label={t("access.right")}
          value={permission}
          onValueChange={setPermission}
          testId="grant-permission"
          options={GRANT_RIGHTS.map((name) => ({
            value: name,
            label: t(name === "workflow:run" ? "access.right.run" : "access.right.write"),
            testId: `grant-permission-${name === "workflow:run" ? "run" : "write"}`,
          }))}
        />
      </Field>
    </FormDialog>
  );
}

function CreateRecordDialog({
  kind,
  onOpenChange,
}: {
  kind: "role" | "group" | null;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      apiRequest(kind === "role" ? "/v1/rbac/roles" : "/v1/rbac/groups", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      }),
    onSuccess: async () => {
      const created = kind;
      onOpenChange(false);
      setName("");
      setDescription("");
      await client.invalidateQueries({
        queryKey: ["admin", created === "role" ? "roles" : "groups"],
      });
      toast.success(t(created === "role" ? "access.roleCreated" : "access.groupCreated"));
    },
    onError: (error) => refusalToast(error, t),
  });
  return (
    <FormDialog
      open={kind !== null}
      onOpenChange={onOpenChange}
      title={t(kind === "role" ? "access.createRole" : "access.createGroup")}
      submit={{ label: t("common.create"), pending: create.isPending, disabled: !name.trim() }}
      onSubmit={() => create.mutate()}
      testId="access-create-dialog"
    >
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
    </FormDialog>
  );
}

const fetchApps = () => apiRequest<Envelope<AppSummary>>("/v1/apps");
const fetchApp = (id: string) => apiRequest<AppView>(`/v1/apps/${encodeURIComponent(id)}`);
const fetchSettings = () => apiRequest<SettingsResponse>("/v1/settings");
const SETTINGS_KEY = ["admin", "settings"] as const;
const appKey = (id: string) => ["admin", "apps", id] as const;

function useApps(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "apps"], queryFn: fetchApps, enabled, ...live });
}

function useSettingsSnapshot(enabled: boolean) {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings, enabled });
}

function settingValue(data: SettingsResponse | undefined, path: string): unknown {
  return data?.items.find((item) => item.path === path)?.value;
}

class ActivationRefused extends Error {}

function useAppSettingsSave() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: AppSettingsChanges): Promise<AppActivationOutcome> => {
      const data = await client.fetchQuery({
        queryKey: SETTINGS_KEY,
        queryFn: fetchSettings,
        staleTime: 0,
      });
      const saved = await apiRequest<{ saved_revision: number }>("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(appSettingsPatch(data, changes)),
      });
      const activated = await apiRequest<{ activation_status: string }>(
        settingsActivationPath(saved),
        { method: "POST" },
      );
      const outcome = appActivationOutcome(activated.activation_status);
      if (outcome === "failed") throw new ActivationRefused(activated.activation_status);
      return outcome;
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "apps"] }),
        client.invalidateQueries({ queryKey: SETTINGS_KEY }),
      ]),
  });
}

function appSaveError(error: unknown, t: Translate): string {
  if (error instanceof ActivationRefused) return t("apps.save.notActivated");
  if (settingsSaveFailure(error) === "conflict") return t("apps.save.conflict");
  return t("apps.save.failed", {
    reason: error instanceof ApiError ? error.message : t("resource.loadFailedDescription"),
  });
}

function dialogError(
  tried: boolean,
  errors: readonly TranslationKey[],
  failure: unknown,
  t: Translate,
): string | null {
  if (tried && errors.length > 0) return errors.map((key) => t(key)).join(" ");
  return failure ? appSaveError(failure, t) : null;
}

function environmentLabel(environment: string, t: Translate): string {
  if (environment === "prod") return t("apps.environment.prod");
  if (environment === "dev") return t("apps.environment.dev");
  return environment;
}

function ReadinessBadge({
  app,
  testId,
}: {
  app: Pick<AppSummary, "configured" | "ready">;
  testId?: string;
}) {
  const { t } = useI18n();
  const readiness = appReadiness(app);
  return (
    <StatusBadge state={readiness} label={t(APP_READINESS_LABEL[readiness])} testId={testId} />
  );
}

function AppsTab() {
  const { t, tn, dateTime } = useI18n();
  const query = useApps();
  const items = query.data?.items ?? [];
  const [openedId, setOpenedId] = useState<string | null>(null);
  const columns: CockpitColumn<AppSummary>[] = (() => {
    const column = tableColumns<AppSummary>({ t, dateTime });
    return [
      column.custom(
        "id",
        (row) => row.id,
        t("apps.column.app"),
        (app, index) => (
          <span className="block truncate" data-testid={`apps-list-${index}-name`}>
            <RowName>{app.id}</RowName>
          </span>
        ),
        { width: "w-[30%]", ownsRowLink: true },
      ),
      column.custom(
        "environment",
        (row) => row.settings?.execution_environment,
        t("apps.column.environment"),
        (row) => (row.settings ? environmentLabel(row.settings.execution_environment, t) : MISSING),
        { width: "w-[20%]" },
      ),
      column.custom(
        "users",
        (row) => row.users.count,
        t("apps.column.users"),
        (row) => row.users.count,
        { width: "w-[20%]" },
      ),
      column.custom(
        "readiness",
        (row) => appReadiness(row),
        t("apps.column.readiness"),
        (row, index) => (
          <span title={appFailingSummary(row.failing_checks, t) || undefined}>
            <ReadinessBadge app={row} testId={`apps-list-${index}-readiness`} />
          </span>
        ),
        { width: "w-[30%]" },
      ),
    ];
  })();
  return (
    <div data-testid="apps-section">
      <SectionList
        name="apps"
        help={t("apps.help")}
        resource={t("people.section.apps")}
        query={query}
        emptyLine={t("apps.empty")}
        summary={tn("apps.summary", items.length)}
      >
        <AdminTable
          collectionId="apps-list"
          columns={columns}
          data={items}
          onOpen={(row) => setOpenedId(row.id)}
          rowLabel={(row) => t("apps.openRow", { id: row.id })}
        />
      </SectionList>
      <AppSheet appId={openedId} onClose={() => setOpenedId(null)} />
    </div>
  );
}

function SignInFacts({ provider, index }: { provider: AppSignIn; index: number }) {
  const { t } = useI18n();
  return (
    <FactList
      testId={`apps-sign-in-${index}`}
      items={[
        {
          label: provider.label || provider.id,
          value: (
            <span className="flex flex-col">
              <span>
                {t(
                  provider.protocol === "oidc_bearer"
                    ? "apps.signIn.oidcBearer"
                    : "apps.signIn.oidc",
                )}
              </span>
              <span className="break-all font-mono text-xs text-muted-foreground">
                {provider.id}
              </span>
            </span>
          ),
        },
        {
          label: t("apps.field.issuer"),
          value: <span className="break-all">{provider.issuer_url}</span>,
        },
        ...(provider.audience
          ? [{ label: t("apps.field.audience"), value: provider.audience }]
          : []),
        { label: t("apps.field.tenant"), value: provider.tenant_slug },
        ...(provider.protocol === "oidc_bearer"
          ? [
              {
                label: t("apps.field.claims"),
                value:
                  provider.required_claims.length === 0 ? (
                    <span className="text-muted-foreground">{t("apps.claims.none")}</span>
                  ) : (
                    <ul className="grid gap-0.5">
                      {provider.required_claims.map((claim) => (
                        <li key={claim.path} className="break-all font-mono text-xs">
                          {claim.path} = {JSON.stringify(claim.equals)}
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]
          : []),
        ...(provider.reject_anonymous !== null
          ? [
              {
                label: t("apps.field.anonymous"),
                value: t(
                  provider.reject_anonymous ? "apps.anonymous.rejected" : "apps.anonymous.allowed",
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function AppUsers({ app }: { app: AppView }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canErase =
    session.principal.role_name === "admin" &&
    session.permissions.includes("identity:write") &&
    session.permissions.includes("settings:read");
  const list = usePeopleList(true, app.id);
  const users = list.view.data?.items ?? [];
  const [target, setTarget] = useState<UserItem | null>(null);
  const erase = useMutation({
    mutationFn: (user: UserItem) =>
      apiRequest<unknown>(eraseAppUserPath(app.id, user.id), { method: "DELETE" }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "apps"] }),
        client.invalidateQueries({ queryKey: ["admin", "people"] }),
      ]),
  });
  if (list.view.error)
    return (
      <DataState
        state="error"
        line={t("apps.users.loadFailed")}
        onRetry={() => void list.view.refetch()}
        testId="apps-users-load-failed"
      />
    );
  if (list.view.isPending) return null;
  if (users.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="apps-users-none">
        {t("apps.users.none")}
      </p>
    );
  return (
    <>
      <ul className="grid gap-2" data-testid="apps-users-list">
        {users.map((user, index) => {
          const seen = appUserLastSeen(user, app.id);
          return (
            <li
              key={user.id}
              className="flex items-center justify-between gap-3"
              data-testid={`apps-users-${index}`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="break-words text-sm" data-testid={`apps-users-${index}-name`}>
                  {personNameText(user, t)}
                </span>
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono">{user.id.slice(0, 8)}</span>
                  {" · "}
                  {t("apps.users.lastSeen")}: {seen ? dateTime(seen) : t("apps.users.never")}
                </span>
              </span>
              {canErase ? (
                <ActionMenu
                  size="sm"
                  items={[
                    {
                      label: t("apps.users.erase"),
                      destructive: true,
                      onSelect: () => setTarget(user),
                      testId: `apps-users-${index}-erase`,
                    },
                  ]}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      <InfiniteSentinel infinite={list.infinite} testId="apps-users-more" />
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        object={t("apps.users.erase.object", {
          person: target ? appUserLabel(target, t) : "",
          id: app.id,
        })}
        verb={t("apps.users.erase.verb")}
        consequence={t("apps.users.erase.consequence")}
        destructive
        pending={erase.isPending}
        onConfirm={async () => {
          if (!target) return;
          await erase
            .mutateAsync(target)
            .then(() => {
              setTarget(null);
              toast.success(t("apps.users.erase.done"));
            })
            .catch((error) => refusalToast(error, t));
        }}
        testId="apps-users-erase-confirm"
      />
    </>
  );
}

function AppSheet({ appId, onClose }: { appId: string | null; onClose(): void }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const canWrite = session.permissions.includes("settings:write");
  const canPeople = session.permissions.includes("identity:read");
  const detail = useQuery({
    queryKey: appKey(appId ?? ""),
    queryFn: () => fetchApp(appId ?? ""),
    enabled: appId !== null,
  });
  const app = appId !== null ? detail.data : undefined;
  const settings = useSettingsSnapshot(canWrite && appId !== null);
  const bearer = appId
    ? appBearerProvider(settingValue(settings.data, PROVIDERS_PATH), appId)
    : null;
  const [dialog, setDialog] = useState<"settings" | "signIn" | "remove" | null>(null);
  const remove = useAppSettingsSave();
  const client = useQueryClient();
  const close = () => {
    setDialog(null);
    onClose();
  };
  const menu: ActionMenuItem[] =
    canWrite && app
      ? [
          {
            label: t(app.configured ? "apps.action.editSettings" : "apps.action.configure"),
            onSelect: () => setDialog("settings"),
            testId: "apps-edit-settings",
          },
          {
            label: t(bearer ? "apps.action.editSignIn" : "apps.action.addSignIn"),
            onSelect: () => setDialog("signIn"),
            testId: "apps-edit-sign-in",
          },
          ...(app.configured
            ? [
                {
                  label: t("apps.action.remove"),
                  destructive: true,
                  onSelect: () => setDialog("remove"),
                  testId: "apps-remove",
                },
              ]
            : []),
        ]
      : [];
  const checks = app ? appCheckLines(app.checks, t) : [];
  return (
    <>
      <RecordSheet
        dock
        open={appId !== null}
        onOpenChange={(open) => !open && close()}
        title={<span className="break-all">{appId}</span>}
        badge={app ? <ReadinessBadge app={app} testId="apps-sheet-readiness" /> : null}
        menu={menu.length > 0 ? <ActionMenu items={menu} testId="apps-sheet-menu" /> : null}
        loading={appId !== null && detail.isPending}
        testId="apps-sheet"
        closeTestId="apps-sheet-close"
      >
        {detail.error ? (
          <DataState
            state="error"
            line={t("resource.loadFailed", { resource: t("people.section.apps") })}
            onRetry={() => void detail.refetch()}
            testId="apps-sheet-load-failed"
          />
        ) : null}
        {app ? (
          <>
            <Section label={t("apps.section.settings")} testId="apps-sheet-settings">
              {app.settings ? (
                <FactList
                  testId="apps-sheet-settings-facts"
                  items={[
                    {
                      label: t("apps.field.environment"),
                      value: environmentLabel(app.settings.execution_environment, t),
                    },
                    {
                      label: t("apps.field.assistant"),
                      value: (
                        <Link
                          to={workflowHref(app.settings.assistant_workflow.id)}
                          className="underline-offset-2 hover:underline"
                          data-testid="apps-sheet-assistant"
                        >
                          {app.settings.assistant_workflow.name ??
                            app.settings.assistant_workflow.slug ??
                            app.settings.assistant_workflow.id}
                        </Link>
                      ),
                    },
                    { label: t("apps.field.bucket"), value: app.settings.budget_bucket },
                    {
                      label: t("apps.field.dailyLimit"),
                      value: app.settings.daily_limit
                        ? t("apps.dailyLimit.value", {
                            limit: app.settings.daily_limit.limit_per_caller,
                            tz: app.settings.daily_limit.tz,
                          })
                        : t("apps.budget.none"),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="apps-sheet-settings-none">
                  {t("apps.settings.none")}
                </p>
              )}
            </Section>
            <Section label={t("apps.section.signIn")} testId="apps-sheet-sign-in">
              {app.sign_in.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("apps.signIn.none")}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {app.sign_in.map((provider, index) => (
                    <SignInFacts key={provider.id} provider={provider} index={index} />
                  ))}
                </div>
              )}
            </Section>
            <Section label={t("apps.section.workflows")} testId="apps-sheet-workflows">
              {app.workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("apps.workflows.none")}</p>
              ) : (
                <FactList
                  testId="apps-sheet-workflow-facts"
                  items={app.workflows.map((workflow) => ({
                    testId: `apps-sheet-workflow-${workflow.id}`,
                    label: (
                      <Link
                        to={workflowHref(workflow.id)}
                        className="break-all text-foreground underline-offset-2 hover:underline"
                        data-testid={`apps-sheet-workflow-${workflow.id}-link`}
                      >
                        {workflow.name || workflow.slug}
                      </Link>
                    ),
                    value: (
                      <span className="flex flex-wrap gap-1">
                        <StatusBadge state={workflow.lifecycle} />
                        {workflow.is_assistant ? (
                          <StatusBadge state="assistant" label={t("apps.workflow.assistant")} />
                        ) : null}
                        {workflow.definition_valid ? null : (
                          <StatusBadge state="failed" label={t("apps.workflow.invalid")} />
                        )}
                      </span>
                    ),
                  }))}
                />
              )}
            </Section>
            <Section label={t("apps.section.users")} testId="apps-sheet-users">
              <FactList
                testId="apps-sheet-user-facts"
                items={[
                  { label: t("apps.users.count"), value: app.users.count },
                  {
                    label: t("apps.users.lastSeen"),
                    value: app.users.last_seen_at
                      ? dateTime(app.users.last_seen_at)
                      : t("apps.users.never"),
                  },
                ]}
              />
              {canPeople ? <AppUsers app={app} /> : null}
            </Section>
            <Section label={t("apps.section.budget")} testId="apps-sheet-budget">
              {app.budget_today ? (
                <FactList
                  testId="apps-sheet-budget-facts"
                  items={[
                    { label: t("apps.budget.day"), value: app.budget_today.day },
                    { label: t("apps.budget.consumed"), value: app.budget_today.consumed },
                    { label: t("apps.budget.reserved"), value: app.budget_today.reserved },
                    { label: t("apps.budget.refusals"), value: app.budget_today.refusals_today },
                    {
                      label: t("apps.budget.resets"),
                      value: dateTime(app.budget_today.resets_at),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t("apps.budget.none.detail")}</p>
              )}
            </Section>
            <Section label={t("apps.section.checks")} testId="apps-sheet-checks">
              <FactList
                testId="apps-sheet-check-facts"
                items={checks.map((check) => ({
                  testId: `apps-check-${check.key}`,
                  label: check.label,
                  value: (
                    <span className="flex flex-col gap-1">
                      <span>
                        <StatusBadge state={check.state} />
                      </span>
                      {check.detail ? (
                        <span className="font-normal text-muted-foreground">{check.detail}</span>
                      ) : null}
                      {check.next ? (
                        <span className="font-normal" data-testid={`apps-check-${check.key}-next`}>
                          {t("apps.check.next", { action: check.next })}
                        </span>
                      ) : null}
                    </span>
                  ),
                }))}
              />
            </Section>
          </>
        ) : null}
      </RecordSheet>
      {app ? (
        <>
          <AppSettingsDialog
            app={app}
            open={dialog === "settings"}
            onOpenChange={(open) => !open && setDialog(null)}
          />
          <AppSignInDialog
            app={app}
            open={dialog === "signIn"}
            onOpenChange={(open) => !open && setDialog(null)}
          />
          <ConfirmDialog
            open={dialog === "remove"}
            onOpenChange={(open) => !open && setDialog(null)}
            object={t("apps.remove.object", { id: app.id })}
            verb={t("apps.remove.verb")}
            consequence={t("apps.remove.consequence")}
            destructive
            pending={remove.isPending}
            onConfirm={async () => {
              await remove
                .mutateAsync({ [PRODUCTS_PATH]: (value) => withProduct(value, app.id, null) })
                .then((outcome) => {
                  if (
                    appGoneFromList(
                      client.getQueryData<Envelope<AppSummary>>(["admin", "apps"]),
                      app.id,
                    )
                  )
                    close();
                  else setDialog(null);
                  toast.success(
                    t(outcome === "active" ? "apps.save.removed" : "apps.save.restartRequired"),
                  );
                })
                .catch((error) => toast.error(appSaveError(error, t)));
            }}
            testId="apps-remove-confirm"
          />
        </>
      ) : null}
    </>
  );
}

function AppSettingsDialog({
  app,
  open,
  onOpenChange,
}: {
  app: AppView;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const settings = useSettingsSnapshot(open);
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    enabled: open && session.permissions.includes("workflow:read"),
    queryFn: () => apiRequest<Envelope<RecordItem>>("/v1/workflows?limit=200"),
  });
  const save = useAppSettingsSave();
  const entry = productsFrom(settingValue(settings.data, PRODUCTS_PATH))[app.id] ?? null;
  const [draft, setDraft] = useState<ProductDraft>(() => productDraft(entry, app));
  const [tried, setTried] = useState(false);
  const loaded = Boolean(settings.data);
  useEffect(() => {
    if (!open) return;
    setDraft(productDraft(entry, app));
    setTried(false);
    save.reset();
  }, [open, loaded, app.id]);
  const items = workflows.data?.items ?? [];
  const picked = items.find((item) => item.id === draft.assistant_workflow_id) ?? null;
  const currentDag = useCurrentVersionDag(
    draft.assistant_workflow_id,
    picked?.current_version_id,
    picked?.current_version,
    open && picked !== null && draft.assistant_workflow_id !== app.settings?.assistant_workflow.id,
  );
  const suggestion =
    draft.assistant_workflow_id === app.settings?.assistant_workflow.id
      ? (app.settings?.daily_limit?.bucket ?? null)
      : definitionGuardBucket(currentDag.data);
  useEffect(() => {
    if (suggestion && !draft.budget_bucket.trim())
      setDraft((current) => ({ ...current, budget_bucket: suggestion }));
  }, [suggestion]);
  const options = [
    ...items.map((item) => ({ value: item.id, label: item.name || item.slug || item.id })),
    ...(draft.assistant_workflow_id && !picked
      ? [
          {
            value: draft.assistant_workflow_id,
            label:
              app.settings?.assistant_workflow.name ??
              app.settings?.assistant_workflow.slug ??
              draft.assistant_workflow_id,
          },
        ]
      : []),
  ];
  const errors = productErrors(app.id, draft);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(app.configured ? "apps.action.editSettings" : "apps.action.configure")}
      description={t("apps.dialog.description")}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: !loaded,
        testId: "apps-settings-submit",
      }}
      error={dialogError(tried, errors, save.error, t)}
      onSubmit={() => {
        setTried(true);
        if (errors.length > 0) return;
        save.mutate(
          {
            [PRODUCTS_PATH]: (value) =>
              withProduct(value, app.id, productEntry(productsFrom(value)[app.id] ?? null, draft)),
          },
          {
            onSuccess: (outcome) => {
              onOpenChange(false);
              toast.success(
                t(outcome === "active" ? "apps.save.done" : "apps.save.restartRequired"),
              );
            },
          },
        );
      }}
      testId="apps-settings-dialog"
    >
      <ChoiceField
        label={t("apps.field.environment")}
        value={draft.execution_environment}
        onChange={(value) =>
          setDraft((current) => ({
            ...current,
            execution_environment: value === "prod" ? "prod" : "dev",
          }))
        }
        options={EXECUTION_ENVIRONMENTS.map((value) => ({
          value,
          label: environmentLabel(value, t),
        }))}
        testId="apps-settings-environment"
      />
      <ChoiceField
        label={t("apps.field.assistant")}
        help={t("apps.field.assistantHelp")}
        value={draft.assistant_workflow_id}
        onChange={(value) => setDraft((current) => ({ ...current, assistant_workflow_id: value }))}
        placeholder={t("apps.chooseWorkflow")}
        options={options}
        testId="apps-settings-assistant"
        byIndex
      />
      <Field>
        <FieldLabel htmlFor="apps-settings-bucket">{t("apps.field.bucket")}</FieldLabel>
        <Input
          id="apps-settings-bucket"
          value={draft.budget_bucket}
          maxLength={64}
          onChange={(event) =>
            setDraft((current) => ({ ...current, budget_bucket: event.target.value }))
          }
          data-testid="apps-settings-bucket"
        />
        {suggestion && suggestion !== draft.budget_bucket.trim() ? (
          <FieldDescription className="flex flex-wrap items-center gap-2">
            {t("apps.field.bucketSuggested", { bucket: suggestion })}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setDraft((current) => ({ ...current, budget_bucket: suggestion }))}
              data-testid="apps-settings-bucket-suggestion"
            >
              {t("apps.field.bucketUse")}
            </Button>
          </FieldDescription>
        ) : null}
      </Field>
    </FormDialog>
  );
}

function AppSignInDialog({
  app,
  open,
  onOpenChange,
}: {
  app: AppView;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const settings = useSettingsSnapshot(open);
  const save = useAppSettingsSave();
  const providers = settingValue(settings.data, PROVIDERS_PATH);
  const provider = appBearerProvider(providers, app.id);
  const [draft, setDraft] = useState<SignInDraft>(() => signInDraft(provider, app.id));
  const [tried, setTried] = useState(false);
  const loaded = Boolean(settings.data);
  useEffect(() => {
    if (!open) return;
    setDraft(signInDraft(provider, app.id));
    setTried(false);
    save.reset();
  }, [open, loaded, app.id]);
  const errors = signInErrors(
    app.id,
    draft,
    providers,
    typeof provider?.id === "string" ? provider.id : null,
  );
  const set = (patch: Partial<SignInDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setClaim = (index: number, patch: Partial<ClaimDraft>) =>
    set({
      required_claims: draft.required_claims.map((claim, position) =>
        position === index ? { ...claim, ...patch } : claim,
      ),
    });
  const text = (key: SignInTextField, label: string, testId: string) => (
    <Field>
      <FieldLabel htmlFor={testId}>{label}</FieldLabel>
      <Input
        id={testId}
        value={draft[key]}
        onChange={(event) => set({ [key]: event.target.value })}
        data-testid={testId}
      />
    </Field>
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={t(provider ? "apps.action.editSignIn" : "apps.action.addSignIn")}
      description={t("apps.dialog.description")}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: !loaded,
        testId: "apps-sign-in-submit",
      }}
      error={dialogError(tried, errors, save.error, t)}
      onSubmit={() => {
        setTried(true);
        if (errors.length > 0) return;
        save.mutate(
          {
            [PROVIDERS_PATH]: (value) => {
              const current = appBearerProvider(value, app.id);
              const id = typeof current?.id === "string" ? current.id : null;
              return withProvider(value, id, signInProvider(current, draft, app.id));
            },
          },
          {
            onSuccess: (outcome) => {
              onOpenChange(false);
              toast.success(
                t(outcome === "active" ? "apps.save.signInDone" : "apps.save.restartRequired"),
              );
            },
          },
        );
      }}
      testId="apps-sign-in-dialog"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text("id", t("apps.field.signInId"), "apps-sign-in-id")}
        {text("label", t("apps.field.signInLabel"), "apps-sign-in-label")}
      </div>
      {text("issuer_url", t("apps.field.issuer"), "apps-sign-in-issuer")}
      {text("jwks_uri", t("apps.field.jwks"), "apps-sign-in-jwks")}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("audience", t("apps.field.audience"), "apps-sign-in-audience")}
        {text("tenant_slug", t("apps.field.tenant"), "apps-sign-in-tenant")}
      </div>
      <Field>
        <FieldLabel>{t("apps.field.algorithms")}</FieldLabel>
        <div
          className="grid grid-cols-2 gap-x-3 sm:grid-cols-4"
          data-testid="apps-sign-in-algorithms"
        >
          {SIGN_IN_ALGORITHMS.map((algorithm) => (
            <label
              key={algorithm}
              className="flex min-h-10 items-center gap-3 text-sm"
              htmlFor={`apps-sign-in-algorithm-${algorithm}`}
            >
              <Checkbox
                id={`apps-sign-in-algorithm-${algorithm}`}
                checked={draft.algorithms.includes(algorithm)}
                onCheckedChange={(value) =>
                  set({
                    algorithms:
                      value === true
                        ? [...draft.algorithms, algorithm]
                        : draft.algorithms.filter((item) => item !== algorithm),
                  })
                }
                data-testid={`apps-sign-in-algorithm-${algorithm}`}
              />
              {algorithm}
            </label>
          ))}
        </div>
      </Field>
      <label className="flex min-h-10 items-center gap-3 text-sm" htmlFor="apps-sign-in-anonymous">
        <Switch
          id="apps-sign-in-anonymous"
          checked={draft.reject_anonymous}
          onCheckedChange={(checked) => set({ reject_anonymous: checked })}
          data-testid="apps-sign-in-anonymous"
        />
        {t("apps.field.anonymous")}:{" "}
        {t(draft.reject_anonymous ? "apps.anonymous.rejected" : "apps.anonymous.allowed")}
      </label>
      <Field>
        <FieldLabel>{t("apps.field.claims")}</FieldLabel>
        <div className="flex flex-col gap-2" data-testid="apps-sign-in-claims">
          {draft.required_claims.length === 0 ? (
            <FieldDescription>{t("apps.claims.none")}</FieldDescription>
          ) : null}
          {draft.required_claims.map((claim, index) => (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]"
              data-testid={`apps-sign-in-claim-${index}`}
            >
              <Input
                value={claim.path}
                aria-label={t("apps.field.claimPath")}
                placeholder={t("apps.field.claimPath")}
                onChange={(event) => setClaim(index, { path: event.target.value })}
                data-testid={`apps-sign-in-claim-${index}-path`}
              />
              <Select
                value={claim.type}
                onValueChange={(value) =>
                  setClaim(index, {
                    type: value as ClaimType,
                    value:
                      value === "boolean" ? "true" : claim.type === "boolean" ? "" : claim.value,
                  })
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("apps.field.claimType")}
                  data-testid={`apps-sign-in-claim-${index}-type`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CLAIM_TYPES.map((type) => (
                      <SelectItem
                        key={type}
                        value={type}
                        data-testid={`apps-sign-in-claim-${index}-type-${type}`}
                      >
                        {t(CLAIM_TYPE_LABEL[type])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {claim.type === "boolean" ? (
                <Select value={claim.value} onValueChange={(value) => setClaim(index, { value })}>
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("apps.field.claimValue")}
                    data-testid={`apps-sign-in-claim-${index}-value`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="true" data-testid={`apps-sign-in-claim-${index}-true`}>
                        true
                      </SelectItem>
                      <SelectItem value="false" data-testid={`apps-sign-in-claim-${index}-false`}>
                        false
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={claim.value}
                  inputMode={claim.type === "number" ? "decimal" : undefined}
                  aria-label={t("apps.field.claimValue")}
                  placeholder={t("apps.field.claimValue")}
                  onChange={(event) => setClaim(index, { value: event.target.value })}
                  data-testid={`apps-sign-in-claim-${index}-value`}
                />
              )}
              <IconButton
                type="button"
                label={t("apps.claim.remove")}
                onClick={() =>
                  set({
                    required_claims: draft.required_claims.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
                data-testid={`apps-sign-in-claim-${index}-remove`}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                set({
                  required_claims: [
                    ...draft.required_claims,
                    { path: "", type: "string", value: "" },
                  ],
                })
              }
              data-testid="apps-sign-in-claim-add"
            >
              <Plus aria-hidden="true" />
              {t("apps.claim.add")}
            </Button>
          </div>
        </div>
      </Field>
    </FormDialog>
  );
}

type SignInTextField = "id" | "label" | "issuer_url" | "jwks_uri" | "audience" | "tenant_slug";

const CLAIM_TYPES: readonly ClaimType[] = ["string", "boolean", "number"];
const CLAIM_TYPE_LABEL: Readonly<Record<ClaimType, TranslationKey>> = {
  string: "apps.claimType.string",
  boolean: "apps.claimType.boolean",
  number: "apps.claimType.number",
};

const SECTION_LABEL: Record<PeopleSection, TranslationKey> = {
  people: "people.section.people",
  roles: "access.roles",
  groups: "access.groups",
  grants: "access.grants",
  apps: "people.section.apps",
};

const SECTION_ACTION: Partial<
  Record<PeopleSection, { label: TranslationKey; permission: string; testId: string }>
> = {
  people: { label: "people.create", permission: "identity:write", testId: "people-create" },
  roles: { label: "access.createRole", permission: "rbac:write", testId: "role-create" },
  groups: { label: "access.createGroup", permission: "rbac:write", testId: "group-create" },
  grants: { label: "access.createGrant", permission: "rbac:write", testId: "grant-create" },
};
export function PeopleAndAccessPage() {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => session.permissions.includes(permission);
  const canIdentity = can("identity:read");
  const canRbac = can("rbac:read");
  const canSettings = can("settings:read");
  const readable = useMemo(
    () => readablePeopleSections({ identity: canIdentity, rbac: canRbac, settings: canSettings }),
    [canIdentity, canRbac, canSettings],
  );
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const section = openPeopleSection(peopleSectionFromUrl(searchStr), readable);
  const [creating, setCreating] = useState<PeopleSection | null>(null);
  const empty = (data: Envelope<unknown>) => data.items.length === 0;
  const views: Record<PeopleSection, ReturnType<typeof queryView>> = {
    people: queryView(
      usePeopleList(canIdentity && section === "people", peopleAppFromUrl(searchStr)).view,
      empty,
    ),
    roles: queryView(useRoles(canRbac && section === "roles"), empty),
    groups: queryView(useGroups(canRbac && section === "groups"), empty),
    grants: queryView(useGrants(canRbac && section === "grants"), empty),
    apps: queryView(useApps(canSettings && section === "apps"), empty),
  };
  const actionFor = (value: PeopleSection) => {
    const spec = SECTION_ACTION[value];
    if (!spec || !can(spec.permission)) return null;
    return (
      <Button onClick={() => setCreating(value)} data-testid={spec.testId}>
        {t(spec.label)}
      </Button>
    );
  };
  const headerAction = section && views[section] === "ready" ? actionFor(section) : null;
  const content = (value: PeopleSection) => {
    const action = actionFor(value);
    if (value === "people") return <PeopleTab action={action} />;
    if (value === "roles") return <RolesTab action={action} />;
    if (value === "groups") return <GroupsTab action={action} />;
    if (value === "apps") return <AppsTab />;
    return <GrantsTab action={action} />;
  };
  return (
    <Page
      kind="list"
      scroll="page"
      testId="admin-people"
      header={<PageHeader title={t("resource.people.title")} action={headerAction} />}
    >
      {section === null ? (
        <ForbiddenState />
      ) : (
        <PageTabs
          param="section"
          testId="people-tabs"
          defaultValue={readable[0]}
          tabs={readable.map((value) => ({
            value,
            label: t(SECTION_LABEL[value]),
            testId: `people-tab-${value}`,
            content: content(value),
          }))}
        />
      )}
      <InvitePersonDialog
        open={creating === "people"}
        onOpenChange={(open) => !open && setCreating(null)}
      />
      <CreateRecordDialog
        kind={creating === "roles" ? "role" : creating === "groups" ? "group" : null}
        onOpenChange={(open) => !open && setCreating(null)}
      />
      <GrantAccessDialog
        open={creating === "grants"}
        onOpenChange={(open) => !open && setCreating(null)}
      />
    </Page>
  );
}
