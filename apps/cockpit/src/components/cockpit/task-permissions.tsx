import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import {
  GrantTaskAuthority,
  TASK_GRANT_INVALIDATES,
  TaskGrantSignIn,
  taskGrantSessionExpired,
} from "@/components/cockpit/grant-task-authority";
import {
  ActionButton,
  ConfirmDialog,
  DataState,
  FactList,
  SummaryLine,
  SummaryParts,
  TabBody,
} from "@/components/cockpit/patterns";
import {
  blockedRows,
  type GrantValidity,
  grantValidity,
  taskGrantRows,
} from "@/components/cockpit/task-grant-model";
import { TaskGrantBlocked, TaskGrantRows } from "@/components/cockpit/task-grant-rows";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { taskKeys } from "@/lib/task-keys";

function useValidityParts(validity: GrantValidity): string[] {
  const { t, tn, dateTime } = useI18n();
  if (validity.state === "none") return [t("taskPermissions.summary.none")];
  if (validity.state === "exhausted") return [t("taskPermissions.summary.exhausted")];
  if (validity.state === "expired")
    return [t("taskPermissions.summary.expired", { date: dateTime(validity.until) })];
  return [
    validity.until === null
      ? t("taskPermissions.summary.untilRevoked")
      : t("taskPermissions.summary.until", { date: dateTime(validity.until) }),
    ...(validity.remainingRuns === null
      ? []
      : [tn("taskPermissions.remaining", validity.remainingRuns)]),
  ];
}

export function TaskPermissions({
  taskId,
  allowOffered = false,
}: {
  taskId: string;
  allowOffered?: boolean;
}) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const connectorNames = useConnectorNames();
  const [allowing, setAllowing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const task = useQuery({
    queryKey: taskKeys.detail(taskId),
    queryFn: () => apiCall("get", "/v1/tasks/{id}", { path: { id: taskId } }),
  });
  const preview = useQuery({
    queryKey: taskKeys.grantPreview(taskId),
    queryFn: () => apiCall("get", "/v1/tasks/{id}/grant-preview", { path: { id: taskId } }),
  });
  const reviewed = preview.data ?? null;
  const grant = reviewed?.live_grant ?? null;
  const validity = grantValidity(grant, Date.now());
  const parts = useValidityParts(validity);
  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      apiCall("post", "/v1/tasks/{id}/grants/{grant_id}/revoke", {
        path: { id: taskId, grant_id: grantId },
      }),
    onSuccess: () => {
      setRevoking(false);
      toast.success(t("taskPermissions.revoked"));
    },
    onError: (failure) => reportFailure(t("taskPermissions.revokeFailed"), failure),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: taskKeys.grantsOf(taskId) });
      for (const queryKey of TASK_GRANT_INVALIDATES) void client.invalidateQueries({ queryKey });
    },
  });
  if (!reviewed && taskGrantSessionExpired(preview.error))
    return (
      <DataState
        state="error"
        line={t("taskPermissions.sessionRequired")}
        action={<TaskGrantSignIn testId="task-permissions-sign-in" />}
        testId="task-permissions-session"
      />
    );
  if (!reviewed)
    return preview.error ? (
      <DataState
        state="error"
        line={t("taskPermissions.loadFailed")}
        onRetry={() => void preview.refetch()}
        testId="task-permissions-failed"
      />
    ) : (
      <DataState state="loading" testId="task-permissions-loading" />
    );
  const rows = taskGrantRows(reviewed, connectorNames, t("common.unknown"));
  const live = validity.state === "live";
  const mayGrant = session.permissions.includes("task:grant") && reviewed.grantable;
  const offersAllow = mayGrant && !live && !allowOffered;
  const name = task.data?.name ?? null;
  return (
    <>
      <TabBody
        testId="task-permissions"
        summary={
          <SummaryLine
            testId="task-permissions-summary"
            text={<SummaryParts parts={parts} />}
            aside={
              mayGrant && live ? (
                <ActionButton
                  variant="outline"
                  onClick={() => setRevoking(true)}
                  testId="task-permissions-revoke"
                >
                  {t("taskPermissions.revoke")}
                </ActionButton>
              ) : !offersAllow ? undefined : (
                <ActionButton
                  variant="primary"
                  onClick={() => setAllowing(true)}
                  testId="task-permissions-allow"
                >
                  {t("taskGrant.allow")}
                </ActionButton>
              )
            }
          />
        }
        technical={
          grant ? (
            <FactList
              testId="task-permissions-technical-facts"
              items={[
                { label: t("taskPermissions.technical.id"), value: grant.id },
                { label: t("taskPermissions.technical.since"), value: dateTime(grant.valid_from) },
              ]}
            />
          ) : undefined
        }
      >
        <TaskGrantRows rows={rows} mode="standing" live={live} testId="task-permissions-rows" />
        <TaskGrantBlocked
          blocked={blockedRows(rows)}
          environment={reviewed.environment}
          links={false}
          testId="task-permissions-blocked"
        />
      </TabBody>
      {offersAllow ? (
        <GrantTaskAuthority taskId={taskId} open={allowing} onOpenChange={setAllowing} />
      ) : null}
      {grant ? (
        <ConfirmDialog
          open={revoking}
          onOpenChange={(next) => !revoke.isPending && setRevoking(next)}
          object={
            name === null
              ? t("taskPermissions.revokeObjectUnnamed")
              : t("taskPermissions.revokeObject", { name })
          }
          verb={t("taskPermissions.revoke")}
          consequence={t("taskPermissions.revokeConsequence")}
          destructive
          pending={revoke.isPending}
          onConfirm={async () => {
            await revoke.mutateAsync(grant.id).catch(() => undefined);
          }}
          testId="task-permissions-revoke-dialog"
        />
      ) : null}
    </>
  );
}
