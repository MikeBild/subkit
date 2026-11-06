import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useSession } from "@/app/session";
import {
  ActionMenu,
  type CockpitColumn,
  ConfirmDialog,
  ContextHelp,
  FactList,
  Field,
  FieldLabel,
  FormDialog,
  RecordSheet,
  RowName,
  SegmentedControl,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import {
  type GrantResourceType,
  grantStatus,
  isGrantResourceType,
  permissionLabel,
  resourceTypeLabel,
} from "@/pages/admin-model";
import { personEmailText } from "@/pages/apps-model";
import {
  type GrantItem,
  type RecordItem,
  refusalToast,
  useGrants,
  useGroups,
  usePeople,
} from "./data";
import { AdminTable, ChoiceField, SectionList } from "./parts";

function useGrantNames(enabled = true) {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => enabled && session.permissions.includes(permission);
  const people = usePeople(can("identity:read"));
  const groups = useGroups(enabled);
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    enabled: can("workflow:read"),
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: 200 } }),
  });
  const connectors = useQuery({
    queryKey: ["admin", "connectors"],
    enabled: can("connector:read"),
    queryFn: () => apiCall("get", "/v1/connectors", { query: { limit: 200 } }),
  });
  const records = (type: GrantResourceType): readonly RecordItem[] =>
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
    mutationFn: (id: string) => apiCall("delete", "/v1/rbac/grants/{id}", { path: { id } }),
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

export function GrantsTab({ action }: { action: ReactNode }) {
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

function grantSubjectOf(
  value: string,
): { subject_type: "user" | "group"; subject_id: string } | null {
  const [type, id] = value.split(":");
  if (!id) return null;
  if (type === "user" || type === "group") return { subject_type: type, subject_id: id };
  return null;
}

export function GrantAccessDialog({
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
  const grantSubject = grantSubjectOf(subject);
  const create = useMutation({
    mutationFn: () => {
      if (!grantSubject) throw new Error("grant subject missing");
      return apiCall("post", "/v1/rbac/grants", {
        body: { ...grantSubject, resource_type: "workflow", resource_id: workflowId, permission },
      });
    },
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
        disabled: !grantSubject || !workflowId,
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
