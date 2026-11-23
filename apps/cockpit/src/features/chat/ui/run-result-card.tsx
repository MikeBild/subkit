import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { contextualHref } from "@/app/installation-context";
import { absolute, runHref } from "@/app/links";
import { formatRunDuration, RunRecordsCard, runDurationMs } from "@/features/runs";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

export function ChatRunResultView({
  executionId,
  detail,
  testId,
}: {
  executionId: string;
  detail: unknown;
  testId: string;
}) {
  const { t, locale } = useI18n();
  if (detail === null || typeof detail !== "object") return null;
  const run = detail as {
    status?: unknown;
    started_at?: string | null;
    finished_at?: string | null;
  };
  const ms = runDurationMs({
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
  });
  return (
    <RunRecordsCard
      detail={detail}
      title={statusLabel(t, typeof run.status === "string" ? run.status : "unknown")}
      duration={ms === null ? null : formatRunDuration(locale, ms)}
      details={
        <a
          className="text-sm underline underline-offset-4"
          href={contextualHref(absolute(runHref(executionId)))}
          data-testid={`${testId}-run`}
        >
          {t("chat.liveTest.openRun")}
        </a>
      }
      testId={testId}
    />
  );
}

export function ChatRunResultCard({
  executionId,
  testId,
}: {
  executionId: string;
  testId: string;
}) {
  const detail = useQuery({
    queryKey: ["run", executionId],
    queryFn: () => apiCall("get", "/v1/executions/{id}", { path: { id: executionId } }),
  });
  if (!detail.data) return null;
  return <ChatRunResultView executionId={executionId} detail={detail.data} testId={testId} />;
}
