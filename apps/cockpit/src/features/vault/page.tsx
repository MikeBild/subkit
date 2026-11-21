import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Panel, Pill } from "@ui/atoms/pill";
import { EmptyState } from "@ui/molecules/empty-state";
import { Eye, EyeOff, KeyRound, Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createVaultItem,
  deleteVaultItem,
  listVaultActivity,
  listVaultItems,
  revealVaultItem,
  updateVaultItem,
  VAULT_KEY,
  vaultActivityKey,
} from "@/api/vault";
import { absolute, connectorHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ChoiceField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  Button,
  ConfirmDialog,
  CopyField,
  DataState,
  dialogFailure,
  type Fact,
  FactList,
  FilterBar,
  FormDialog,
  RecordSheet,
  SectionHeading,
  SegmentedControl,
} from "@/components/cockpit/patterns";
import { auditActionLabel } from "@/features/audit/model";
import {
  activityTone,
  canAddToWorkspace,
  canOnItem,
  createBody,
  deleteConsequenceKey,
  draftProblems,
  emptyDraft,
  emptyKey,
  groupByKind,
  hasHandle,
  itemsInScope,
  itemsMatching,
  lastUsedLabel,
  revealedRows,
  revealState,
  rotateBody,
  VAULT_KIND_LABEL,
  VAULT_SCOPE_LABEL,
  type ValueDraft,
  type VaultActivityEntry,
  type VaultDraft,
  type VaultEntryKind,
  type VaultGroup,
  type VaultItem,
  type VaultScope,
  valueProblem,
  vaultErrorKey,
  vaultFieldLabel,
  vaultHandle,
  vaultHandles,
  withoutValues,
} from "@/features/vault/model/vault";
import { EnvironmentChip } from "@/features/workflows";
import { reportFailure } from "@/lib/action-failure";
import { formatDateTime, formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

const SENSITIVE = { sensitive: true } as const;

const TONE_DOT = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/40",
} as const;

export function VaultList({
  groups,
  onOpen,
}: {
  groups: readonly VaultGroup[];
  onOpen(item: VaultItem): void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="grid gap-4" data-testid="vault-list">
      {groups.map((group) => (
        <section
          key={group.kind}
          className="grid gap-2"
          aria-labelledby={`vault-group-${group.kind}`}
          data-testid={`vault-group-${group.kind}`}
        >
          <SectionHeading
            id={`vault-group-${group.kind}`}
            className="text-sm font-semibold text-muted-foreground"
          >
            {t(group.label)}
          </SectionHeading>
          <Panel className="px-4 py-1">
            <ul className="divide-y">
              {group.items.map((item) => {
                const used = lastUsedLabel(item);
                return (
                  <li key={item.id} data-testid={`vault-item-${item.name}`}>
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      data-testid={`vault-item-${item.name}-${item.environment}-open`}
                      className="flex w-full flex-wrap items-center gap-3 rounded-md py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-sm font-medium [overflow-wrap:anywhere]">
                          {item.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {item.connector ? `${item.connector.display_name} · ` : null}
                          {t("vault.version", { version: item.version })}
                          {" · "}
                          <span data-testid={`vault-item-${item.name}-used`}>
                            {used.at
                              ? t(used.key, { when: formatRelativeTime(locale, used.at) })
                              : t(used.key)}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-wrap items-center gap-2">
                        <EnvironmentChip
                          environment={item.environment}
                          testId={`vault-item-${item.name}-environment`}
                        />
                        <Pill tone="neutral">{t(VAULT_SCOPE_LABEL[item.scope])}</Pill>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </section>
      ))}
    </div>
  );
}

export function VaultEmpty({
  scope,
  total,
  canWriteWorkspace,
  onAdd,
}: {
  scope: VaultScope;
  total: number;
  canWriteWorkspace: boolean;
  onAdd(): void;
}) {
  const { t } = useI18n();
  const key = emptyKey(scope, total, canWriteWorkspace);
  return (
    <EmptyState
      icon={KeyRound}
      title={t("vault.empty.title")}
      text={t(key, { handle: vaultHandle({ name: "crm-token", scope: "workspace" }) })}
      action={
        <Button size="sm" onClick={onAdd} data-testid="vault-empty-add">
          <Plus data-icon="inline-start" />
          {t("vault.add")}
        </Button>
      }
      testId="vault-empty"
    />
  );
}

export function VaultRevealed({
  values,
  secondsLeft,
  onHide,
}: {
  values: Readonly<Record<string, string>>;
  secondsLeft: number;
  onHide(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2" data-testid="vault-revealed">
      {revealedRows(values).map((row) => {
        const field = row.label ? t(row.label) : row.field;
        return (
          <CopyField
            key={row.field}
            value={row.value}
            label={t("vault.reveal.value", { field })}
            labelled
            testId={`vault-revealed-${row.field}`}
          />
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" role="timer">
          {t("vault.reveal.hidesIn", { seconds: secondsLeft })}
        </p>
        <Button variant="ghost" size="sm" onClick={onHide} data-testid="vault-reveal-hide">
          <EyeOff data-icon="inline-start" />
          {t("vault.reveal.hide")}
        </Button>
      </div>
    </div>
  );
}

export function VaultActivityList({ entries }: { entries: readonly VaultActivityEntry[] }) {
  const { t, locale } = useI18n();
  if (entries.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="vault-activity-empty">
        {t("vault.activity.empty")}
      </p>
    );
  return (
    <ol className="grid gap-1.5" data-testid="vault-activity">
      {entries.map((entry) => {
        const label = auditActionLabel(entry.action);
        const tone = activityTone(entry.result);
        return (
          <li
            key={entry.id}
            className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
            data-action={entry.action}
          >
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
            <span className="min-w-0 flex-1">
              {label.kind === "named" ? (
                t(label.key)
              ) : (
                <span className="font-mono text-xs">{label.value}</span>
              )}
            </span>
            <time dateTime={entry.at} className="shrink-0 text-xs text-muted-foreground">
              {formatDateTime(locale, entry.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

export function VaultDetail({
  item,
  permissions,
  revealed,
  secondsLeft,
  revealPending,
  activity,
  onReveal,
  onHide,
  onRotate,
  onDelete,
  onOpenConnector,
}: {
  item: VaultItem;
  permissions: readonly string[];
  revealed: Readonly<Record<string, string>> | null;
  secondsLeft: number;
  revealPending: boolean;
  activity: ReactNode;
  onReveal(): void;
  onHide(): void;
  onRotate(): void;
  onDelete(): void;
  onOpenConnector(id: string): void;
}) {
  const { t, locale } = useI18n();
  const used = lastUsedLabel(item);
  const revealArea = useRef<HTMLElement>(null);
  const wasRevealed = useRef(false);
  useEffect(() => {
    if (wasRevealed.current && !revealed)
      revealArea.current?.querySelector<HTMLButtonElement>("button")?.focus();
    wasRevealed.current = revealed !== null;
  }, [revealed]);
  const facts: Fact[] = [
    { label: t("vault.detail.kind"), value: t(VAULT_KIND_LABEL[item.kind]) },
    { label: t("vault.detail.scope"), value: t(VAULT_SCOPE_LABEL[item.scope]) },
    {
      label: t("vault.detail.environment"),
      value: <EnvironmentChip environment={item.environment} testId="vault-detail-environment" />,
    },
    { label: t("vault.detail.version"), value: String(item.version) },
    {
      label: t("vault.detail.lastUsed"),
      value: used.at ? formatDateTime(locale, used.at) : t(used.key),
    },
    { label: t("vault.detail.created"), value: formatDateTime(locale, item.created_at) },
    ...(item.rotated_at
      ? [{ label: t("vault.detail.rotated"), value: formatDateTime(locale, item.rotated_at) }]
      : []),
    ...(item.description
      ? [{ label: t("vault.detail.description"), value: item.description }]
      : []),
  ];
  return (
    <div className="grid gap-6" data-testid="vault-detail">
      {hasHandle(item.kind) ? (
        <section className="grid gap-2" aria-label={t("vault.detail.handle")}>
          {vaultHandles(item).map(({ field, handle }) => {
            const fieldLabel = field ? vaultFieldLabel(field) : null;
            const label = fieldLabel
              ? t("vault.detail.handleFor", { field: t(fieldLabel) })
              : t("vault.detail.handle");
            return (
              <CopyField
                key={handle}
                value={handle}
                label={label}
                labelled
                testId={`vault-handle${field ? `-${field}` : ""}`}
              />
            );
          })}
        </section>
      ) : null}
      <FactList items={facts} testId="vault-facts" />
      {item.kind === "connector" && item.connector ? (
        <div className="grid gap-2" data-testid="vault-connector">
          <p className="text-sm text-muted-foreground">{t("vault.connector.note")}</p>
          <a
            href={absolute(connectorHref(item.connector.id))}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              if (item.connector) onOpenConnector(item.connector.id);
            }}
            className="self-start text-sm font-medium underline-offset-2 hover:underline"
            data-testid="vault-connector-link"
          >
            {t("vault.connector.open", { name: item.connector.display_name })} →
          </a>
        </div>
      ) : null}
      {item.kind === "template_client" ? (
        <p className="text-sm text-muted-foreground" data-testid="vault-template-note">
          {t("vault.template.note", { template: item.template_slug ?? item.name })}
        </p>
      ) : null}
      {canOnItem(item, "reveal", permissions) ? (
        <section className="grid gap-2" ref={revealArea} data-testid="vault-reveal">
          {revealed ? (
            <VaultRevealed values={revealed} secondsLeft={secondsLeft} onHide={onHide} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                pending={revealPending}
                onClick={onReveal}
                data-testid="vault-reveal-button"
              >
                <Eye data-icon="inline-start" />
                {t("vault.reveal")}
              </Button>
              <span className="text-xs text-muted-foreground">{t("vault.reveal.note")}</span>
            </div>
          )}
        </section>
      ) : null}
      {canOnItem(item, "rotate", permissions) || canOnItem(item, "delete", permissions) ? (
        <div className="flex flex-wrap gap-2">
          {canOnItem(item, "rotate", permissions) ? (
            <Button variant="outline" size="sm" onClick={onRotate} data-testid="vault-rotate">
              {t("vault.rotate")}
            </Button>
          ) : null}
          {canOnItem(item, "delete", permissions) ? (
            <Button variant="outline" size="sm" onClick={onDelete} data-testid="vault-delete">
              {t("vault.delete")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <section className="grid gap-2" aria-labelledby="vault-activity-title">
        <SectionHeading id="vault-activity-title" className="text-sm font-semibold">
          {t("vault.activity.title")}
        </SectionHeading>
        {activity}
      </section>
    </div>
  );
}

function ValueFields({
  idPrefix,
  draft,
  onChange,
  error,
}: {
  idPrefix: string;
  draft: ValueDraft;
  onChange(change: Partial<ValueDraft>): void;
  error: string | null;
}) {
  const { t } = useI18n();
  if (draft.kind === "secret")
    return (
      <TextField
        id={`${idPrefix}-token`}
        label={t("vault.field.token")}
        type="password"
        value={draft.token}
        onChange={(token) => onChange({ token })}
        error={error}
        required
        mono
      />
    );
  return (
    <>
      <TextField
        id={`${idPrefix}-username`}
        label={t("vault.field.username")}
        value={draft.username}
        onChange={(username) => onChange({ username })}
        required
      />
      <TextField
        id={`${idPrefix}-password`}
        label={t("vault.field.password")}
        type="password"
        value={draft.password}
        onChange={(password) => onChange({ password })}
        error={error}
        required
      />
    </>
  );
}

function AddDialog({
  open,
  canWriteWorkspace,
  onClose,
  onAdded,
}: {
  open: boolean;
  canWriteWorkspace: boolean;
  onClose(): void;
  onAdded(item: VaultItem): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<VaultDraft>(() => emptyDraft(canWriteWorkspace));
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const create = useMutation({
    mutationFn: createVaultItem,
    gcTime: 0,
    retry: false,
    meta: SENSITIVE,
  });
  const problems = draftProblems(draft);
  const change = (next: Partial<VaultDraft>) => setDraft((current) => ({ ...current, ...next }));
  const close = () => {
    setDraft(emptyDraft(canWriteWorkspace));
    setTouched(false);
    setFailure(null);
    create.reset();
    onClose();
  };
  const submit = () => {
    setTouched(true);
    if (problems.name || problems.value) return;
    const body = createBody(draft);
    setFailure(null);
    setDraft((current) => withoutValues(current));
    create.mutate(body, {
      onError: (error) => {
        create.reset();
        setTouched(false);
        setFailure(error);
      },
      onSuccess: (item) => {
        create.reset();
        setDraft(emptyDraft(canWriteWorkspace));
        setTouched(false);
        onAdded(item);
      },
    });
  };
  const nameError = touched && problems.name ? t(problems.name) : null;
  const valueError = touched && problems.value ? t(problems.value) : null;
  const name = draft.name.trim();
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("vault.add.title")}
      description={t("vault.add.description")}
      submit={{ label: t("vault.add.submit"), pending: create.isPending }}
      onSubmit={submit}
      error={failure ? dialogFailure(t(vaultErrorKey(failure)), failure) : null}
      testId="vault-add"
    >
      <div className="grid gap-4">
        <ChoiceField
          label={t("vault.field.kind")}
          value={draft.kind}
          onChange={(kind) => change({ kind })}
          options={[
            { value: "secret", label: t("vault.kind.secret") },
            { value: "login", label: t("vault.kind.login") },
          ]}
          testId="vault-add-kind"
        />
        <div className="grid gap-1.5">
          <TextField
            id="vault-add-name"
            label={t("vault.field.name")}
            help={t("vault.field.nameHelp")}
            value={draft.name}
            onChange={(next) => change({ name: next })}
            placeholder="crm-token"
            error={nameError}
            required
            mono
          />
          {name && !problems.name ? (
            <p className="font-mono text-xs text-muted-foreground" data-testid="vault-add-handle">
              {t("vault.field.handlePreview", {
                handle: vaultHandle({ name, scope: draft.scope }),
              })}
            </p>
          ) : null}
        </div>
        <ChoiceField<VaultScope>
          label={t("vault.field.scope")}
          value={draft.scope}
          onChange={(scope) => change({ scope })}
          options={(canWriteWorkspace
            ? (["workspace", "person"] as const)
            : (["person"] as const)
          ).map((scope) => ({ value: scope, label: t(VAULT_SCOPE_LABEL[scope]) }))}
          {...(canWriteWorkspace ? {} : { description: t("vault.field.scopeReadOnly") })}
          testId="vault-add-scope"
        />
        <ChoiceField
          label={t("vault.field.environment")}
          value={draft.environment}
          onChange={(environment) => change({ environment })}
          options={[
            { value: "prod", label: t("environmentChip.prod") },
            { value: "dev", label: t("environmentChip.dev") },
          ]}
          testId="vault-add-environment"
        />
        <ValueFields idPrefix="vault-add" draft={draft} onChange={change} error={valueError} />
        <TextAreaField
          id="vault-add-description"
          label={t("vault.field.description")}
          value={draft.description}
          onChange={(description) => change({ description })}
          rows={2}
        />
      </div>
    </FormDialog>
  );
}

function RotateDialog({
  item,
  onClose,
  onRotated,
}: {
  item: VaultItem | null;
  onClose(): void;
  onRotated(item: VaultItem): void;
}) {
  const { t } = useI18n();
  const kind: VaultEntryKind = item?.kind === "login" ? "login" : "secret";
  const blank: ValueDraft = { kind, token: "", username: "", password: "" };
  const [draft, setDraft] = useState<ValueDraft>(blank);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const rotate = useMutation({
    mutationFn: (input: { id: string; body: ReturnType<typeof rotateBody> }) =>
      updateVaultItem(input.id, input.body),
    gcTime: 0,
    retry: false,
    meta: SENSITIVE,
  });
  const shown = { ...draft, kind };
  const problem = valueProblem(shown);
  const close = () => {
    setDraft(blank);
    setTouched(false);
    setFailure(null);
    rotate.reset();
    onClose();
  };
  const submit = () => {
    setTouched(true);
    if (!item || problem) return;
    const body = rotateBody(shown);
    setFailure(null);
    setDraft(withoutValues(shown));
    rotate.mutate(
      { id: item.id, body },
      {
        onError: (error) => {
          rotate.reset();
          setTouched(false);
          setFailure(error);
        },
        onSuccess: (next) => {
          rotate.reset();
          setDraft(blank);
          setTouched(false);
          onRotated(next);
        },
      },
    );
  };
  return (
    <FormDialog
      open={item !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("vault.rotate.title", { name: item?.name ?? "" })}
      description={t("vault.rotate.description")}
      submit={{ label: t("vault.rotate.submit"), pending: rotate.isPending }}
      onSubmit={submit}
      error={failure ? dialogFailure(t(vaultErrorKey(failure)), failure) : null}
      testId="vault-rotate-dialog"
    >
      <div className="grid gap-4">
        <ValueFields
          idPrefix="vault-rotate"
          draft={shown}
          onChange={(change) => setDraft((current) => ({ ...current, ...change }))}
          error={touched && problem ? t(problem) : null}
        />
      </div>
    </FormDialog>
  );
}

function useRevealTimer(revealedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (revealedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [revealedAt]);
  return now;
}

function VaultSheet({
  item,
  permissions,
  onClose,
  onRotate,
  onDelete,
}: {
  item: VaultItem | null;
  permissions: readonly string[];
  onClose(): void;
  onRotate(item: VaultItem): void;
  onDelete(item: VaultItem): void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [revealed, setRevealed] = useState<{
    id: string;
    values: Record<string, string>;
    at: number;
  } | null>(null);
  const now = useRevealTimer(revealed?.at ?? null);
  const timer = revealState(revealed?.at ?? null, now);
  const shown = revealed && item && revealed.id === item.id && timer.visible ? revealed : null;
  const itemId = item?.id ?? null;
  const activity = useQuery({
    queryKey: vaultActivityKey(itemId ?? ""),
    queryFn: () => listVaultActivity(itemId ?? ""),
    enabled: itemId !== null,
  });
  const reveal = useMutation({
    retry: false,
    meta: SENSITIVE,
    mutationFn: revealVaultItem,
    gcTime: 0,
    onError: (failure) => reportFailure(t(vaultErrorKey(failure, item?.kind)), failure),
    onSuccess: (result) => {
      setRevealed({ id: result.id, values: { ...result.values }, at: Date.now() });
      reveal.reset();
      void activity.refetch();
    },
  });
  useEffect(() => {
    if (revealed && !shown) setRevealed(null);
  }, [revealed, shown]);
  return (
    <RecordSheet
      open={item !== null}
      onOpenChange={(open) => {
        if (open) return;
        setRevealed(null);
        onClose();
      }}
      title={<span className="font-mono">{item?.name ?? ""}</span>}
      subtitle={item ? t(VAULT_KIND_LABEL[item.kind]) : undefined}
      testId="vault-sheet"
    >
      {item ? (
        <VaultDetail
          item={item}
          permissions={permissions}
          revealed={shown?.values ?? null}
          secondsLeft={timer.secondsLeft}
          revealPending={reveal.isPending}
          onReveal={() => reveal.mutate(item.id)}
          onHide={() => setRevealed(null)}
          onRotate={() => onRotate(item)}
          onDelete={() => onDelete(item)}
          onOpenConnector={(id) => void navigate({ to: connectorHref(id) })}
          activity={
            activity.isPending ? (
              <DataState state="loading" testId="vault-activity-loading" />
            ) : activity.isError ? (
              <DataState
                state="error"
                line={t("vault.activity.loadFailed")}
                error={activity.error}
                onRetry={() => void activity.refetch()}
                testId="vault-activity-failed"
              />
            ) : (
              <VaultActivityList entries={activity.data} />
            )
          }
        />
      ) : null}
    </RecordSheet>
  );
}

export function VaultArea() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const permissions = session.permissions;
  const canWriteWorkspace = canAddToWorkspace(permissions);
  const [scope, setScope] = useState<VaultScope>("workspace");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [rotating, setRotating] = useState<VaultItem | null>(null);
  const [deleting, setDeleting] = useState<VaultItem | null>(null);
  const items = useQuery({ queryKey: VAULT_KEY, queryFn: listVaultItems });
  const refresh = () => client.invalidateQueries({ queryKey: VAULT_KEY });
  const remove = useMutation({
    mutationFn: (item: VaultItem) => deleteVaultItem(item.id),
    onError: (failure) => {
      reportFailure(t(vaultErrorKey(failure, deleting?.kind)), failure);
      if (vaultErrorKey(failure) === "vault.error.notFound") void refresh();
    },
    onSuccess: async (_done, item) => {
      toast.success(t("vault.deleted", { name: item.name }));
      setDeleting(null);
      setOpenId(null);
      await refresh();
    },
  });
  const all = items.data ?? [];
  const shown = itemsMatching(itemsInScope(all, scope), search);
  const groups = groupByKind(shown);
  const open = all.find((item) => item.id === openId) ?? null;
  return (
    <section className="flex flex-col gap-4" data-testid="settings-area-vault">
      <p className="text-sm text-muted-foreground">{t("vault.intro")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <FilterBar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("vault.search"),
            testId: "vault-search",
          }}
          segmented={
            <SegmentedControl
              label={t("vault.filter.label")}
              value={scope}
              onValueChange={(next) => setScope(next as VaultScope)}
              options={(["workspace", "person"] as const).map((value) => ({
                value,
                label: t(VAULT_SCOPE_LABEL[value]),
                testId: `vault-filter-${value}`,
              }))}
              testId="vault-filter"
            />
          }
        />
        <Button className="ms-auto" onClick={() => setAdding(true)} data-testid="vault-add-open">
          <Plus data-icon="inline-start" />
          {t("vault.add")}
        </Button>
      </div>
      {items.isPending ? (
        <DataState state="loading" testId="vault-loading" />
      ) : items.isError ? (
        <DataState
          state="error"
          line={t("vault.loadFailed")}
          error={items.error}
          onRetry={() => void items.refetch()}
          testId="vault-load-failed"
        />
      ) : groups.length === 0 && search.trim() ? (
        <DataState
          state="empty"
          line={t("vault.noMatch", { search: search.trim() })}
          testId="vault-no-match"
        />
      ) : groups.length === 0 ? (
        <VaultEmpty
          scope={scope}
          total={all.length}
          canWriteWorkspace={canWriteWorkspace}
          onAdd={() => setAdding(true)}
        />
      ) : (
        <VaultList groups={groups} onOpen={(item) => setOpenId(item.id)} />
      )}
      <AddDialog
        open={adding}
        canWriteWorkspace={canWriteWorkspace}
        onClose={() => setAdding(false)}
        onAdded={(item) => {
          toast.success(t("vault.added", { name: item.name }));
          setAdding(false);
          setScope(item.scope);
          void refresh();
        }}
      />
      <VaultSheet
        item={open}
        permissions={permissions}
        onClose={() => setOpenId(null)}
        onRotate={setRotating}
        onDelete={setDeleting}
      />
      <RotateDialog
        item={rotating}
        onClose={() => setRotating(null)}
        onRotated={(item) => {
          toast.success(t("vault.rotated", { name: item.name }));
          setRotating(null);
          void refresh();
          void client.invalidateQueries({ queryKey: vaultActivityKey(item.id) });
        }}
      />
      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleting(null);
          }}
          object={deleting.name}
          verb={t("vault.delete")}
          consequence={t(deleteConsequenceKey(deleting.kind), {
            handle: vaultHandle(deleting),
            template: deleting.template_slug ?? deleting.name,
          })}
          destructive
          pending={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          testId="vault-delete-dialog"
        />
      ) : null}
    </section>
  );
}
