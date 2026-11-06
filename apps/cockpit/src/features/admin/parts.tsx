import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import {
  type CockpitColumn,
  CollapsibleSection,
  ContextHelp,
  CopyField,
  DataState,
  DataTable,
  Field,
  FieldDescription,
  FieldLabel,
  FormDialog,
  type InfiniteRows,
  Section,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import {
  permissionGroups,
  permissionLabel,
  roleChange,
  roleChangeNotes,
  roleName,
} from "@/pages/admin-model";
import { personEmailText } from "@/pages/apps-model";
import {
  builtinRoleDescription,
  type Envelope,
  type RoleItem,
  type UserItem,
  useRoleDetail,
} from "./data";

export function SectionList<T>({
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

export function AdminTable<T extends RowData>({
  collectionId,
  columns,
  data,
  onOpen,
  rowLabel,
  toolbar,
  grouping,
  groupingTabs,
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
  grouping?: { getKey(row: T): string };
  groupingTabs?: ReactNode;
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
      grouping={grouping}
      groupingTabs={groupingTabs}
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

export function ChoiceField({
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

export function PermissionList({
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

export function PermissionGroups({
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

export function RoleChangeConsequence({
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
