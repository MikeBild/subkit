import { Pill } from "@ui/components/proto/Pill";
import { MiniBars } from "@ui/components/proto/visual";
import { useI18n } from "@/lib/i18n-context";
import { operatingTone } from "./model";

export function DurationBars({ data }: { data: number[] }) {
  const { t } = useI18n();
  if (data.length < 2) return null;
  return (
    <div data-testid="run-duration-bars">
      <p className="mb-2 text-xs text-muted-foreground">{t("ops.durations")}</p>
      <MiniBars className="mb-3" label={t("ops.durations")} data={data} />
    </div>
  );
}

export function WorkflowStatusPill({
  status,
  label,
  testId,
}: {
  status: string;
  label: string;
  testId?: string;
}) {
  return (
    <span data-testid={testId} data-status={status}>
      <Pill tone={operatingTone(status)}>{label}</Pill>
    </span>
  );
}
