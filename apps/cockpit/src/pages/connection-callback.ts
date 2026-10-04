import { useEffect } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n-context";
import {
  connectionFailureKey,
  readCallbackOutcome,
  withoutCallbackParams,
} from "@/pages/connections-model";

export function useConnectionCallback(enabled: boolean): void {
  const { t } = useI18n();
  useEffect(() => {
    if (!enabled) return;
    const outcome = readCallbackOutcome(window.location.search);
    if (!outcome) return;
    if (outcome.kind === "connected")
      toast.success(
        t(outcome.renewed ? "connections.renewed" : "connections.connected", {
          name: outcome.name,
        }),
      );
    else
      toast.error(
        outcome.name
          ? t("connections.failedTitleNamed", { name: outcome.name })
          : t("connections.failedTitle"),
        { description: t(connectionFailureKey(outcome.code)) },
      );
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${withoutCallbackParams(window.location.search)}`,
    );
  }, [enabled, t]);
}
