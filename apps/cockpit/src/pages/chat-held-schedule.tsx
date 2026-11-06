import type { HeldSchedule } from "@/api/decisions";
import { AutomationGrant } from "@/components/cockpit/automation-grant";
import { Button } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

function heldNeedsRepair(schedule: Pick<HeldSchedule, "admission_hold">): boolean {
  return schedule.admission_hold?.reason_code === "execution_authority_required";
}

export function heldScheduleCopy(schedule: Pick<HeldSchedule, "admission_hold">): {
  title: TranslationKey;
  line: TranslationKey;
} {
  return heldNeedsRepair(schedule)
    ? { title: "chat.schedule.repairTitle", line: "chat.schedule.repairEffect" }
    : { title: "chat.schedule.pending", line: "chat.schedule.effect" };
}

export function HeldScheduleAction({
  schedule,
  conversationId,
  workflowId,
  testId,
  busy,
  onRepair,
  onPrepareSingleRun,
}: {
  schedule: HeldSchedule;
  conversationId?: string;
  workflowId: string;
  testId: string;
  busy: boolean;
  onRepair: () => void;
  onPrepareSingleRun: () => void;
}) {
  const { t } = useI18n();
  if (heldNeedsRepair(schedule))
    return (
      <Button
        type="button"
        size="sm"
        disabled={busy}
        data-testid={`${testId}-repair`}
        onClick={onRepair}
      >
        {t("remedy.chat")}
      </Button>
    );
  return (
    <AutomationGrant
      conversationId={conversationId}
      workflowId={workflowId}
      environment={schedule.execution_mode}
      testId={testId}
      onPrepareSingleRun={onPrepareSingleRun}
      onAdjust={onRepair}
    />
  );
}
