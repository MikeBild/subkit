import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { cockpitApiHref } from "@/app/installation-context";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import { GrantLimitField } from "@/components/cockpit/grant-limit-field";
import {
  Button,
  Chip,
  DataState,
  dialogFailure,
  Field,
  FormDialog,
} from "@/components/cockpit/patterns";
import {
  blockedRows,
  type GrantOutcomeRow,
  grantOutcome,
  type TaskGrantPreview,
  taskGrantInput,
  taskGrantRows,
  taskScheduleLine,
} from "@/components/cockpit/task-grant-model";
import { TaskGrantBlocked, TaskGrantRows } from "@/components/cockpit/task-grant-rows";
import { DEFAULT_GRANT_LIMIT, type GrantLimit } from "@/lib/core/authority-decision";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { taskKeys } from "@/lib/task-keys";

export const TASK_GRANT_INVALIDATES = [
  taskKeys.details,
  taskKeys.lists,
  ["attention"],
  ["decisions"],
  ["workflow-authorities"],
  ["workflow-automation-status"],
] as const;

const CHANGED = {
  task_grant_fingerprint_changed: "taskGrant.changed.task",
  task_grant_preview_changed: "taskGrant.changed.workflow",
} as const;

type ChangedCode = keyof typeof CHANGED;

function changedCode(error: unknown): ChangedCode | null {
  const code = error instanceof ApiError ? error.code : null;
  return code !== null && Object.hasOwn(CHANGED, code) ? (code as ChangedCode) : null;
}

export function taskGrantSessionExpired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 ||
      error.code === "human_session_expired" ||
      error.code === "human_session_required")
  );
}

export function taskGrantSessionRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "human_session_required";
}

export function TaskGrantSignIn({ testId }: { testId: string }) {
  const { t } = useI18n();
  return (
    <Button asChild>
      <a
        data-testid={testId}
        href={cockpitApiHref(
          `/v1/identity/cockpit-login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`,
        )}
      >
        {t("authority.signIn")}
      </a>
    </Button>
  );
}

const OUTCOME_KEYS = {
  co_granted: "taskGrant.standing.coGranted",
  covered: "taskGrant.standing.covered",
  asks: "taskGrant.standing.asks",
  unavailable: "taskGrant.standing.unavailable",
} as const;

function OutcomeList({ rows }: { rows: readonly GrantOutcomeRow[] }) {
  const { t } = useI18n();
  return (
    <ul
      aria-label={t("taskGrant.list")}
      className="flex min-w-0 flex-col divide-y rounded-md border"
      data-testid="task-grant-outcome"
    >
      {rows.map((row, index) => (
        <li
          key={row.key}
          className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          data-testid={`task-grant-outcome-${index}`}
          data-standing={row.standing}
        >
          <span className="min-w-0 flex-1 truncate font-medium">
            {row.name ?? t("taskGrant.workflow.unnamed")}
          </span>
          <Chip
            className={
              row.standing === "asks" || row.standing === "unavailable"
                ? "text-amber-700 dark:text-amber-400"
                : undefined
            }
          >
            {t(OUTCOME_KEYS[row.standing])}
          </Chip>
        </li>
      ))}
    </ul>
  );
}

export function GrantTaskAuthority({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t, locale, dateTime } = useI18n();
  const client = useQueryClient();
  const connectorNames = useConnectorNames(open);
  const [limit, setLimit] = useState<GrantLimit>(DEFAULT_GRANT_LIMIT);
  const [changed, setChanged] = useState<ChangedCode | null>(null);
  const [outcome, setOutcome] = useState<{
    rows: GrantOutcomeRow[];
    refused: GrantOutcomeRow[];
    environment: "dev" | "prod";
  } | null>(null);
  const task = useQuery({
    queryKey: taskKeys.detail(taskId),
    enabled: open,
    queryFn: () => apiCall("get", "/v1/tasks/{id}", { path: { id: taskId } }),
  });
  const preview = useQuery({
    queryKey: taskKeys.grantPreview(taskId),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: () => apiCall("get", "/v1/tasks/{id}/grant-preview", { path: { id: taskId } }),
  });
  const name = task.data?.name ?? null;
  const grant = useMutation({
    mutationFn: (reviewed: TaskGrantPreview) =>
      apiCall("post", "/v1/tasks/{id}/grants", {
        path: { id: taskId },
        body: taskGrantInput(reviewed, limit, Date.now()),
      }),
    onSuccess: (result, reviewed) => {
      void client.invalidateQueries({ queryKey: taskKeys.grantsOf(taskId) });
      for (const queryKey of TASK_GRANT_INVALIDATES) void client.invalidateQueries({ queryKey });
      const settled = grantOutcome(result, reviewed);
      if (settled.unexpected > 0) {
        setOutcome({
          rows: settled.rows,
          refused: settled.refused,
          environment: reviewed.environment,
        });
        return;
      }
      toast.success(name === null ? t("taskGrant.savedUnnamed") : t("taskGrant.saved", { name }));
      onOpenChange(false);
    },
    onError: (error) => {
      const code = changedCode(error);
      if (!code) return;
      setChanged(code);
      grant.reset();
      void preview.refetch();
    },
  });
  useEffect(() => {
    if (!open) return;
    setLimit(DEFAULT_GRANT_LIMIT);
    setChanged(null);
    setOutcome(null);
    grant.reset();
  }, [open]);
  const close = (next: boolean) => {
    if (grant.isPending) return;
    onOpenChange(next);
  };
  if (outcome)
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        size="wide"
        testId="task-grant-dialog"
        cancelTestId="task-grant-close"
        cancelLabel={t("common.close")}
        title={
          name === null ? t("taskGrant.result.titleUnnamed") : t("taskGrant.result.title", { name })
        }
      >
        <OutcomeList rows={outcome.rows} />
        <TaskGrantBlocked
          blocked={outcome.refused}
          environment={outcome.environment}
          links
          testId="task-grant-blocked"
        />
      </FormDialog>
    );
  const reviewed = preview.data ?? null;
  const rows = reviewed ? taskGrantRows(reviewed, connectorNames, t("common.unknown")) : [];
  const sessionExpired =
    taskGrantSessionExpired(grant.error) || taskGrantSessionExpired(preview.error);
  const sessionRequired =
    taskGrantSessionRequired(grant.error) || taskGrantSessionRequired(preview.error);
  const busy = grant.isPending || preview.isFetching;
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      size="wide"
      testId="task-grant-dialog"
      cancelTestId="task-grant-cancel"
      title={name === null ? t("taskGrant.titleLoading") : t("taskGrant.title", { name })}
      description={
        reviewed?.grantable
          ? taskScheduleLine(reviewed.schedule, t, LOCALE_TAGS[locale], dateTime)
          : undefined
      }
      error={
        sessionRequired
          ? t("taskGrant.sessionRequired")
          : sessionExpired
            ? t("taskGrant.sessionExpired")
            : grant.error
              ? dialogFailure(t("taskGrant.failed"), grant.error)
              : null
      }
      actions={sessionExpired ? <TaskGrantSignIn testId="task-grant-sign-in" /> : undefined}
      {...(reviewed?.grantable && !sessionExpired
        ? {
            submit: {
              label: t("taskGrant.allow"),
              pending: grant.isPending,
              disabled: busy,
              testId: "task-grant-confirm",
            },
            onSubmit: () => grant.mutate(reviewed),
          }
        : {})}
    >
      {!reviewed && preview.isPending ? (
        <DataState state="loading" testId="task-grant-loading" className="py-0" />
      ) : null}
      {!reviewed && preview.error && !sessionExpired ? (
        <DataState
          state="error"
          line={t("taskGrant.loadFailed")}
          onRetry={() => void preview.refetch()}
          testId="task-grant-load-failed"
          className="py-0"
        />
      ) : null}
      {reviewed && !reviewed.grantable ? (
        <p className="text-sm" data-testid="task-grant-archived">
          {t("taskGrant.archived")}
        </p>
      ) : null}
      {reviewed?.grantable ? (
        <>
          {changed ? (
            <p role="status" className="text-sm font-medium" data-testid="task-grant-changed">
              {t(CHANGED[changed])}
            </p>
          ) : null}
          <TaskGrantRows rows={rows} mode="review" testId="task-grant-rows" />
          <Field>
            <GrantLimitField
              limit={limit}
              disabled={busy}
              onChange={setLimit}
              testId="task-grant-limit"
            />
          </Field>
          <TaskGrantBlocked
            blocked={blockedRows(rows)}
            environment={reviewed.environment}
            links
            testId="task-grant-blocked"
          />
        </>
      ) : null}
    </FormDialog>
  );
}
