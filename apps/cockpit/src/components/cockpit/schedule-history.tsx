import { Section } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { ScheduleHistory as OccurrenceHistory } from "@/features/operations";
import { useI18n } from "@/lib/i18n-context";

export function ScheduleHistory({
  subject,
  scheduled = true,
}: {
  subject: { kind: "workflow" | "task"; id: string };
  scheduled?: boolean;
}) {
  const { t } = useI18n();
  const sheets = useOpenRunSheet();
  return (
    <Section label={t("scheduleHistory.title")} testId="schedule-history">
      <OccurrenceHistory
        subject={subject}
        scheduled={scheduled}
        onOpenRun={subject.kind === "workflow" ? (id) => sheets.run(id) : undefined}
      />
    </Section>
  );
}
