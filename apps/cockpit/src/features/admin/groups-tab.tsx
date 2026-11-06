import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import {
  ActionMenu,
  type CockpitColumn,
  FactList,
  FormDialog,
  RecordSheet,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { assignableRoles, roleName } from "@/pages/admin-model";
import { personEmailText } from "@/pages/apps-model";
import { type GroupItem, refusalToast, useGroups, usePeople, useRoles } from "./data";
import { AdminTable, ChoiceField, SectionList } from "./parts";

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
      apiCall("post", "/v1/rbac/groups/{id}/members/{user_id}", {
        path: { id: group?.id ?? "", user_id: userId },
      }),
    onSuccess: async () => {
      closeDialog();
      await client.invalidateQueries({ queryKey: ["admin"] });
      toast.success(t("access.memberAdded"));
    },
    onError: (error) => refusalToast(error, t),
  });
  const assignRole = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/rbac/groups/{id}/roles/{role_id}", {
        path: { id: group?.id ?? "", role_id: roleId },
      }),
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

export function GroupsTab({ action }: { action: ReactNode }) {
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
