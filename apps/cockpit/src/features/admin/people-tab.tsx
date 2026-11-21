import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { PEOPLE_APP_PARAM, peopleAppFromUrl } from "@/app/links";
import { useSession } from "@/app/session";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  CopyField,
  Field,
  FieldError,
  FieldLabel,
  FilterBar,
  FormDialog,
  Input,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";
import { presentRoles, refusalToast, type UserItem, usePeopleList, useRoles } from "./data";
import { isPersonRole, PERSON_ROLES, type PersonRole, roleName } from "./model/admin-model";
import { personApps, personEmailText, personNameText } from "./model/apps-model";
import { inviteLink, joinCommand } from "./model/invite-model";
import type { IssuedInvite } from "./model/invite-send-model";
import { AdminTable, ChoiceField, SectionList } from "./parts";
import { PersonSheet } from "./person-sheet";
import { useInviteSend } from "./use-invite-send";

export function PeopleTab({ action }: { action: ReactNode }) {
  const { t, tn, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const router = useRouter();
  const canInvite = session.permissions.includes("identity:write");
  const [withdrawing, setWithdrawing] = useState<UserItem | null>(null);
  const invite = useInviteSend();
  const withdraw = useMutation({
    mutationFn: (user: UserItem) =>
      apiCall("delete", "/v1/identity/users/{id}", { path: { id: user.id } }),
    onSuccess: async () => {
      setWithdrawing(null);
      await client.invalidateQueries({ queryKey: ["admin"] });
      toast.success(t("people.invite.withdrawn"));
    },
    onError: (error) => refusalToast(error, t),
  });
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
  const roleOptions = presentRoles(items);
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
        { width: "w-[40%]" },
      ),
      column.custom(
        "role",
        (row) => row.role,
        t("people.role"),
        (row, index) => (
          <span
            className="block truncate"
            title={row.role ? roleName(row.role, roleItems, t).text : undefined}
            data-testid={`people-role-badge-${index}`}
          >
            {row.role ? <LabelText label={roleName(row.role, roleItems, t)} /> : null}
          </span>
        ),
        { width: "w-[28%]" },
      ),
      column.custom(
        "status",
        (row) => row.status,
        t("resource.field.status"),
        (row) => <StatusBadge state={row.status} />,
        { width: "w-[32%]" },
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
          grouping={
            groupMode === "all"
              ? undefined
              : {
                  getKey: (row) =>
                    groupMode === "role"
                      ? roleName(row.role ?? "", roleItems, t).text
                      : statusLabel(t, row.status),
                }
          }
          infinite={people.infinite}
          onOpen={(row) => setOpenedId(row.id)}
          rowActionsFit="menu"
          rowActions={
            canInvite
              ? (row, index) =>
                  row.status === "invited" && row.id !== session.principal.id ? (
                    <ActionMenu
                      alwaysMenu
                      size="sm"
                      label={t("people.openRow", {
                        email: personEmailText(row, t),
                        role: roleName(row.role ?? "", roleItems, t).text,
                      })}
                      testId={`people-row-menu-${index}`}
                      items={[
                        {
                          label: t("people.invite.send"),
                          onSelect: () => invite.send(row.id, personEmailText(row, t)),
                          disabled: invite.pending,
                          testId: `people-invite-send-${index}`,
                        },
                        {
                          label: t("people.invite.withdraw"),
                          onSelect: () => setWithdrawing(row),
                          destructive: true,
                          testId: `people-invite-withdraw-${index}`,
                        },
                      ]}
                    />
                  ) : null
              : undefined
          }
          rowLabel={(row) =>
            t("people.openRow", {
              email: personEmailText(row, t),
              role: roleName(row.role ?? "", roleItems, t).text,
            })
          }
          filtered={Boolean(needle) || roleFilter !== "all" || appFilter !== null}
          onReset={() => {
            setSearch("");
            setRoleFilter("all");
            chooseApp("all");
          }}
          toolbar={
            <>
              <FilterBar
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: t("people.search"),
                  testId: "people-search",
                }}
                reset={{
                  label: t("catalog.clearFilters"),
                  onClick: () => {
                    setRoleFilter("all");
                    setGroupMode("all");
                    chooseApp("all");
                  },
                }}
                selects={[
                  {
                    value: roleFilter,
                    defaultValue: "all",
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
                          defaultValue: "all",
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
                  {
                    value: groupMode,
                    defaultValue: "all",
                    onChange: setGroupMode,
                    label: t("common.groupBy"),
                    testId: "people-grouping",
                    options: [
                      { value: "all", label: t("common.all") },
                      { value: "role", label: t("people.role") },
                      { value: "status", label: t("resource.field.status") },
                    ],
                  },
                ]}
              />
              {action ? <span className="ms-auto">{action}</span> : null}
            </>
          }
        />
      </SectionList>
      <PersonSheet user={opened} roles={roleItems} onClose={() => setOpenedId(null)} />
      <InviteLinkDialog invite={invite.link} onClose={invite.closeLink} />
      <ConfirmDialog
        open={withdrawing !== null}
        onOpenChange={(open) => !open && setWithdrawing(null)}
        object={t("people.invite.withdrawObject", {
          email: withdrawing ? personEmailText(withdrawing, t) : "",
        })}
        verb={t("people.invite.withdrawVerb")}
        consequence={t("people.invite.withdrawConsequence")}
        destructive
        pending={withdraw.isPending}
        onConfirm={async () => {
          if (withdrawing) await withdraw.mutateAsync(withdrawing).catch(() => {});
        }}
        testId="people-invite-withdraw-confirm"
      />
    </>
  );
}

export function InviteLinkBody({
  invite,
  origin,
  selfHosted,
}: {
  invite: IssuedInvite;
  origin: string;
  selfHosted: boolean;
}) {
  const { t, dateTime } = useI18n();
  return (
    <>
      <p className="text-sm" data-testid="people-invite-link-body">
        {t(invite.note ?? "people.invite.link.body", { email: invite.email })}
      </p>
      <CopyField
        value={invite.url ?? inviteLink(origin, invite.token)}
        label={t("people.invite.link.title")}
        testId="people-invite-link"
      />
      <p className="text-xs text-muted-foreground" data-testid="people-invite-link-meta">
        {t("people.invite.link.meta", { time: dateTime(invite.expiresAt) })}
      </p>
      {selfHosted ? (
        <CollapsibleSection label={t("people.invite.link.cli")} testId="people-invite-cli">
          <CopyField
            value={joinCommand(origin, invite.token)}
            label={t("invite.cli.command")}
            testId="people-invite-command"
          />
        </CollapsibleSection>
      ) : null}
    </>
  );
}

export function InviteLinkDialog({
  invite,
  onClose,
}: {
  invite: IssuedInvite | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  const session = useSession();
  return (
    <FormDialog
      open={invite !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("people.invite.link.title")}
      submit={{ label: t("common.done") }}
      onSubmit={onClose}
      cancel={false}
      testId="people-invite-link-dialog"
    >
      {invite ? (
        <InviteLinkBody
          invite={invite}
          origin={window.location.origin}
          selfHosted={session.tenant.origin === "self_hosted"}
        />
      ) : null}
    </FormDialog>
  );
}

export function validInviteEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function InvitePersonDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const session = useSession();
  const roles = useRoles(open && session.permissions.includes("rbac:read"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PersonRole>("member");
  const [displayName, setDisplayName] = useState("");
  const [checked, setChecked] = useState(false);
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  useEffect(() => {
    if (!open) return;
    setEmail("");
    setDisplayName("");
    setRole("member");
    setChecked(false);
    setIssued(null);
  }, [open]);
  const create = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/identity/users", {
        body: {
          email: email.trim(),
          role,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          invite: {},
        },
      }),
    onSuccess: (result) => {
      if (!result.invite) return onOpenChange(false);
      setIssued({
        email: email.trim(),
        token: result.invite.plaintext_token,
        expiresAt: result.invite.expires_at,
      });
    },
    onError: (error) => refusalToast(error, t),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin"] }),
  });
  const emailError = checked && !validInviteEmail(email);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(issued ? "people.invite.link.title" : "people.create")}
      step={issued ? "link" : "person"}
      submit={
        issued
          ? { label: t("common.done") }
          : { label: t("people.createSubmit"), pending: create.isPending }
      }
      onSubmit={() => {
        if (issued) return onOpenChange(false);
        setChecked(true);
        if (validInviteEmail(email)) create.mutate();
      }}
      cancel={!issued}
      testId="people-create-dialog"
    >
      {issued ? (
        <InviteLinkBody
          invite={issued}
          origin={window.location.origin}
          selfHosted={session.tenant.origin === "self_hosted"}
        />
      ) : (
        <>
          <Field data-invalid={emailError ? true : undefined}>
            <FieldLabel htmlFor="people-email">{t("people.email")}</FieldLabel>
            <Input
              id="people-email"
              type="email"
              value={email}
              aria-invalid={emailError || undefined}
              aria-describedby={emailError ? "people-email-error" : undefined}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="people-create-email"
            />
            {emailError ? (
              <FieldError id="people-email-error" data-testid="people-create-email-error">
                {t("people.invite.emailError")}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="people-display-name-create" className="gap-1">
              {t("people.invite.name")}{" "}
              <span className="font-normal text-muted-foreground">({t("input.optional")})</span>
            </FieldLabel>
            <Input
              id="people-display-name-create"
              value={displayName}
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              data-testid="people-create-display-name"
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
          <InviteRoleLines roles={roles.data?.items} />
        </>
      )}
    </FormDialog>
  );
}

export function InviteRoleLines({ roles }: { roles: Parameters<typeof roleName>[1] }) {
  const { t } = useI18n();
  return (
    <ul className="grid gap-1 text-xs text-muted-foreground" data-testid="people-create-role-lines">
      {PERSON_ROLES.map((name) => (
        <li key={name}>
          <span className="font-medium text-foreground">{roleName(name, roles, t).text}</span>
          {" – "}
          {t(`people.invite.role.${name}`)}
        </li>
      ))}
    </ul>
  );
}
