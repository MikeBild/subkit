import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { PEOPLE_APP_PARAM, peopleAppFromUrl } from "@/app/links";
import { useSession } from "@/app/session";
import {
  Button,
  type CockpitColumn,
  Field,
  FieldLabel,
  FilterBar,
  FormDialog,
  GroupingTabs,
  Input,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";
import { isPersonRole, PERSON_ROLES, type PersonRole, roleName } from "@/pages/admin-model";
import { personApps, personEmailText, personNameText } from "@/pages/apps-model";
import { INVITE_TTL_HOURS, refusalToast, type UserItem, usePeopleList, useRoles } from "./data";
import { AdminTable, ChoiceField, SecretDialog, SectionList } from "./parts";
import { PersonSheet } from "./person-sheet";

export function PeopleTab({ action }: { action: ReactNode }) {
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
  const [groupMode, setGroupMode] = useState("all");
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
          groupingTabs={
            <GroupingTabs
              label={t("common.groupBy")}
              value={groupMode}
              onChange={setGroupMode}
              options={[
                { value: "all", label: t("common.all") },
                { value: "role", label: t("people.role") },
                { value: "status", label: t("resource.field.status") },
              ]}
              testId="people-grouping"
              note={groupMode === "all" ? undefined : t("common.loadedOnly")}
            />
          }
          grouping={
            groupMode === "all"
              ? undefined
              : {
                  getKey: (row) =>
                    groupMode === "role"
                      ? roleName(row.role, roleItems, t).text
                      : statusLabel(t, row.status),
                }
          }
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

export function InvitePersonDialog({
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
