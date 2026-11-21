import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ActionButton, ConfirmDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

export function isStoppableRun(status: string): boolean {
  return status === "running" || status === "queued";
}

export function StopRunAction({ runId, workflowName }: { runId: string; workflowName: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const stop = useMutation({
    mutationFn: () => apiCall("post", "/v1/executions/{id}/cancel", { path: { id: runId } }),
    onSuccess: async () => {
      toast.success(t("runs.stop.requested"));
      setOpen(false);
      await client.invalidateQueries({ queryKey: ["runs"] });
      await client.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
  return (
    <>
      <ActionButton
        variant="destructive"
        onClick={() => {
          stop.reset();
          setOpen(true);
        }}
        testId="run-stop-open"
      >
        {t("runs.stop.open")}
      </ActionButton>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        object={t("runs.stop.object", { workflow: workflowName })}
        verb={t("runs.stop.verb")}
        consequence={t(stop.error ? "runs.stop.failed" : "runs.stop.consequence")}
        confirmLabel={t("runs.stop.confirm")}
        destructive
        pending={stop.isPending}
        onConfirm={async () => {
          await stop.mutateAsync().catch(() => undefined);
        }}
        testId="run-stop-confirm"
      />
    </>
  );
}
