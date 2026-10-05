import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { type PeopleSection, peopleHref, peopleSectionFromUrl } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  Checkbox,
  type CockpitColumn,
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
  Textarea,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { queryView } from "@/components/failure-state";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { useInfiniteList } from "@/lib/use-infinite-list";
import {
  assignableRoles,
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

type Envelope<T> = { items: T[] };
type Translate = ReturnType<typeof useI18n>["t"];
const INVITE_TTL_HOURS = 24;

interface UserItem {
  id: string;
  email: string;
  role: string;
  status: string;
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

interface RecordItem {
  id: string;
  name?: string | null;
  slug?: string | null;
  display_name?: string | null;
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
function usePeopleList(enabled = true) {
  const list = useInfiniteList<UserItem>(
    "/v1/identity/users",
    {},
    { enabled, queryKey: ["admin", "people", "list"] },
  );
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
  children,
}: {
  name: string;
  resource: string;
  query: Parameters<typeof queryView<Envelope<T>>>[0] & { refetch(): unknown };
  emptyLine: string;
  emptyAction?: ReactNode;
  summary?: ReactNode;
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
      <SummaryLine text={summary} testId={`${name}-summary`} />
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
      <CopyField value={secret ?? ""} label={t("people.inviteCode")} testId="secret-value" />
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
      <p>{t("people.change.intro", { email: user.email, role: toName })}</p>
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
  const [confirm, setConfirm] = useState<"deactivate" | "invite" | "revokeGrants" | null>(null);
  const grants = useGrants(canReadGrants);
  const ownGrants = (grants.data?.items ?? []).filter(
    (grant) => user && grant.subject_type === "user" && grant.subject_id === user.id,
  );
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const role = user ? (roles?.find((item) => item.name === user.role) ?? null) : null;
  const detail = useRoleDetail(role);
  const choices = useMemo(() => {
    const all = assignableRoles(roles ?? []);
    const offered = canAssignCustom ? all : all.filter((item) => isPersonRole(item.name));
    const names = offered.length > 0 ? offered.map((item) => item.name) : [...PERSON_ROLES];
    return user && !names.includes(user.role) ? [user.role, ...names] : names;
  }, [roles, canAssignCustom, user]);
  const refresh = () => client.invalidateQueries({ queryKey: ["admin", "people"] });
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

  const label = user ? roleName(user.role, roles, t) : null;
  const purpose = user ? builtinRoleDescription(user.role, role?.description ?? null, t) : null;
  const changed = user && picked && picked !== user.role ? picked : null;
  useDirtyGuard(Boolean(changed));
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

  return (
    <>
      <RecordSheet
        open={Boolean(user)}
        onOpenChange={(open) => !open && close()}
        title={<span className="break-all">{user?.email}</span>}
        badge={user ? <StatusBadge state={user.status} /> : null}
        menu={menu.length > 0 ? <ActionMenu items={menu} testId="people-sheet-menu" /> : null}
        testId="people-sheet"
        closeTestId="people-sheet-close"
      >
        {user ? (
          <FactList
            testId="people-sheet-facts"
            items={[
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
        <Section label={t("people.sheet.permissions")} testId="people-sheet-permissions-section">
          {!role ? (
            <p className="text-sm text-muted-foreground" data-testid="people-sheet-unreadable">
              {t("people.sheet.unreadable")}
            </p>
          ) : Array.isArray(detail.data?.permissions) ? (
            detail.data.permissions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("people.sheet.none")}</p>
            ) : (
              <PermissionList
                permissions={[...detail.data.permissions].sort()}
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
        object={user?.email ?? ""}
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
        object={t("people.grantsObject", { email: user?.email ?? "" })}
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
        object={t("people.inviteObject", { email: user?.email ?? "" })}
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
  const people = usePeopleList();
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
      (!needle || item.email.toLowerCase().includes(needle)),
  );
  const roleOptions = [...new Set(items.map((item) => item.role))];
  const columns = useMemo<CockpitColumn<UserItem>[]>(() => {
    const column = tableColumns<UserItem>({ t, dateTime });
    return [
      column.custom(
        "email",
        (row) => row.email,
        t("people.email"),
        (row, index) => (
          <span className="block truncate" data-testid={`people-name-${index}`}>
            {row.email}
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
        emptyLine={t("resource.people.empty")}
        emptyAction={action}
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
              email: row.email,
              role: roleName(row.role, roleItems, t).text,
            })
          }
          filtered={Boolean(needle) || roleFilter !== "all"}
          onReset={() => {
            setSearch("");
            setRoleFilter("all");
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
  const roles = useRoles(session.permissions.includes("rbac:read"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PersonRole>("member");
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const user = await apiRequest<UserItem>("/v1/identity/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      return apiRequest<{ plaintext_token: string; expires_at: string }>(
        `/v1/identity/users/${encodeURIComponent(user.id)}/invites`,
        { method: "POST", body: JSON.stringify({ ttl_minutes: INVITE_TTL_HOURS * 60 }) },
      );
    },
    onSuccess: async (result) => {
      onOpenChange(false);
      setEmail("");
      setInvite({ token: result.plaintext_token, expiresAt: result.expires_at });
      toast.success(t("people.created"));
    },
    onError: (error) => refusalToast(error, t),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin", "people"] }),
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
        t("common.name"),
        (row, index) => (
          <span className="block truncate" data-testid={`roles-list-${index}-name`}>
            <LabelText label={roleName(row.name, items, t)} />
          </span>
        ),
        { width: "w-[30%]" },
      ),
      column.custom(
        "description",
        (row) => row.description,
        t("common.description"),
        (row) => (
          <span className="line-clamp-2 text-muted-foreground">
            {builtinRoleDescription(row.name, row.description, t) ?? "—"}
          </span>
        ),
        { width: "w-[50%]" },
      ),
      column.custom(
        "kind",
        (row) => row.is_builtin,
        t("access.kind"),
        (row) => t(row.is_builtin ? "access.builtin" : "access.custom"),
        { width: "w-[20%]" },
      ),
    ];
  }, [t, dateTime, items]);
  return (
    <div data-testid="roles-section">
      <SectionList
        name="roles"
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
  const canWrite = session.permissions.includes("rbac:write");
  const people = usePeople(canWrite && session.permissions.includes("identity:read"));
  const roles = useRoles();
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
    onSuccess: () => {
      closeDialog();
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
    onSuccess: () => {
      closeDialog();
      toast.success(t("access.groupRoleAssigned"));
    },
    onError: (error) => refusalToast(error, t),
  });
  return (
    <>
      <RecordSheet
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
                  {t("access.membersNotListed")}
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
            label: person.email,
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
      column.text("name", (row) => row.name, t("common.name"), { width: "w-[40%]" }),
      column.custom(
        "description",
        (row) => row.description,
        t("common.description"),
        (row) => (
          <span className="line-clamp-2 text-muted-foreground">{row.description || "—"}</span>
        ),
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

function useGrantNames() {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => session.permissions.includes(permission);
  const people = usePeople(can("identity:read"));
  const groups = useGroups();
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
        people.data?.items.find((item) => item.id === grant.subject_id)?.email ?? t("access.person")
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
        (row) =>
          row.expires_at
            ? t("access.grantExpires", { time: dateTime(row.expires_at) })
            : t("access.grantNoExpiry"),
        { width: "w-[25%]" },
      ),
    ];
  })();
  return (
    <div data-testid="grants-section">
      <SectionList
        name="grants"
        resource={t("access.grants")}
        query={query}
        emptyLine={t("access.noGrants")}
        emptyAction={action}
        summary={t(items.length === 1 ? "access.grantsSummary.one" : "access.grantsSummary", {
          count: items.length,
        })}
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
  const names = useGrantNames();
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
          ...names.people.map((item) => ({ value: `user:${item.id}`, label: item.email })),
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
      toast.success(t("access.created"));
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

const SECTION_LABEL: Record<PeopleSection, TranslationKey> = {
  people: "people.section.people",
  roles: "access.roles",
  groups: "access.groups",
  grants: "access.grants",
};

const SECTION_ACTION: Record<
  PeopleSection,
  { label: TranslationKey; permission: string; testId: string }
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
  const readable = useMemo(
    () => readablePeopleSections({ identity: canIdentity, rbac: canRbac }),
    [canIdentity, canRbac],
  );
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const section = openPeopleSection(peopleSectionFromUrl(searchStr), readable);
  const [creating, setCreating] = useState<PeopleSection | null>(null);
  const empty = (data: Envelope<unknown>) => data.items.length === 0;
  const views: Record<PeopleSection, ReturnType<typeof queryView>> = {
    people: queryView(usePeopleList(canIdentity).view, empty),
    roles: queryView(useRoles(canRbac), empty),
    groups: queryView(useGroups(canRbac), empty),
    grants: queryView(useGrants(canRbac), empty),
  };
  const actionFor = (value: PeopleSection) => {
    const spec = SECTION_ACTION[value];
    if (!can(spec.permission)) return null;
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
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
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
