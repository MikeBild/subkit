// "Jetzt neu starten": the offer in the waiting-for-a-restart line and the one
// confirmation that restarts SubKit and follows it back.
//
// The page code is bundled statically (no route chunk is loaded lazily), so
// nothing has to be fetched before the engine goes away. The session lives in
// PostgreSQL and is signed with a key that survives the restart; only a
// pending `auth.session.secret` signs everyone out, and the dialog says so.
// While the engine is down the polling below never touches the bootstrap
// query, so the session gate cannot send the reader to the sign-in page
// halfway through.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, auditHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ConfirmAction } from "@/components/cockpit/confirm-action";
import { Button } from "@/components/ui/button";
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

/** Which offer the page makes, from the reader's permissions and the engine's
 * supervisor flag. Without settings:read the status is not asked for. */
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

/** What stands after "Wartet auf Neustart: …": the button, the manual way, or
 * the request to ask an admin. */
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
  return (
    <span
      className="block text-muted-foreground"
      data-testid={offer === "manual" ? "settings-restart-manual" : "settings-restart-ask-admin"}
    >
      {t(offer === "manual" ? "settings.restartNow.manual" : "settings.restartNow.askAdmin")}
    </span>
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the status once; null while the engine is away. */
async function pollStatus(): Promise<RestartStatus | null> {
  try {
    return await apiRequest<RestartStatus>(RESTART_STATUS_PATH);
  } catch (error) {
    if (isStillRestarting(error)) return null;
    throw error;
  }
}

/** The confirmation, the restart and its follow-up. Controlled, so both the
 * button in the status line and "Speichern, dann neu starten" open it. */
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
  const [error, setError] = useState<string | null>(null);

  async function restart(): Promise<void> {
    setError(null);
    let accepted: RestartAccepted;
    try {
      accepted = await apiRequest<RestartAccepted>(RESTART_PATH, { method: "POST" });
    } catch (refusal) {
      setError(t(restartRefusalKey(refusal instanceof ApiError ? refusal.code : null)));
      throw refusal;
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
      throw new Error("restart not confirmed");
    } catch (failure) {
      // A poll that fails for another reason than "still away" must say so —
      // a 401 after a restart that changed the session secret included.
      if (failure instanceof ApiError)
        setError(
          t(
            failure.status === 401
              ? "settings.restartNow.signInAgain"
              : "settings.restartNow.notConfirmed",
          ),
        );
      throw failure;
    } finally {
      setRestarting(false);
    }
  }

  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.restartNow.title")}
      consequence={
        restarting ? (
          <p role="status" data-testid="settings-restart-progress">
            {t("settings.restartNow.progress")}
          </p>
        ) : (
          <>
            <p>{t("settings.restartNow.consequence")}</p>
            {restartSignsEveryoneOut(pendingFields) ? (
              <p>{t("settings.restartNow.signsOut")}</p>
            ) : null}
          </>
        )
      }
      confirmLabel={t("settings.restartNow.button")}
      onConfirm={restart}
      error={error}
      testId="settings-restart-now-dialog"
    />
  );
}
