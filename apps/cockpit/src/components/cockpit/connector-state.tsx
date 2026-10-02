import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Power } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { Button } from "@/components/ui/button";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { ConnectorNotice } from "@/pages/connector-detail-model";

const TITLES: Record<Exclude<ConnectorNotice, null>, TranslationKey> = {
  signed_in: "connectorState.signedIn",
  signed_in_off: "connectorState.signedInOff",
  off: "connectorState.off",
};

/**
 * The connector's one statement above its sections: that a sign-in just came
 * back, that the connector is switched off, or both — and, for a switched-off
 * connector, the one act that changes it.
 *
 * Switching on is its own decision: signing in never does it. So the page
 * says "signed in, but switched off" and offers "Einschalten" here, once. The
 * new state is shown at once — the engine's answer is the connector as it now
 * stands, and it replaces the page's copy of it.
 */
export function ConnectorStateNotice({
  connectorId,
  notice,
  canWrite,
  primary,
}: {
  connectorId: string;
  notice: Exclude<ConnectorNotice, null>;
  canWrite: boolean;
  /** Whether "Einschalten" is the page's filled action. It is not while the
   *  sign-in card offers a renewal: a page has one filled action. */
  primary: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const enable = useMutation({
    mutationFn: () =>
      apiRequest<Record<string, unknown>>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/enable`,
        { method: "POST" },
      ),
    onSuccess: (connector) => {
      client.setQueryData(["catalog-detail", "connectors", connectorId], connector);
      toast.success(t("connectorState.enabled"));
    },
    onError: () => toast.error(t("connectorState.enableFailed")),
  });
  const off = notice !== "signed_in";
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3"
      role="status"
      data-testid="connector-state-notice"
      data-notice={notice}
    >
      <div className="grid min-w-0 gap-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          {off ? (
            <Power className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          )}
          {t(TITLES[notice])}
        </p>
        {off ? (
          <p className="text-sm text-muted-foreground">{t("connectorState.offBody")}</p>
        ) : null}
      </div>
      {off && canWrite ? (
        <Button
          variant={primary ? "default" : "outline"}
          disabled={enable.isPending}
          onClick={() => enable.mutate()}
          data-testid="connector-enable"
        >
          {t("connectorState.enable")}
        </Button>
      ) : null}
    </div>
  );
}
