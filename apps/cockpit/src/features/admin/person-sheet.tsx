import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { peopleHref } from "@/app/links";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  ConfirmDialog,
  DataState,
  FactList,
  Input,
  RecordSheet,
  SaveBar,
  Section,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import {
  assignableRoles,
  isPersonRole,
  membershipNames,
  PERSON_ROLES,
  roleName,
} from "@/pages/admin-model";
import { personApps, personEmailText, personNameText } from "@/pages/apps-model";
import {
  builtinRoleDescription,
  INVITE_TTL_HOURS,
  personEmailFact,
  type RoleItem,
  refusalToast,
  type UserItem,
  useGrants,
  useRoleDetail,
} from "./data";
import { PermissionGroups, RoleChangeConsequence, SecretDialog } from "./parts";

export function PersonSheet({
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
