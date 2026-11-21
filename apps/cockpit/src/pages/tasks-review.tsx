import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { IconTile } from "@ui/components/proto/visual";
import { Check, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { absolute, conversationHref } from "@/app/links";
import { Button, useErrorNotice } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { resultErrorKey, type Task, type TaskRun } from "@/pages/tasks-model";
import { completeTaskRun, refreshTask, rejectTaskRun } from "@/pages/tasks-queries";
import type { StepResult } from "@/pages/tasks-steps";

export function TaskReviewSection({
  task,
  run,
  results,
  canOpen,
}: {
  task: Pick<Task, "id" | "name">;
  run: Pick<TaskRun, "id" | "conversation_id">;
  results: readonly StepResult[];
  canOpen: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: "accept" | "reject") =>
      decision === "accept" ? completeTaskRun(run.id) : rejectTaskRun(run.id),
    onSuccess: async (_run, decision) => {
      toast.success(
        t(decision === "accept" ? "tasks.review.accepted" : "tasks.review.rejected", {
          name: task.name,
        }),
      );
      await refreshTask(client, task.id);
    },
    onError: async () => {
      await refreshTask(client, task.id);
    },
  });
  const failure = useErrorNotice({ error: decide.error });
  return (
    <section
      className="rounded-xl border border-accent/40 bg-accent/5 p-6"
      data-testid="task-review-section"
    >
      <div className="flex items-center gap-3">
        <IconTile icon={ListChecks} tone="info" size="md" />
        <p className="font-semibold">{t("tasks.review.title")}</p>
      </div>
      {results.length > 0 ? (
        <ul className="my-3 grid gap-2 text-sm" data-testid="task-review-section-results">
          {results.map((result) => (
            <li key={result.id} className="grid gap-0.5">
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {result.label}
              </span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{result.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="my-3 text-sm">{t("tasks.review.line")}</p>
      )}
      {decide.isError ? (
        <ErrorNotice
          {...failure}
          title={t(resultErrorKey(decide.error instanceof ApiError ? decide.error.code : null))}
          testId="task-review-section-error"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          pending={decide.isPending && decide.variables === "accept"}
          disabled={decide.isPending}
          onClick={() => decide.mutate("accept")}
          data-testid="task-review-section-accept"
        >
          <Check aria-hidden="true" />
          {t("tasks.review.accept")}
        </Button>
        <Button
          variant="outline"
          pending={decide.isPending && decide.variables === "reject"}
          disabled={decide.isPending}
          onClick={() => decide.mutate("reject")}
          data-testid="task-review-section-reject"
        >
          {t("tasks.review.reject")}
        </Button>
        {run.conversation_id && canOpen ? (
          <Button asChild variant="ghost">
            <a
              href={absolute(conversationHref(run.conversation_id))}
              data-testid="task-review-section-open"
            >
              {t("tasks.review.open")}
            </a>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
