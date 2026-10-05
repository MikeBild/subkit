import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, auditHref } from "@/app/links";
import { useSession } from "@/app/session";
import { Button, ConfirmDialog, ContextHelp } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  isStillRestarting,
  RESTART_CONFIRM_TIMEOUT_MS,
  RESTART_PATH,
  RESTART_POLL_MS,
  RESTART_STATUS_PATH,
  type RestartAccepted,
  type RestartOffer,
  type RestartStatus,
  restartOffer,
  restartRefusalKey,
  restartSignsEveryoneOut,
  restartVerdict,
} from "@/pages/settings-restart-model";

export const RESTART_STATUS_QUERY_KEY = ["system", "restart-status"] as const;

export function useRestartOffer(): { offer: RestartOffer; status: RestartStatus | undefined } {
  const session = useSession();
  const query = useQuery({
    queryKey: RESTART_STATUS_QUERY_KEY,
    queryFn: () => apiRequest<RestartStatus>(RESTART_STATUS_PATH),
    enabled: session.permissions.includes("settings:read"),
    retry: false,
  });
  return {
    offer: restartOffer(session.permissions, query.data?.restart_supervised),
    status: query.data,
  };
}

export function SettingsRestartOffer({
  offer,
  onRestart,
}: {
  offer: RestartOffer;
  onRestart: () => void;
}) {
  const { t } = useI18n();
  if (offer === "restart") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-2"
        onClick={onRestart}
        data-testid="settings-restart-now"
      >
        {t("settings.restartNow.button")}
      </Button>
    );
  }
  if (offer === "manual")
    return (
      <ContextHelp label={t("settings.restartNow.button")} testId="settings-restart-manual">
        {t("settings.restartNow.manual")}
      </ContextHelp>
    );
  return (
    <span className="text-muted-foreground" data-testid="settings-restart-ask-admin">
      <span aria-hidden="true"> · </span>
      {t("settings.restartNow.askAdmin")}
    </span>
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollStatus(): Promise<RestartStatus | null> {
  try {
    return await apiRequest<RestartStatus>(RESTART_STATUS_PATH);
  } catch (error) {
    if (isStillRestarting(error)) return null;
    throw error;
  }
}

export function SettingsRestartDialog({
  open,
  onOpenChange,
  pendingFields,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingFields: readonly string[];
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [restarting, setRestarting] = useState(false);
  const setError = (message: string) => toast.error(message);

  async function restart(): Promise<void> {
    let accepted: RestartAccepted;
    try {
      accepted = await apiRequest<RestartAccepted>(RESTART_PATH, { method: "POST" });
    } catch (refusal) {
      setError(t(restartRefusalKey(refusal instanceof ApiError ? refusal.code : null)));
      return;
    }
    setRestarting(true);
    const auditLink = absolute(
      auditHref({ resourceType: "engine", resourceId: accepted.request_id }),
    );
    const deadline = Date.now() + RESTART_CONFIRM_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        await wait(RESTART_POLL_MS);
        const verdict = restartVerdict(accepted.boot_id, await pollStatus());
        if (verdict === "waiting") continue;
        await client.invalidateQueries({ queryKey: ["admin", "settings"] });
        await client.invalidateQueries({ queryKey: RESTART_STATUS_QUERY_KEY });
        const notify = verdict === "restarted" ? toast.success : toast.error;
        notify(
          t(
            verdict === "restarted"
              ? "settings.restartNow.done"
              : "settings.restartNow.notActivated",
          ),
          {
            action: {
              label: t("settings.restartNow.auditLink"),
              onClick: () => window.location.assign(auditLink),
            },
          },
        );
        return;
      }
      setError(t("settings.restartNow.notConfirmed"));
    } catch (failure) {
      setError(
        t(
          failure instanceof ApiError && failure.status === 401
            ? "settings.restartNow.signInAgain"
            : "settings.restartNow.notConfirmed",
        ),
      );
    } finally {
      setRestarting(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      object={t("settings.restartNow.object")}
      verb={t("settings.restartNow.verb")}
      consequence={
        restarting
          ? t("settings.restartNow.progress")
          : restartSignsEveryoneOut(pendingFields)
            ? t("settings.restartNow.signsOut")
            : t("settings.restartNow.consequence")
      }
      pending={restarting}
      onConfirm={restart}
      testId="settings-restart-now-dialog"
    />
  );
}
