import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { conversationHref } from "@/app/links";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { continueTaskRunInNewConversation, refreshTask } from "../api/tasks-queries";

export function useNewRunConversation(taskId: string) {
  const { t } = useI18n();
  const client = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (runId: string) => continueTaskRunInNewConversation(runId),
    onSuccess: async (run) => {
      toast.success(t("tasks.newConversation.done"));
      await Promise.all([
        refreshTask(client, taskId),
        client.invalidateQueries({ queryKey: ["attention"] }),
      ]);
      if (run.conversation_id) await navigate({ to: conversationHref(run.conversation_id) });
    },
    onError: (failure) => reportFailure(t("tasks.newConversation.failed"), failure),
  });
}
