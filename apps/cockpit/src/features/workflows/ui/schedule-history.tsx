import { Section } from "@/components/cockpit/patterns";
import { ScheduleHistory as OccurrenceHistory } from "@/features/operations";
import { useOpenRunSheet } from "@/features/workflows/hooks/run-sheet";
import { useI18n } from "@/lib/i18n-context";

export function ScheduleHistory({
  subject,
  scheduled = true,
  onOpenRun,
}: {
  subject: { kind: "workflow" | "task"; id: string };
  scheduled?: boolean;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  const sheets = useOpenRunSheet();
  return (
    <Section label={t("scheduleHistory.title")} testId="schedule-history">
      <OccurrenceHistory
        subject={subject}
        scheduled={scheduled}
        onOpenRun={onOpenRun ?? (subject.kind === "workflow" ? (id) => sheets.run(id) : undefined)}
      />
    </Section>
  );
}
