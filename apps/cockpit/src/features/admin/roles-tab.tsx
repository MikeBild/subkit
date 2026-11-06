import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import {
  Checkbox,
  type CockpitColumn,
  DataState,
  FactList,
  Field,
  FieldLabel,
  FormDialog,
  Input,
  RecordSheet,
  Section,
  Textarea,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { permissionLabel, roleName } from "@/pages/admin-model";
import {
  builtinRoleDescription,
  type RoleItem,
  refusalToast,
  useRoleDetail,
  useRoles,
} from "./data";
import { AdminTable, PermissionList, SectionList } from "./parts";

function RoleSheet({ role, onClose }: { role: RoleItem | null; onClose(): void }) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const roles = useRoles();
  const detail = useRoleDetail(role);
  const editable = Boolean(role && !role.is_builtin && session.permissions.includes("rbac:write"));
  const permissions = useQuery({
    queryKey: ["admin", "permissions"],
    queryFn: () => apiCall("get", "/v1/rbac/permissions", {}),
    enabled: editable,
  });
  const change = useMutation({
    mutationFn: ({ permission, enabled }: { permission: string; enabled: boolean }) =>
      enabled
        ? apiCall("post", "/v1/rbac/roles/{id}/permissions", {
            path: { id: role?.id ?? "" },
            body: { permission },
          })
        : apiCall("delete", "/v1/rbac/roles/{id}/permissions/{permission}", {
            path: { id: role?.id ?? "", permission },
          }),
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

export function RolesTab({ action }: { action: ReactNode }) {
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

export function CreateRecordDialog({
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
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      if (kind === "role") return await apiCall("post", "/v1/rbac/roles", { body });
      return await apiCall("post", "/v1/rbac/groups", { body });
    },
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
