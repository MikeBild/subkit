import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { refusalReasonLabel } from "@/lib/refusal-reason";

export function RefusalReasonLine({
  reason,
  testId,
  className = "block",
}: {
  reason: string | null | undefined;
  testId: string;
  className?: string;
}) {
  const { t } = useI18n();
  const label = refusalReasonLabel(reason, t);
  if (!label) return null;
  return (
    <span className={className} data-testid={testId} data-reason={reason ?? undefined}>
      {label.machine ? (
        <LabelText label={label} />
      ) : (
        t("refusal.reason.sentence", { reason: label.text })
      )}
    </span>
  );
}
