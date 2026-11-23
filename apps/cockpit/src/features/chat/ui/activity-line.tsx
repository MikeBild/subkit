import { ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { LiveIndicator } from "@/components/cockpit/live-indicator";
import { useConnectorRecords } from "@/features/connectors";
import { useI18n } from "@/lib/i18n-context";
import { useNow } from "@/lib/use-reduced-motion";
import { activityLine, recentSteps, type TurnActivity } from "../model/activity";
import {
  type ActivityNames,
  activitySentence,
  stepOutcomeKey,
  stepSentence,
} from "../model/activity-labels";

export function ChatActivityLine({
  activity,
  workflowNameFor,
}: {
  activity: TurnActivity;
  workflowNameFor: (slug: string) => string | null;
}) {
  const { t } = useI18n();
  const now = useNow(true);
  const [open, setOpen] = useState(false);
  const historyId = useId();
  const connectors = useConnectorRecords();
  const names = useMemo<ActivityNames>(() => {
    const byId = new Map(
      connectors.map((connector) => [connector.id, connector.display_name] as const),
    );
    return {
      connectorName: (id) => byId.get(id) ?? null,
      workflowName: workflowNameFor,
    };
  }, [connectors, workflowNameFor]);
  const line = activityLine(activity, now);
  const sentence = activitySentence(t, line, names);
  const history = recentSteps(activity);
  return (
    <div className="mb-2 grid gap-1 text-sm text-muted-foreground" data-testid="chat-activity">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <LiveIndicator kind="spinner" testId="chat-activity-indicator" />
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0"
          data-testid="chat-activity-line"
          data-phase={line.now.kind}
          data-retry={line.retry ? line.retry.scope : undefined}
        >
          {sentence}
        </span>
        {line.idleMinutes !== null ? (
          <span className="tabular-nums" data-testid="chat-activity-idle">
            {`· ${t("chat.activity.idle", { minutes: String(line.idleMinutes) })}`}
          </span>
        ) : null}
        {history.length > 0 ? (
          <button
            type="button"
            className="ms-auto inline-flex items-center gap-1 rounded-sm text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={open}
            aria-controls={historyId}
            onClick={() => setOpen((value) => !value)}
            data-testid="chat-activity-history-toggle"
          >
            <ChevronRight
              aria-hidden="true"
              className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            {t("chat.activity.history.toggle")}
          </button>
        ) : null}
      </div>
      {history.length > 0 ? (
        <ol
          id={historyId}
          hidden={!open}
          className="grid gap-0.5 ps-5 text-xs"
          data-testid="chat-activity-history"
        >
          {history.map((step) => (
            <li
              key={step.callId}
              className="flex min-w-0 flex-wrap gap-x-2"
              data-testid="chat-activity-history-step"
              data-outcome={step.ok === false ? "failed" : step.endedAt === null ? "running" : "ok"}
            >
              <span className="min-w-0 truncate">{stepSentence(t, step, names)}</span>
              <span className={step.ok === false ? "text-destructive" : undefined}>
                {t(stepOutcomeKey(step))}
              </span>
              {step.endedAt !== null ? (
                <span className="tabular-nums">
                  {t("overview.recent.duration", {
                    seconds: String(
                      Math.max(0, Math.round((step.endedAt - step.startedAt) / 1000)),
                    ),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
