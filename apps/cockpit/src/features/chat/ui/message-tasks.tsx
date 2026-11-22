import { ListChecks } from "lucide-react";
import { absolute, taskHref } from "@/app/links";
import { useI18n } from "@/lib/i18n-context";
import type { MessageTask } from "../model/source-tasks";

export function MessageTasks({ tasks, testId }: { tasks: readonly MessageTask[]; testId: string }) {
  const { t } = useI18n();
  if (tasks.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap justify-end gap-2" data-testid={testId}>
      {tasks.map((task) => (
        <li key={task.id}>
          <a
            href={absolute(taskHref(task.id))}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testId}-${task.id}`}
          >
            <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("chat.sourceTask", { name: task.name })}
          </a>
        </li>
      ))}
    </ul>
  );
}
