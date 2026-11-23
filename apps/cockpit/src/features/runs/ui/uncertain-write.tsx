import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ActionButton, StatusStrip } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { resolveWrite, type WriteOutcome } from "../api/resolve-write";

export function UncertainWrite({
  runId,
  stepKeys,
  canResolve,
}: {
  runId: string;
  stepKeys: readonly string[];
  canResolve: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const resolve = useMutation({
    mutationFn: (input: { step_key: string; outcome: WriteOutcome }) => resolveWrite(runId, input),
    onSuccess: async (_result, input) => {
      toast.success(
        t(
          input.outcome === "arrived"
            ? "runs.uncertain.resolvedArrived"
            : "runs.uncertain.resolvedNotArrived",
        ),
      );
      await client.invalidateQueries({ queryKey: ["runs"] });
      await client.invalidateQueries({ queryKey: ["run", runId] });
    },
    onError: (failure) => reportFailure(t("runs.uncertain.failed"), failure),
  });
  if (stepKeys.length === 0)
    return (
      <StatusStrip
        tone="warn"
        testId="run-detail-uncertain"
        line={<span className="font-medium">{t("runs.uncertain.noStep")}</span>}
      />
    );
  return (
    <div className="flex flex-col gap-2" data-testid="run-detail-uncertain">
      {stepKeys.map((stepKey, index) => {
        const pending = resolve.isPending && resolve.variables?.step_key === stepKey;
        return (
          <StatusStrip
            key={stepKey}
            tone="warn"
            testId={`run-detail-uncertain-${index}`}
            line={
              <span className="flex flex-col gap-1">
                <span className="font-medium">{t("runs.uncertain.title", { step: stepKey })}</span>
                <span className="text-xs text-muted-foreground">{t("runs.uncertain.body")}</span>
              </span>
            }
            action={
              <span className="flex flex-wrap items-center gap-2">
                <ActionButton
                  size="sm"
                  disabled={!canResolve || resolve.isPending}
                  disabledReason={canResolve ? undefined : t("runs.uncertain.notAllowed")}
                  pending={pending && resolve.variables?.outcome === "arrived"}
                  onClick={() => resolve.mutate({ step_key: stepKey, outcome: "arrived" })}
                  testId={`run-detail-uncertain-${index}-arrived`}
                >
                  {t("runs.uncertain.arrived")}
                </ActionButton>
                <ActionButton
                  size="sm"
                  disabled={!canResolve || resolve.isPending}
                  disabledReason={canResolve ? undefined : t("runs.uncertain.notAllowed")}
                  pending={pending && resolve.variables?.outcome === "not_arrived"}
                  onClick={() => resolve.mutate({ step_key: stepKey, outcome: "not_arrived" })}
                  testId={`run-detail-uncertain-${index}-not-arrived`}
                >
                  {t("runs.uncertain.notArrived")}
                </ActionButton>
              </span>
            }
          />
        );
      })}
    </div>
  );
}
